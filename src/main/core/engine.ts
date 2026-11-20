/**
 * 引擎：编排 provider、下载器、存储与系统变更。
 *
 * 职责边界：provider 负责语言差异，下载器负责字节传输，本模块只负责流程。
 * 所有对外的 IPC 行为最终都落到这里，便于单独测试与替换界面。
 */
import { join } from 'node:path'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type {
  AppStateData,
  SystemMutation,
  BootstrapPayload,
  HealthCheckItem,
  LocalToolVersions,
  Manifest,
  ProgressEvent,
  ToolId,
  ToolSummary,
  UpdateManifest,
  UpdateState,
  VersionInfo
} from '@shared/domain'
import { createProviders, allToolMetadata } from '@main/providers/registry'
import { ComposerProvider } from '@main/providers/composer'
import { removeVersionDir } from '@main/providers/runtime'
import { currentBinRelative, writeActivationScripts, writeCurrentShims, type ActiveTool } from './activations'
import { cachedFile, downloadAndVerify } from './downloader'
import { addPathEntry, hasPathEntry, removePathEntry, rollbackMutation } from './system'
import { createLayout, npmGlobalDir, normalizeNpmGlobalDir, type Layout } from './paths'
import { setProxyProvider, testProxyConnection } from './net'
import type { ProxyTestResult } from '@shared/ipc'
import { Store } from './store'
import { Updater } from './updater'

export class Engine {
  private readonly updater: Updater

  constructor(
    private layout: Layout,
    private readonly store: Store,
    private readonly emitProgress: (event: ProgressEvent) => void,
    options?: { appVersion: string; emitUpdate: (state: UpdateState) => void; restart: () => void }
  ) {
    this.updater = new Updater({
      layout,
      store,
      appVersion: options?.appVersion ?? '0.1.0',
      emit: options?.emitUpdate ?? (() => undefined),
      restart: options?.restart ?? (() => undefined)
    })
  }

  async init(): Promise<void> {
    await this.store.init()
    // 网络层按需读取实时配置，配置变更无需重新注入；此处只建立一次性绑定
    setProxyProvider(() => this.store.getState().config.proxy)
    await this.ensureNpmGlobalDirs(this.store.getState().config.npmGlobalDir)
    await this.refreshActivationArtifacts()
    await this.updater.init()
    await this.updater.confirmOnStartup()
  }

  /** 由配置的相对路径得到 npm 全局前缀的绝对路径 */
  private npmGlobalEntry(): string {
    return npmGlobalDir(this.layout.root, this.store.getState().config.npmGlobalDir)
  }

  /** 预先创建全局前缀与缓存目录，避免首次 npm i -g 时落回默认位置 */
  private async ensureNpmGlobalDirs(configured: string): Promise<void> {
    const prefix = npmGlobalDir(this.layout.root, configured)
    await mkdir(prefix, { recursive: true })
    await mkdir(join(prefix, 'cache'), { recursive: true })
  }

  /** 用给定代理实测官方列表接口；地址非法或不可达时抛错由界面提示 */
  async checkProxy(url: string, enabled: boolean): Promise<ProxyTestResult> {
    return testProxyConnection({ enabled, url })
  }

  async checkUpdate(): Promise<UpdateManifest | null> {
    return this.updater.check()
  }

  /** 完整升级：下载校验 → 解压准备 → 写挂起状态 → 进程外替换 → 退出 */
  async upgrade(): Promise<UpdateState> {
    await this.updater.prepare()
    return this.updater.apply()
  }

  /** 清除升级历史归档、升级包缓存与暂存残留 */
  async clearUpdateResidue(): Promise<import('@shared/domain').ClearResidueResult> {
    return this.updater.clearUpdateResidue()
  }

  getUpdateState(): UpdateState {
    return this.updater.state()
  }

  /** provider 按当前配置构造，镜像变更实时生效 */
  private providers() {
    return createProviders(this.store.getState().config)
  }

  private async requireProvider(toolId: ToolId) {
    const provider = this.providers().get(toolId)
    if (!provider) throw new Error(`${toolId} 尚未接入 provider`)
    return provider
  }

  async bootstrap(): Promise<BootstrapPayload> {
    const [tools, health] = await Promise.all([this.toolsSummary(), this.healthCheck()])
    return {
      state: this.store.getState(),
      manifest: this.store.getManifest(),
      tools,
      health,
      platform: process.platform,
      arch: process.arch
    }
  }

  async listVersions(toolId: ToolId): Promise<VersionInfo[]> {
    const provider = await this.requireProvider(toolId)
    return provider.listVersions()
  }

  /** 汇总工具卡片：已安装版本来自磁盘扫描，远程数量来自 provider */
  async toolsSummary(): Promise<ToolSummary[]> {
    const state = this.store.getState()
    const providers = this.providers()
    const result = await Promise.all(
      allToolMetadata(state.config).map(async (meta) => {
        const provider = providers.get(meta.id)
        let installed: ToolSummary['installed'] = []
        let remoteCount = 0
        if (provider) {
          installed = await provider.detectInstalled(this.layout.root)
          try {
            remoteCount = (await provider.listVersions()).length
          } catch {
            remoteCount = installed.length
          }
        }
        return {
          id: meta.id,
          displayName: provider?.displayName ?? meta.displayName,
          accent: meta.accent,
          installed,
          activeVersionId: state.activeVersions[meta.id] ?? null,
          remoteCount
        }
      })
    )
    return result
  }

  /**
   * 安装指定版本。
   *
   * Java 安装成功后自动附带一个 Maven：Maven 是 Java 项目的事实构建工具，
   * 单独留出一步让用户再装不符合「装好 Java 即可开发」的预期。PHP 同理附带
   * Composer，且按其最低 PHP 版本要求挑选兼容的版本。附带安装只在尚未安装
   * 任何对应工具时发生，失败只告警、不回滚已完成的语言安装。
   */
  async install(toolId: ToolId, versionId: string): Promise<void> {
    await this.installVersion(toolId, versionId)
    if (toolId === 'java') await this.ensureMavenInstalled()
    if (toolId === 'php') await this.ensureComposerInstalled(versionId)
  }

  /** 下载、校验并解压单个版本，进度事件直接使用工具与版本标识 */
  private async installVersion(toolId: ToolId, versionId: string): Promise<void> {
    const provider = await this.requireProvider(toolId)
    const emit = this.emitProgress

    emit({ toolId, versionId, phase: 'resolving', percent: 1, message: '解析版本信息' })
    const versions = await provider.listVersions()
    const version = versions.find((item) => item.id === versionId)
    if (!version) throw new Error(`未找到版本 ${versionId}`)

    emit({ toolId, versionId, phase: 'resolving', percent: 5, message: '解析下载地址' })
    const plan = await provider.resolveDownload(version)
    const cacheFile = join(this.layout.downloadsDir, plan.fileName)

    let archived = await cachedFile(cacheFile)
    if (!archived) {
      const result = await downloadAndVerify({
        toolId,
        versionId,
        destFile: cacheFile,
        plan,
        onProgress: emit
      })
      archived = result.file
    } else {
      emit({ toolId, versionId, phase: 'downloading', percent: 100, message: '使用下载缓存' })
    }

    emit({ toolId, versionId, phase: 'extracting', percent: 99, message: '解压安装' })
    await provider.install(version, archived, join(this.layout.runtimesDir, toolId, versionId))

    emit({ toolId, versionId, phase: 'done', percent: 100, message: '安装完成' })
  }

  /**
   * 确保存在一个可用的 Maven 版本。
   * 已装任意版本时跳过；否则取官方列表里最新的稳定版安装，并设为全局激活，
   * 使 Java 装完后 mvn 命令立即可用。失败只记录警告，不影响 Java 安装结果。
   */
  private async ensureMavenInstalled(): Promise<void> {
    const emit = this.emitProgress
    try {
      const installed = await this.detectTool('maven')
      if (installed.length > 0) return

      const versions = await this.listVersions('maven')
      const stable = versions.find((item) => item.channel === 'stable')
      if (!stable) throw new Error('官方源暂无稳定版 Maven')

      await this.installVersion('maven', stable.id)
      await this.store.updateState((draft) => {
        draft.activeVersions.maven = stable.id
      })
      emit({
        toolId: 'maven',
        versionId: stable.id,
        phase: 'done',
        percent: 100,
        message: `已附带安装 Maven ${stable.display}`
      })
    } catch (error) {
      console.warn('[envdock] 附带安装 Maven 失败', error)
      emit({
        toolId: 'maven',
        versionId: '',
        phase: 'error',
        percent: -1,
        message: error instanceof Error ? error.message : '附带安装 Maven 失败'
      })
    }
  }

  /**
   * 确保存在一个与当前 PHP 兼容的 Composer。
   *
   * Composer 按 PHP 附属工具管理：已装任意版本时跳过；否则从官方列表取满足
   * 该 PHP 最低版本要求的最新版安装并激活。其 launcher 通过 PATH 里的 php
   * 执行，因此切换 PHP 后 composer 命令自动跟随，无需重新附带。
   */
  private async ensureComposerInstalled(phpVersionId: string): Promise<void> {
    const emit = this.emitProgress
    try {
      const installed = await this.detectTool('composer')
      if (installed.length > 0) return

      const provider = this.providers().get('composer')
      if (!(provider instanceof ComposerProvider)) throw new Error('Composer provider 未注册')

      const version = await provider.resolveForPhp(phpVersionId)
      if (!version) throw new Error('官方源暂无兼容当前 PHP 的 Composer 版本')

      await this.installVersion('composer', version.id)
      await this.store.updateState((draft) => {
        draft.activeVersions.composer = version.id
      })
      emit({
        toolId: 'composer',
        versionId: version.id,
        phase: 'done',
        percent: 100,
        message: `已附带安装 Composer ${version.display}`
      })
    } catch (error) {
      console.warn('[envdock] 附带安装 Composer 失败', error)
      emit({
        toolId: 'composer',
        versionId: '',
        phase: 'error',
        percent: -1,
        message: error instanceof Error ? error.message : '附带安装 Composer 失败'
      })
    }
  }

  async activate(toolId: ToolId, versionId: string): Promise<void> {
    await this.requireProvider(toolId)
    const installed = await this.detectTool(toolId)
    if (!installed.some((item) => item.versionId === versionId)) {
      throw new Error(`${toolId} ${versionId} 尚未安装`)
    }

    await this.store.updateState((draft) => {
      draft.activeVersions[toolId] = versionId
    })
    await this.refreshActivationArtifacts()
  }

  async deactivate(toolId: ToolId): Promise<void> {
    await this.store.updateState((draft) => {
      delete draft.activeVersions[toolId]
    })
    await this.refreshActivationArtifacts()
  }

  async uninstallVersion(toolId: ToolId, versionId: string): Promise<void> {
    await this.requireProvider(toolId)
    const state = this.store.getState()
    if (state.activeVersions[toolId] === versionId) {
      throw new Error('该版本正在激活，请先切换版本')
    }
    await removeVersionDir(this.layout.root, toolId, versionId)
  }

  private async detectTool(toolId: ToolId) {
    const provider = await this.requireProvider(toolId)
    return provider.detectInstalled(this.layout.root)
  }

  /**
   * 本地已装版本快照，供系统托盘菜单使用。
   * 只扫描磁盘，不请求任何官方接口，避免托盘每次弹出都触发网络。
   */
  async localVersions(): Promise<LocalToolVersions[]> {
    const state = this.store.getState()
    return Promise.all(
      allToolMetadata(state.config).map(async (meta) => ({
        id: meta.id,
        displayName: meta.displayName,
        installed: (await this.detectTool(meta.id)).map((item) => item.versionId),
        active: state.activeVersions[meta.id] ?? null
      }))
    )
  }

  /**
   * 根据当前全局激活版本重建脚本与垫片。
   *
   * 所有工具的环境变量先聚合再写入每个垫片：Maven 的 mvn.cmd 依赖 JAVA_HOME，
   * 而各工具的变量键互不重叠，合并后任一命令都能拿到完整的运行时环境。
   */
  private async refreshActivationArtifacts(): Promise<void> {
    const state = this.store.getState()
    const providers = this.providers()
    const active: ActiveTool[] = []

    for (const [toolId, versionId] of Object.entries(state.activeVersions)) {
      const provider = providers.get(toolId as ToolId)
      if (!provider || !versionId) continue
      const version: VersionInfo = {
        id: versionId,
        display: versionId,
        channel: 'stable',
        releasedAt: ''
      }
      const plan = provider.activate(version)
      active.push({
        toolId: toolId as ToolId,
        relativeBinDir: plan.pathEntries[0].replace(/\\/g, '/'),
        envVars: plan.envVars
      })
    }

    const mergedEnv: Record<string, string> = {}
    for (const item of active) Object.assign(mergedEnv, item.envVars)
    for (const item of active) item.envVars = { ...mergedEnv }

    await Promise.all([
      writeActivationScripts(this.layout, active),
      writeCurrentShims(this.layout, active)
    ])
  }

  async setConfig(patch: Partial<AppStateData['config']>): Promise<AppStateData> {
    if (patch.npmGlobalDir !== undefined) {
      // 非法目录在此抛错，由界面提示；不把脏路径写进状态
      patch = { ...patch, npmGlobalDir: normalizeNpmGlobalDir(patch.npmGlobalDir) }
    }
    const previousDir = this.store.getState().config.npmGlobalDir
    const state = await this.store.updateState((draft) => {
      draft.config = { ...draft.config, ...patch }
    })

    if (patch.npmGlobalDir !== undefined && patch.npmGlobalDir !== previousDir) {
      const oldEntry = npmGlobalDir(this.layout.root, previousDir)
      const newEntry = npmGlobalDir(this.layout.root, patch.npmGlobalDir)
      await this.ensureNpmGlobalDirs(patch.npmGlobalDir)
      if (state.config.pathIntegration && !(await hasPathEntry(newEntry))) {
        // 旧条目留着不影响功能，但会占 PATH；移除后再写新条目，各自独立可回滚
        await removePathEntry(oldEntry)
        const mutation = await addPathEntry(newEntry)
        if (mutation) {
          await this.store.updateManifest((draft) => {
            draft.mutations.push(mutation)
          })
        }
      }
      // npm_config_prefix 注入在激活计划里，改目录后必须重建垫片与脚本
      await this.refreshActivationArtifacts()
    }
    return state
  }

  /** PATH 集成开关：写入或移除 current/bin 与 npm 全局目录，并记录可回滚变更 */
  async setPathIntegration(enabled: boolean): Promise<Manifest> {
    const binEntry = join(this.layout.root, currentBinRelative())
    const npmEntry = this.npmGlobalEntry()
    if (enabled) {
      const mutations: SystemMutation[] = []
      for (const entry of [binEntry, npmEntry]) {
        const mutation = await addPathEntry(entry)
        if (mutation) mutations.push(mutation)
      }
      if (mutations.length > 0) {
        return this.store.updateManifest((draft) => {
          draft.mutations.push(...mutations)
        })
      }
    } else {
      for (const entry of [binEntry, npmEntry]) {
        await removePathEntry(entry)
      }
      // 清单保留历史记录，卸载时统一按原值回滚
    }
    return this.store.getManifest()
  }

  async isPathIntegrated(): Promise<boolean> {
    return hasPathEntry(join(this.layout.root, currentBinRelative()))
  }

  /** 回滚全部系统变更，用于卸载 */
  async rollbackAll(): Promise<void> {
    const manifest = this.store.getManifest()
    for (const mutation of [...manifest.mutations].reverse()) {
      try {
        await rollbackMutation(mutation)
      } catch (error) {
        console.warn('[envdock] 回滚失败', mutation.id, error)
      }
    }
    await this.store.updateManifest((draft) => {
      draft.mutations = []
    })
  }

  /** 目录迁移：先撤销旧路径的 PATH 引用，再把根目录内容复制到新位置 */
  async relocate(targetRoot: string): Promise<Manifest> {
    const oldRoot = this.layout.root
    if (oldRoot === targetRoot) throw new Error('目标目录与当前目录相同')

    const oldBinEntry = join(oldRoot, currentBinRelative())
    const oldNpmEntry = npmGlobalDir(oldRoot, this.store.getState().config.npmGlobalDir)
    for (const entry of [oldBinEntry, oldNpmEntry]) {
      if (await hasPathEntry(entry)) await removePathEntry(entry)
    }

    await mkdir(targetRoot, { recursive: true })
    // npm 全局目录的首段可能是自定义名称，按配置推导后并入固定清单一起迁移
    const npmTop = normalizeNpmGlobalDir(this.store.getState().config.npmGlobalDir).split('/')[0]
    const moveNames = ['runtimes', 'cache', 'scripts', 'current', 'state.json', 'manifest.json']
    if (!moveNames.includes(npmTop)) moveNames.push(npmTop)
    for (const name of moveNames) {
      const from = join(oldRoot, name)
      const to = join(targetRoot, name)
      await rm(to, { recursive: true, force: true })
      // 首次迁移或用户尚未触发 npm 时目录可能不存在，跳过而不是中断整个迁移
      if (!(await stat(from).then(() => true, () => false))) continue
      await rename(from, to)
    }

    const newLayout = createLayout(targetRoot)
    await this.store.adoptLayout(newLayout)
    this.layout = newLayout

    // 清单里的路径是迁移前写入的，按新根目录重写后落盘
    const manifest = await this.store.updateManifest((draft) => {
      draft.installRoot = targetRoot
      draft.mutations = draft.mutations.map((mutation) => ({
        ...mutation,
        previousValue: mutation.previousValue?.split(oldRoot).join(targetRoot) ?? null,
        currentValue: mutation.currentValue.split(oldRoot).join(targetRoot)
      }))
    })

    // 若此前开启了 PATH 集成，撤销旧条目并在新位置重新写入
    if (this.store.getState().config.pathIntegration) {
      await addPathEntry(join(targetRoot, currentBinRelative()))
      await addPathEntry(npmGlobalDir(targetRoot, this.store.getState().config.npmGlobalDir))
    }
    return manifest
  }

  /** 环境体检：基于真实磁盘与注册表状态 */
  async healthCheck(): Promise<HealthCheckItem[]> {
    const state = this.store.getState()
    const manifest = this.store.getManifest()
    const items: HealthCheckItem[] = []

    items.push({
      id: 'root',
      title: '安装目录',
      status: 'ok',
      detail: `${this.layout.root} 可读写`
    })
    items.push({
      id: 'manifest',
      title: '系统变更清单',
      status: 'ok',
      detail: `已记录 ${manifest.mutations.length} 项系统变更，均可回滚`
    })

    const integrated = await hasPathEntry(join(this.layout.root, currentBinRelative()))
    const wantsIntegration = state.config.pathIntegration
    items.push({
      id: 'path-order',
      title: 'PATH 优先级',
      status: integrated === wantsIntegration ? 'ok' : 'warning',
      detail: integrated
        ? 'EnvDock 条目已加入用户级 PATH，优先于后续系统条目'
        : wantsIntegration
          ? '已开启 PATH 集成，但条目缺失，请重新开启'
          : '未集成 PATH，使用激活脚本或 IDE 配置解释器路径'
    })

    const npmPrefix = this.npmGlobalEntry()
    const npmReady = await stat(npmPrefix).then(() => true, () => false)
    items.push({
      id: 'npm-global',
      title: 'npm 全局目录',
      status: npmReady ? 'ok' : 'warning',
      detail: npmReady ? npmPrefix : `${npmPrefix} 尚未创建，首次启动会重建`
    })

    return items
  }

  getState(): AppStateData {
    return this.store.getState()
  }

  getManifest(): Manifest {
    return this.store.getManifest()
  }

  getLayout(): Layout {
    return this.layout
  }
}

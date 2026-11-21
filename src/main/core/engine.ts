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
import { detectInstalled, removeVersionDir } from '@main/providers/runtime'
import { writeActivationScripts } from './activations'
import {
  computeEnvPlan,
  envVarNamesForTool,
  fixedVariables,
  MANAGED_FLAG,
  pathRefsForTool
} from './env'
import { cachedFile, downloadAndVerify } from './downloader'
import {
  addPathEntry,
  hasPathEntry,
  putEnvVar,
  readEnvVar,
  removePathEntry,
  rollbackMutation
} from './system'
import { createLayout, type Layout } from './paths'
import { ensureGlobalBuckets, pruneGlobalBuckets } from './npm-globals'
import { setProxyProvider, testProxyConnection } from './net'
import type { ProxyTestResult } from '@shared/ipc'
import { Store } from './store'
import { Updater } from './updater'

export class Engine {
  private readonly updater: Updater
  private readonly emitStateChanged: () => void

  constructor(
    private layout: Layout,
    private readonly store: Store,
    private readonly emitProgress: (event: ProgressEvent) => void,
    options?: {
      appVersion: string
      emitUpdate: (state: UpdateState) => void
      restart: () => void
      emitStateChanged?: () => void
    }
  ) {
    this.emitStateChanged = options?.emitStateChanged ?? (() => undefined)
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
    // 从垫片方案升级上来的安装会残留两条旧 PATH 条目；它们指向已不再生成的目录，
    // 只按字面量移除，不碰用户的其他条目。
    for (const legacy of [
      join(this.layout.root, 'current', 'bin'),
      join(this.layout.root, 'global', 'npm')
    ]) {
      if (await hasPathEntry(legacy)) await removePathEntry(legacy)
    }
    await ensureGlobalBuckets(this.layout.root, this.store.getState().activeVersions)
    // 每次启动按当前激活版本对齐环境变量：切换过版本、或在外部改动过注册表后，
    // 都能在这里修正回 EnvDock 应有的状态。未开启集成时只重算进程内激活脚本。
    if (this.store.getState().config.pathIntegration) await this.syncEnvironment()
    await this.refreshActivationArtifacts()
    await this.updater.init()
    await this.updater.confirmOnStartup()
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
    await ensureGlobalBuckets(this.layout.root, this.store.getState().activeVersions)
    if (this.store.getState().config.pathIntegration) await this.syncEnvironment()
    await this.refreshActivationArtifacts()
    this.emitStateChanged()
  }

  async deactivate(toolId: ToolId): Promise<void> {
    await this.store.updateState((draft) => {
      delete draft.activeVersions[toolId]
    })
    // 取消激活时显式撤销该工具的变量与 PATH 引用，不留给 syncEnvironment——
    // 后者只负责写入当前激活项，不处理已被移除的工具。
    await this.removeToolEnvironment(toolId)
    if (this.store.getState().config.pathIntegration) await this.syncEnvironment()
    await this.refreshActivationArtifacts()
    this.emitStateChanged()
  }

  /**
   * 撤销某个工具的名字相关变量引用，用于取消激活。
   *
   * 只删除清单中登记的、当前仍由 EnvDock 持有的项；PATH 引用按字面量移除。
   */
  private async removeToolEnvironment(toolId: ToolId): Promise<void> {
    const names = new Set(envVarNamesForTool(toolId))
    const refs = new Set(pathRefsForTool(toolId))
    const manifest = this.store.getManifest()
    const keep: SystemMutation[] = []
    for (const mutation of manifest.mutations) {
      const own = mutation.ownership
      if (own?.kind === 'env-var' && names.has(own.name)) {
        await rollbackMutation(mutation)
        continue
      }
      if (own?.kind === 'path-entry' && refs.has(own.entry)) {
        await rollbackMutation(mutation)
        continue
      }
      keep.push(mutation)
    }
    if (keep.length !== manifest.mutations.length) {
      await this.store.updateManifest((draft) => {
        draft.mutations = keep
      })
    }
  }

  async uninstallVersion(toolId: ToolId, versionId: string): Promise<void> {
    await this.requireProvider(toolId)
    const state = this.store.getState()
    if (state.activeVersions[toolId] === versionId) {
      throw new Error('该版本正在激活，请先切换版本')
    }
    await removeVersionDir(this.layout.root, toolId, versionId)
    if (toolId === 'node' || toolId === 'python') {
      // 全局包按主版本隔离：删掉最后一个该主版本时清掉对应 bucket
      const remaining = await detectInstalled(this.layout.root, toolId)
      await pruneGlobalBuckets(this.layout.root, {
        node: toolId === 'node' ? remaining.map((item) => item.versionId) : undefined,
        python: toolId === 'python' ? remaining.map((item) => item.versionId) : undefined
      })
    }
    this.emitStateChanged()
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

  /** 根据当前激活版本重建进程内激活脚本；注册表集成由 syncEnvironment 单独负责 */
  private async refreshActivationArtifacts(): Promise<void> {
    await writeActivationScripts(this.layout, this.store.getState().activeVersions)
  }

  async setConfig(patch: Partial<AppStateData['config']>): Promise<AppStateData> {
    return this.store.updateState((draft) => {
      draft.config = { ...draft.config, ...patch }
    })
  }

  /**
   * 把当前激活版本对应的 HOME 变量与 PATH 引用写入注册表。
   *
   * 变量值变化时更新清单里的对应记录；PATH 引用只在缺失时新增。全程只登记
   * EnvDock 自己写出的目标，取消集成与卸载据此精确撤销。
   */
  private async syncEnvironment(): Promise<void> {
    const state = this.store.getState()
    const plan = computeEnvPlan(this.layout.root, state.activeVersions)
    const variables = [...plan.variables, ...fixedVariables()]
    const manifest = this.store.getManifest()
    const pending: SystemMutation[] = []

    for (const item of variables) {
      const existing = manifest.mutations.find(
        (entry) => entry.ownership?.kind === 'env-var' && entry.ownership.name === item.name
      )
      const record = await putEnvVar(item.name, item.value, existing)
      if (record !== existing) pending.push(record)
    }
    for (const ref of plan.pathRefs) {
      if (await hasPathEntry(ref)) continue
      const record = await addPathEntry(ref)
      if (record) pending.push(record)
    }
    if (pending.length > 0) {
      await this.store.updateManifest((draft) => {
        draft.mutations.push(...pending)
      })
    }
  }

  /**
   * 撤销当前集成写入的全部变量与 PATH 引用。
   *
   * 只按清单里的 ownership 删除：变量值被用户改过或已删除时保持现状，
   * PATH 只移除登记过的引用，不恢复先前整条 PATH。清单记录保留到卸载完成。
   */
  private async clearEnvironment(): Promise<void> {
    const manifest = this.store.getManifest()
    for (const mutation of [...manifest.mutations].reverse()) {
      await rollbackMutation(mutation)
    }
  }

  /** 集成开关：按标记变量判断而不是某条具体 PATH 引用 */
  async isPathIntegrated(): Promise<boolean> {
    return (await readEnvVar(MANAGED_FLAG)) === '1'
  }

  /** PATH 集成开关：写入或移除全部环境变量与 PATH 引用 */
  async setPathIntegration(enabled: boolean): Promise<Manifest> {
    if (enabled) await this.syncEnvironment()
    else await this.clearEnvironment()
    return this.store.getManifest()
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

  /** 目录迁移：先撤销旧路径写入的变量与引用，搬移目录后再按新根重建 */
  async relocate(targetRoot: string): Promise<Manifest> {
    const oldRoot = this.layout.root
    if (oldRoot === targetRoot) throw new Error('目标目录与当前目录相同')

    const wasIntegrated = this.store.getState().config.pathIntegration
    // 旧位置的环境变量值是绝对路径，先按 ownership 撤销，避免迁移后留下失效路径
    await this.clearEnvironment()

    await mkdir(targetRoot, { recursive: true })
    // current 目录保留给旧版残留清理；新方案不再生成垫片
    const moveNames = ['runtimes', 'cache', 'scripts', 'current', 'global', 'state.json', 'manifest.json']
    for (const name of moveNames) {
      const from = join(oldRoot, name)
      const to = join(targetRoot, name)
      await rm(to, { recursive: true, force: true })
      // 首次迁移或目录尚未生成时跳过，不中断整个迁移
      if (!(await stat(from).then(() => true, () => false))) continue
      await rename(from, to)
    }

    const newLayout = createLayout(targetRoot)
    await this.store.adoptLayout(newLayout)
    this.layout = newLayout

    await ensureGlobalBuckets(targetRoot, this.store.getState().activeVersions)
    await this.refreshActivationArtifacts()

    // ownership 记录的值指向旧根目录，迁完整体作废并按新根重建；
    // 清单只反映当前仍在的系统状态，而不是历史写入流水。
    await this.store.updateManifest((draft) => {
      draft.installRoot = targetRoot
      draft.mutations = []
    })
    if (wasIntegrated) await this.syncEnvironment()
    return this.store.getManifest()
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

    const integrated = await this.isPathIntegrated()
    const wantsIntegration = state.config.pathIntegration
    items.push({
      id: 'path-order',
      title: 'PATH 优先级',
      status: integrated === wantsIntegration ? 'ok' : 'warning',
      detail: integrated
        ? 'HOME 变量与 PATH 引用已写入用户级环境，优先于后续系统条目'
        : wantsIntegration
          ? '已开启 PATH 集成，但标记变量缺失，请重新开启'
          : '未集成 PATH，使用激活脚本或 IDE 配置解释器路径'
    })

    const nodeVersion = state.activeVersions.node
    const npmPrefix = nodeVersion
      ? join(this.layout.root, 'global', 'npm-store', `node${nodeVersion.replace(/^[A-Za-z]+/, '').split('.')[0]}`)
      : ''
    const npmReady = nodeVersion
      ? await stat(npmPrefix).then(() => true, () => false)
      : true
    items.push({
      id: 'npm-global',
      title: 'npm 全局目录',
      status: npmReady ? 'ok' : 'warning',
      detail: nodeVersion
        ? (npmReady ? npmPrefix : `${npmPrefix} 尚未创建，首次启动会重建`)
        : '未激活 Node，全局目录按激活版本创建'
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

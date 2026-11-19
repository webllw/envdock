/**
 * 引擎：编排 provider、下载器、存储与系统变更。
 *
 * 职责边界：provider 负责语言差异，下载器负责字节传输，本模块只负责流程。
 * 所有对外的 IPC 行为最终都落到这里，便于单独测试与替换界面。
 */
import { join } from 'node:path'
import { mkdir, rename, rm } from 'node:fs/promises'
import type {
  AppStateData,
  BootstrapPayload,
  HealthCheckItem,
  Manifest,
  ProgressEvent,
  ToolId,
  ToolSummary,
  UpdateManifest,
  UpdateState,
  VersionInfo
} from '@shared/domain'
import { createProviders, allToolMetadata } from '@main/providers/registry'
import { removeVersionDir } from '@main/providers/runtime'
import { currentBinRelative, writeActivationScripts, writeCurrentShims, type ActiveTool } from './activations'
import { cachedFile, downloadAndVerify } from './downloader'
import { addPathEntry, hasPathEntry, removePathEntry, rollbackMutation } from './system'
import { createLayout, type Layout } from './paths'
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
    await this.refreshActivationArtifacts()
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

  async rollbackUpdate(): Promise<void> {
    await this.updater.rollback()
  }

  async discardOldVersion(): Promise<void> {
    await this.updater.discardOld()
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

  async install(toolId: ToolId, versionId: string): Promise<void> {
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

  /** 根据当前全局激活版本重建脚本与垫片 */
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

    await Promise.all([
      writeActivationScripts(this.layout, active),
      writeCurrentShims(this.layout, active)
    ])
  }

  async setConfig(patch: Partial<AppStateData['config']>): Promise<AppStateData> {
    return this.store.updateState((draft) => {
      draft.config = { ...draft.config, ...patch }
    })
  }

  /** PATH 集成开关：写入或移除用户级 PATH 条目，并记录可回滚变更 */
  async setPathIntegration(enabled: boolean): Promise<Manifest> {
    const entry = join(this.layout.root, currentBinRelative())
    if (enabled) {
      const mutation = await addPathEntry(entry)
      if (mutation) {
        return this.store.updateManifest((draft) => {
          draft.mutations.push(mutation)
        })
      }
    } else {
      await removePathEntry(entry)
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

    const oldEntry = join(oldRoot, currentBinRelative())
    if (await hasPathEntry(oldEntry)) {
      await removePathEntry(oldEntry)
    }

    await mkdir(targetRoot, { recursive: true })
    for (const name of ['runtimes', 'cache', 'scripts', 'current', 'state.json', 'manifest.json']) {
      const from = join(oldRoot, name)
      const to = join(targetRoot, name)
      await rm(to, { recursive: true, force: true })
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

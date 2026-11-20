import { create } from 'zustand'
import type {
  AppConfig,
  HealthCheckItem,
  Manifest,
  ProgressEvent,
  ToolId,
  ToolSummary,
  UpdateManifest,
  UpdateState,
  VersionInfo
} from '@shared/domain'
import type { ProxyTestResult } from '@shared/ipc'
import { DEFAULT_UPDATE_REPO } from '@shared/sources'
import { api } from '@renderer/data/host'
import { emptyToolSkeletons } from '@shared/tools'

export type PageKey = 'dashboard' | 'runtimes' | 'settings'
export type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'envdock-theme'

/** 尚未从主进程读到清单时的空值，界面据此显示加载状态 */
function emptyManifest(): Manifest {
  return { schemaVersion: 1, installRoot: '', installedAt: '', updatedAt: '', mutations: [] }
}

/** 主题偏好先于界面渲染读取，避免首次绘制出现闪烁 */
function readInitialTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

interface WizardState {
  open: boolean
  toolId: ToolId | null
  selectedVersionId: string | null
  stage: 'select' | 'installing' | 'done'
  progress: number
  progressMessage: string
  error: string | null
  /** 版本列表拉取中；完成后一次性渲染，避免先显示少量再追加造成跳变 */
  loading: boolean
  /** 是否展开全部版本；关闭向导或切换工具时重置 */
  showAll: boolean
}

interface AppState {
  page: PageKey
  theme: Theme
  ready: boolean
  /** 后端不可用时的错误说明；界面据此提示，不回退到任何演示数据 */
  backendError: string | null
  tools: ToolSummary[]
  remote: Partial<Record<ToolId, VersionInfo[]>>
  manifest: Manifest
  config: AppConfig
  health: HealthCheckItem[]
  wizard: WizardState
  update: UpdateState
  toast: { message: string; tone: 'success' | 'info' | 'warning' } | null

  initialize: () => Promise<void>
  setPage: (page: PageKey) => void
  toggleTheme: () => void
  refreshTools: () => Promise<void>
  refreshRemote: (toolId: ToolId) => Promise<void>
  setActiveVersion: (toolId: ToolId, versionId: string) => Promise<void>
  deactivateVersion: (toolId: ToolId) => Promise<void>
  uninstallToolVersion: (toolId: ToolId, versionId: string) => Promise<boolean>
  openWizard: (toolId: ToolId) => void
  selectWizardVersion: (versionId: string) => void
  toggleShowAll: () => void
  setWizardStage: (stage: WizardState['stage']) => void
  setWizardProgress: (progress: number, message?: string) => void
  closeWizard: () => void
  runInstall: () => Promise<void>
  recheckHealth: () => Promise<void>
  setConfig: (patch: Partial<AppConfig>) => Promise<void>
  checkProxy: (url: string, enabled: boolean) => Promise<ProxyTestResult>
  setPathIntegration: (enabled: boolean) => Promise<void>
  migrate: (targetRoot: string) => Promise<void>
  chooseDirectory: (title?: string) => Promise<string | null>
  uninstallAll: () => Promise<void>
  checkUpdate: (silent?: boolean) => Promise<UpdateManifest | null>
  applyUpdate: () => Promise<void>
  setUpdSource: (sourceUrl: string, autoCheck: boolean) => Promise<void>
  loadUpdateState: () => Promise<void>
  setUpdateState: (state: UpdateState) => void
  showToast: (message: string, tone?: 'success' | 'info' | 'warning') => void
  clearToast: () => void
}

const emptyWizard: WizardState = {
  open: false,
  toolId: null,
  selectedVersionId: null,
  stage: 'select',
  progress: 0,
  progressMessage: '',
  error: null,
  loading: false,
  showAll: false
}

export const useAppStore = create<AppState>((set, get) => ({
  page: 'dashboard',
  theme: readInitialTheme(),
  ready: false,
  backendError: null,
  tools: emptyToolSkeletons(),
  remote: {},
  manifest: emptyManifest(),
  config: { mirror: 'official', pathIntegration: true, update: { sourceUrl: DEFAULT_UPDATE_REPO, autoCheck: true }, proxy: { enabled: false, url: '' }, closeBehavior: 'ask' },
  health: [],
  wizard: emptyWizard,
  update: {
    phase: 'idle', currentVersion: '', available: null,
    readyToApply: false, canRollback: false, history: [], message: '', percent: 0
  },
  toast: null,

  initialize: async () => {
    try {
      const payload = await api.bootstrap()
      set({
        tools: payload.tools,
        health: payload.health,
        manifest: payload.manifest,
        config: payload.state.config,
        ready: true,
        backendError: null
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '初始化失败'
      set({ ready: true, backendError: message })
      get().showToast(message, 'warning')
    }
  },

  setPage: (page) => set({ page }),

  toggleTheme: () =>
    set((state) => {
      const theme: Theme = state.theme === 'light' ? 'dark' : 'light'
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme)
      } catch {
        /* 存储不可用时仍允许本次会话内切换 */
      }
      return { theme }
    }),

  refreshTools: async () => {
    try {
      const payload = await api.bootstrap()
      set({ tools: payload.tools, health: payload.health, manifest: payload.manifest })
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '刷新失败', 'warning')
    }
  },

  refreshRemote: async (toolId) => {
    // 只在当前向导正等待该工具时显示加载态，设置页主动重新拉取不干扰向导
    const isWizardWaiting =
      get().wizard.open && get().wizard.toolId === toolId && get().wizard.loading
    if (isWizardWaiting) {
      set((state) => ({ wizard: { ...state.wizard, loading: true } }))
    }
    try {
      const versions = await api.listVersions(toolId)
      set((state) => ({
        remote: { ...state.remote, [toolId]: versions },
        wizard:
          state.wizard.open && state.wizard.toolId === toolId
            ? { ...state.wizard, loading: false, selectedVersionId: null }
            : state.wizard
      }))
    } catch (error) {
      set((state) => ({
        wizard:
          state.wizard.open && state.wizard.toolId === toolId
            ? { ...state.wizard, loading: false }
            : state.wizard
      }))
      get().showToast(error instanceof Error ? error.message : '版本列表获取失败', 'warning')
    }
  },

  setActiveVersion: async (toolId, versionId) => {
    const tool = get().tools.find((item) => item.id === toolId)
    try {
      await api.activate(toolId, versionId)
      set((state) => ({
        tools: state.tools.map((item) =>
          item.id === toolId ? { ...item, activeVersionId: versionId } : item
        )
      }))
      await get().recheckHealth()
      get().showToast(`${tool?.displayName ?? toolId} 全局版本已切换`, 'success')
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '切换失败', 'warning')
    }
  },

  deactivateVersion: async (toolId) => {
    const tool = get().tools.find((item) => item.id === toolId)
    try {
      await api.deactivate(toolId)
      set((state) => ({
        tools: state.tools.map((item) =>
          item.id === toolId ? { ...item, activeVersionId: null } : item
        )
      }))
      await get().recheckHealth()
      get().showToast(`${tool?.displayName ?? toolId} 全局激活已取消`, 'success')
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '取消全局失败', 'warning')
    }
  },

  uninstallToolVersion: async (toolId, versionId) => {
    const tool = get().tools.find((item) => item.id === toolId)
    try {
      await api.uninstallVersion(toolId, versionId)
      await get().refreshTools()
      await get().recheckHealth()
      get().showToast(`${tool?.displayName ?? toolId} ${versionId} 已卸载`, 'success')
      return true
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '卸载失败', 'warning')
      return false
    }
  },

  openWizard: (toolId) => {
    // 未缓存时先进入加载态，避免上一次打开的版本列表闪现
    const hasCached = Boolean(get().remote[toolId]?.length)
    set({
      wizard: {
        ...emptyWizard,
        open: true,
        toolId,
        loading: !hasCached
      }
    })
    void get().refreshRemote(toolId)
  },

  selectWizardVersion: (versionId) =>
    set((state) => ({ wizard: { ...state.wizard, selectedVersionId: versionId, error: null } })),

  toggleShowAll: () => set((state) => ({ wizard: { ...state.wizard, showAll: !state.wizard.showAll } })),

  setWizardStage: (stage) => set((state) => ({ wizard: { ...state.wizard, stage } })),

  setWizardProgress: (progress, message) =>
    set((state) => ({
      wizard: {
        ...state.wizard,
        progress,
        progressMessage: message ?? state.wizard.progressMessage
      }
    })),

  closeWizard: () => set({ wizard: emptyWizard }),

  runInstall: async () => {
    const { wizard, tools } = get()
    if (!wizard.toolId || !wizard.selectedVersionId) return
    const toolId = wizard.toolId
    const versionId = wizard.selectedVersionId
    const tool = tools.find((item) => item.id === toolId)

    set((state) => ({
      wizard: { ...state.wizard, stage: 'installing', progress: 0, error: null }
    }))

    try {
      await api.install(toolId, versionId)
      set((state) => ({ wizard: { ...state.wizard, stage: 'done', progress: 100 } }))
      await get().refreshTools()
      get().showToast(`${tool?.displayName ?? toolId} ${versionId} 安装完成`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : '安装失败'
      set((state) => ({ wizard: { ...state.wizard, stage: 'select', error: message } }))
      get().showToast(message, 'warning')
    }
  },

  recheckHealth: async () => {
    try {
      set({ health: await api.recheckHealth() })
    } catch {
      /* 体检失败保留上一次结果 */
    }
  },

  setConfig: async (patch) => {
    try {
      const state = await api.setConfig(patch)
      set({ config: state.config })
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '设置失败', 'warning')
    }
  },

  checkProxy: (url, enabled) => api.checkProxy(url, enabled),

  setPathIntegration: async (enabled) => {
    try {
      await api.setPathIntegration(enabled)
      set((state) => ({ config: { ...state.config, pathIntegration: enabled } }))
      await get().recheckHealth()
      get().showToast(enabled ? 'PATH 集成已开启' : 'PATH 集成已关闭', 'success')
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '设置失败', 'warning')
    }
  },

  migrate: async (targetRoot) => {
    try {
      const manifest = await api.relocate(targetRoot)
      set({ manifest })
      await get().refreshTools()
      get().showToast(`环境目录已迁移到 ${targetRoot}`, 'success')
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '迁移失败', 'warning')
    }
  },

  chooseDirectory: async (title) => {
    try {
      return await api.chooseDirectory(title)
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '无法打开目录选择框', 'warning')
      return null
    }
  },

  uninstallAll: async () => {
    try {
      await api.uninstallAll()
      get().showToast('系统变更已回滚，环境数据已清理；删除整个安装目录即可完成卸载', 'success')
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '卸载失败', 'warning')
    }
  },

  checkUpdate: async (silent = false) => {
    try {
      const manifest = await api.checkUpdate()
      if (!manifest && !silent) {
        get().showToast('当前已是最新版本', 'info')
      }
      return manifest
    } catch (error) {
      // 启动时的自动检查失败不打扰用户；失败原因仍写入 update state 供设置页查看
      if (!silent) {
        get().showToast(error instanceof Error ? error.message : '检查更新失败', 'warning')
      }
      return null
    }
  },

  applyUpdate: async () => {
    try {
      await api.applyUpdate()
      get().showToast('升级包已就绪，应用即将重启', 'success')
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '升级失败', 'warning')
    }
  },

  setUpdSource: async (sourceUrl, autoCheck) => {
    try {
      const state = await api.setUpdSource(sourceUrl, autoCheck)
      set({ config: state.config })
      get().showToast('更新源设置已保存', 'success')
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '设置失败', 'warning')
    }
  },

  loadUpdateState: async () => {
    try {
      const update = await api.getUpdateState()
      set({ update })
    } catch {
      /* 升级状态读取失败时保留上次结果 */
    }
  },

  setUpdateState: (state) => set({ update: state }),

  showToast: (message, tone = 'info') => set({ toast: { message, tone } }),
  clearToast: () => set({ toast: null })
}))

/** 主进程推送安装进度时更新向导，只处理当前工具的事件 */
export function handleProgressEvent(event: ProgressEvent): void {
  const state = useAppStore.getState()
  if (!state.wizard.open || state.wizard.toolId !== event.toolId) return
  if (event.phase === 'error') {
    state.showToast(event.message, 'warning')
    return
  }
  if (event.percent >= 0) state.setWizardProgress(event.percent, event.message)
}

/** 主进程推送升级状态时同步到界面 */
export function handleUpdateProgress(state: UpdateState): void {
  useAppStore.getState().setUpdateState(state)
}

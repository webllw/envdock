/**
 * 渲染进程数据访问层。
 *
 * 所有运行时数据都来自主进程。没有宿主 API 时直接失败，由调用方呈现
 * 加载状态或错误提示；这里不保留任何演示数据，避免界面出现与真实环境
 * 不一致的内容。
 */
import type { EnvdockApi } from '@shared/ipc'
import type {
  AppStateData,
  ToolId,
  UpdateManifest,
  UpdateState,
  VersionInfo
} from '@shared/domain'

const host = typeof window !== 'undefined' ? window.envdock : undefined

/** 当前是否运行在提供宿主 API 的桌面应用中 */
export const hasHost = Boolean(host)

function requireHost(): EnvdockApi {
  if (!host) throw new Error('未检测到后端接口，请在桌面应用中运行')
  return host
}

export const api = {
  platform: host?.platform ?? 'browser',
  hasHost,

  bootstrap: () => requireHost().bootstrap(),
  listVersions: (toolId: ToolId): Promise<VersionInfo[]> => requireHost().listVersions(toolId),
  install: (toolId: ToolId, versionId: string) => requireHost().install({ toolId, versionId }),
  activate: (toolId: ToolId, versionId: string) => requireHost().activate({ toolId, versionId }),
  deactivate: (toolId: ToolId) => requireHost().deactivate({ toolId }),
  uninstallVersion: (toolId: ToolId, versionId: string) =>
    requireHost().uninstallVersion({ toolId, versionId }),
  recheckHealth: () => requireHost().recheckHealth(),
  setConfig: (patch: Partial<AppStateData['config']>) => requireHost().setConfig(patch),
  setPathIntegration: (enabled: boolean) => requireHost().setPathIntegration(enabled),
  relocate: (targetRoot: string) => requireHost().relocate({ targetRoot }),
  uninstallAll: () => requireHost().uninstallAll(),
  chooseDirectory: (title?: string): Promise<string | null> => requireHost().chooseDirectory(title),
  openTerminal: () => requireHost().openTerminal(),
  checkUpdate: (): Promise<UpdateManifest | null> => requireHost().checkUpdate(),
  applyUpdate: (): Promise<UpdateState> => requireHost().applyUpdate(),
  rollbackUpdate: () => requireHost().rollbackUpdate(),
  rollbackToVersion: (versionId: string) => requireHost().rollbackToVersion(versionId),
  discardOldVersion: () => requireHost().discardOldVersion(),
  discardVersion: (versionId: string) => requireHost().discardVersion(versionId),
  getUpdateState: (): Promise<UpdateState> => requireHost().getUpdateState(),
  setUpdSource: (sourceUrl: string, autoCheck: boolean) =>
    requireHost().setUpdSource({ sourceUrl, autoCheck }),
  checkProxy: (url: string, enabled: boolean): Promise<import('@shared/ipc').ProxyTestResult> =>
    requireHost().checkProxy(url, enabled),
  windowHide: () => requireHost().windowHide(),
  windowMinimize: () => requireHost().windowMinimize(),
  windowQuit: () => requireHost().windowQuit(),
  windowClose: () => requireHost().windowClose(),
  refreshTray: () => requireHost().refreshTray(),
  onCloseRequest: (listener: () => void) => host?.onCloseRequest(listener) ?? (() => undefined),
  onProgress: (listener: (event: import('@shared/domain').ProgressEvent) => void) =>
    host?.onProgress(listener) ?? (() => undefined),
  onUpdateProgress: (listener: (event: UpdateState) => void) =>
    host?.onUpdateProgress(listener) ?? (() => undefined)
}

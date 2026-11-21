/**
 * 主进程与渲染进程之间的 IPC 契约。
 *
 * 通道名集中定义，调用方不写字符串字面量。所有 invoke 的参数与返回值
 * 在此声明，preload 暴露的类型从这里派生，避免两侧签名不一致。
 */
import type {
  AppStateData,
  BootstrapPayload,
  ClearResidueResult,
  HealthCheckItem,
  Manifest,
  ProgressEvent,
  ToolId,
  UpdateManifest,
  UpdateState,
  VersionInfo
} from './domain'

export const IPC_CHANNELS = {
  bootstrap: 'envdock:bootstrap',
  listVersions: 'envdock:list-versions',
  install: 'envdock:install',
  activate: 'envdock:activate',
  deactivate: 'envdock:deactivate',
  uninstallVersion: 'envdock:uninstall-version',
  recheckHealth: 'envdock:recheck-health',
  setConfig: 'envdock:set-config',
  setPathIntegration: 'envdock:set-path-integration',
  relocate: 'envdock:relocate',
  uninstallAll: 'envdock:uninstall-all',
  chooseDirectory: 'envdock:choose-directory',
  openTerminal: 'envdock:open-terminal',
  progress: 'envdock:progress',
  checkUpdate: 'envdock:check-update',
  applyUpdate: 'envdock:apply-update',
  clearUpdateResidue: 'envdock:clear-update-residue',
  getUpdateState: 'envdock:get-update-state',
  setUpdSource: 'envdock:set-update-source',
  checkProxy: 'envdock:check-proxy',
  updateProgress: 'envdock:update-progress',
  windowHide: 'envdock:window-hide',
  windowQuit: 'envdock:window-quit',
  windowMinimize: 'envdock:window-minimize',
  windowClose: 'envdock:window-close',
  closeRequest: 'envdock:close-request',
  refreshTray: 'envdock:refresh-tray',
  stateChanged: 'envdock:state-changed'
} as const

/** 安装操作的请求参数 */
export interface InstallRequest {
  toolId: ToolId
  versionId: string
}

/** 版本激活的公共参数；取消激活只需 toolId */
export interface ActivationRequest {
  toolId: ToolId
  versionId: string
}

/** 设置写入参数，部分字段更新 */
export type SetConfigRequest = Partial<AppStateData['config']>

/** 迁移请求 */
export interface RelocateRequest {
  targetRoot: string
}

/** 更新源写入参数 */
export interface SetUpdateSourceRequest {
  sourceUrl: string
  autoCheck: boolean
}

/** 代理连通性探测结果 */
export interface ProxyTestResult {
  ok: boolean
  latencyMs: number
  message: string
}

/** 渲染进程可调用的宿主 API */
export interface EnvdockApi {
  readonly platform: string
  bootstrap(): Promise<BootstrapPayload>
  listVersions(toolId: ToolId): Promise<VersionInfo[]>
  install(req: InstallRequest): Promise<void>
  activate(req: ActivationRequest): Promise<void>
  deactivate(req: { toolId: ToolId }): Promise<void>
  uninstallVersion(req: ActivationRequest): Promise<void>
  recheckHealth(): Promise<HealthCheckItem[]>
  setConfig(req: SetConfigRequest): Promise<AppStateData>
  setPathIntegration(enabled: boolean): Promise<Manifest>
  relocate(req: RelocateRequest): Promise<Manifest>
  uninstallAll(): Promise<void>
  /** 打开目录选择对话框；title 用于说明选择用途，取消时返回 null */
  chooseDirectory(title?: string): Promise<string | null>
  openTerminal(): Promise<void>
  /** 检查更新源，返回可用的新版本；已是最新则返回 null */
  checkUpdate(): Promise<UpdateManifest | null>
  /** 下载并准备升级包，返回后由界面提示用户确认重启 */
  applyUpdate(): Promise<UpdateState>
  /** 清除历史归档、升级包缓存与暂存残留，返回实际回收量 */
  clearUpdateResidue(): Promise<ClearResidueResult>
  getUpdateState(): Promise<UpdateState>
  setUpdSource(req: SetUpdateSourceRequest): Promise<AppStateData>
  /** 用给定代理实测官方列表接口的连通性；enabled 为 false 时测直连 */
  checkProxy(url: string, enabled: boolean): Promise<ProxyTestResult>
  /** 隐藏窗口到托盘，应用继续运行 */
  windowHide(): Promise<void>
  /** 最小化窗口到任务栏，应用继续运行 */
  windowMinimize(): Promise<void>
  /** 从托盘菜单退出应用，不经过关闭询问 */
  windowQuit(): Promise<void>
  /** 用户点击关闭按钮，由主进程按记住的行为决定隐藏、退出或弹窗询问 */
  windowClose(): Promise<void>
  /** 请求主进程重建托盘菜单，激活版本变化后调用 */
  refreshTray(): Promise<void>
  /** 订阅安装进度，返回取消订阅函数；仅 install 期间有事件 */
  onProgress(listener: (event: ProgressEvent) => void): () => void
  /** 订阅升级进度，返回取消订阅函数 */
  onUpdateProgress(listener: (event: UpdateState) => void): () => void
  /** 订阅关闭询问；用户点关闭且未记住选择时触发，返回取消订阅函数 */
  onCloseRequest(listener: () => void): () => void
  /** 订阅全局状态变化；托盘切换版本等非界面操作触发，界面据此重新读取状态 */
  onStateChanged(listener: () => void): () => void
}

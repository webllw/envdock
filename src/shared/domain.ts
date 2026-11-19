/**
 * 跨进程共享的领域模型。
 *
 * 该文件是类型的唯一来源；主进程与渲染进程都从这里导入，
 * 避免两侧各自维护导致契约漂移。
 */

/** 工具唯一标识，同时作为 runtimes 目录下的子目录名 */
export type ToolId = 'java' | 'php' | 'python' | 'go' | 'node'

/** 版本记录的稳定性等级 */
export type VersionChannel = 'stable' | 'lts' | 'preview'

/** 远程可用的单个版本 */
export interface VersionInfo {
  /** 版本标识，例如 21.0.13+9.0.LTS 或 8.3.12 */
  id: string
  /** 面向用户展示的版本号 */
  display: string
  channel: VersionChannel
  /** 发行日期，ISO 8601 */
  releasedAt: string
}

/** 本地已安装的单个版本 */
export interface InstalledVersion {
  versionId: string
  display: string
  /** 相对于环境根目录的安装路径 */
  relativePath: string
  /** 占用空间，字节 */
  sizeBytes: number
  installedAt: string
}

/** 激活操作产出的计划，由核心层统一执行；引擎不直接改系统状态 */
export interface ActivationPlan {
  tool: ToolId
  versionId: string
  /** 需要注入 PATH 的目录，相对环境根目录 */
  pathEntries: string[]
  /** 需要设置的环境变量 */
  envVars: Record<string, string>
  /** 生成给 shell 使用的片段 */
  shellSnippet: string
}

/**
 * 语言适配器契约。
 * 新增语言只需实现本接口并在注册表登记，引擎与界面无需改动。
 */
export interface ToolProvider {
  readonly id: ToolId
  readonly displayName: string
  readonly accent: string
  listVersions(): Promise<VersionInfo[]>
  resolveDownload(version: VersionInfo): Promise<DownloadPlan>
  install(version: VersionInfo, archive: string, targetDir: string): Promise<void>
  activate(version: VersionInfo): ActivationPlan
  deactivate(): ActivationPlan
  detectInstalled(root: string): Promise<InstalledVersion[]>
}

/** 下载计划，镜像替换在 provider 内部完成 */
export interface DownloadPlan {
  url: string
  fileName: string
  checksum: string
  checksumAlgorithm: 'sha256' | 'sha512'
  /** 主地址失败时按顺序尝试，镜像源放首位，官方源兜底 */
  fallbackUrls?: string[]
}

/** 一次环境变更在系统留下的可回滚记录 */
export interface SystemMutation {
  id: string
  kind: 'path' | 'registry' | 'shortcut'
  /** 变更位置，例如 HKCU\Environment\Path */
  target: string
  /** 原值，卸载时恢复；新建项为空 */
  previousValue: string | null
  /** 写入的新值 */
  currentValue: string
  createdAt: string
}

/** 安装清单，记录工具对环境根目录之外的全部改动 */
export interface Manifest {
  schemaVersion: number
  /** 当前安装根目录，迁移时整体改写 */
  installRoot: string
  installedAt: string
  updatedAt: string
  mutations: SystemMutation[]
}

/** 单个语言的汇总视图，供界面卡片消费 */
export interface ToolSummary {
  id: ToolId
  displayName: string
  accent: string
  installed: InstalledVersion[]
  activeVersionId: string | null
  remoteCount: number
}

/** 环境体检的单项结果 */
export interface HealthCheckItem {
  id: string
  title: string
  status: 'ok' | 'warning' | 'error'
  detail: string
}

/**
 * 应用更新源配置。
 * 更新包托管在 GitHub Releases，sourceUrl 指向仓库地址。
 */
export interface UpdateSourceConfig {
  /** GitHub 仓库地址，形如 https://github.com/owner/repo */
  sourceUrl: string
  /** 启动时是否自动检查更新 */
  autoCheck: boolean
}

/** 从 GitHub 最新 release 整理出的更新清单 */
export interface UpdateManifest {
  schemaVersion: number
  /** 新版本号，语义化版本字符串 */
  version: string
  /** 发布日期 ISO 8601 */
  releasedAt: string
  /** 升级包文件名，用于缓存命名 */
  fileName: string
  /** 升级包下载地址，来自 release asset 的绝对 URL */
  downloadUrl: string
  /** 升级包 SHA-256 十六进制串 */
  sha256: string
  /** 升级包字节数，用于下载进度展示 */
  sizeBytes: number
  /** 更新说明 */
  notes: string
}

/** 应用本地版本状态，位于根目录 version.json */
export interface VersionState {
  schemaVersion: number
  /** 当前正在运行的版本，取自应用内建版本 */
  currentVersion: string
  /** 升级替换完成但尚未通过启动确认的版本；非空表示有挂起升级 */
  pendingVersion: string | null
  /** 挂起升级前的版本，用于回滚 */
  previousVersion: string | null
  /** 最近一次升级尝试的结果说明 */
  lastMessage: string
  updatedAt: string
}

/** 升级流程阶段 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'restarting'
  | 'error'

/** 升级流程对外状态，供界面渲染 */
export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  /** 检查到的新版本，未检查或无更新时为 null */
  available: UpdateManifest | null
  /** 是否已有通过校验、待应用的升级包 */
  readyToApply: boolean
  /** 是否存在可回滚的旧版本目录 */
  canRollback: boolean
  /** 阶段说明文字 */
  message: string
  /** 0-100；无法给出比例时为 -1 */
  percent: number
}

/** 网络代理配置；url 为 HTTP 代理地址，如 http://127.0.0.1:7890 */
export interface ProxyConfig {
  enabled: boolean
  url: string
}

/** 用户可配置项 */
export interface AppConfig {
  /** 下载镜像，official 表示直连官方源 */
  mirror: 'official' | 'tsinghua' | 'aliyun' | 'huawei'
  /** 是否把 current/bin 写入用户级 PATH */
  pathIntegration: boolean
  /** 应用自身更新源 */
  update: UpdateSourceConfig
  /** 出网代理；关闭时所有请求直连官方源 */
  proxy: ProxyConfig
}

/** 持久化状态，位于环境根目录的 state.json */
export interface AppStateData {
  schemaVersion: number
  /** 各工具的全局激活版本 */
  activeVersions: Partial<Record<ToolId, string>>
  config: AppConfig
  updatedAt: string
}

/** 启动引导数据，bootstrap IPC 一次性返回 */
export interface BootstrapPayload {
  state: AppStateData
  manifest: Manifest
  tools: ToolSummary[]
  health: HealthCheckItem[]
  platform: string
  arch: string
}

/** 安装进度事件，由主进程推送给渲染进程 */
export interface ProgressEvent {
  toolId: ToolId
  versionId: string
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
  /** 0-100；无法给出比例时为 -1 */
  percent: number
  message: string
}

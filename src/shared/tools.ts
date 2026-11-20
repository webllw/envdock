/**
 * 工具目录元数据。
 *
 * 这里只描述应用支持哪些工具及其展示信息，不含任何版本或安装状态。
 * 主进程 provider 与渲染进程空骨架共用本定义，避免两处硬编码漂移。
 * 版本、安装、绑定等运行时数据一律通过 IPC 从主进程获取。
 */
import type { ToolId, ToolSummary } from './domain'

export interface ToolMeta {
  id: ToolId
  displayName: string
  accent: string
}

export const TOOL_METADATA: readonly ToolMeta[] = [
  { id: 'java', displayName: 'Java (Temurin)', accent: '#e8833a' },
  { id: 'maven', displayName: 'Maven', accent: '#c0392b' },
  { id: 'php', displayName: 'PHP', accent: '#7b8fd4' },
  { id: 'python', displayName: 'Python', accent: '#f0c94c' },
  { id: 'go', displayName: 'Go', accent: '#4ab7d8' },
  { id: 'node', displayName: 'Node.js', accent: '#6cc24a' }
]

/**
 * 内部工具元数据。
 *
 * Composer 是 PHP 的附属构建工具，不出现在工具卡片、托盘与 IPC 用户入口；
 * 它的展示信息只由 provider 内部使用，因此不放进 TOOL_METADATA。
 */
export const INTERNAL_TOOL_META = {
  id: 'composer' as const,
  displayName: 'Composer',
  accent: '#a06cd5'
}

/** 取单个工具的展示元数据 */
export function toolMeta(id: ToolId): ToolMeta {
  if (id === INTERNAL_TOOL_META.id) return INTERNAL_TOOL_META
  return TOOL_METADATA.find((item) => item.id === id) ?? TOOL_METADATA[0]
}

/** 是否为用户可见工具；内部工具不纳入卡片、托盘与 IPC 入口 */
export function isUserVisibleTool(id: ToolId): boolean {
  return TOOL_METADATA.some((item) => item.id === id)
}

/**
 * 构造尚无运行时数据时的工具空骨架。
 * 仅含静态展示字段，安装列表与激活版本均为空，等待 bootstrap 填充。
 */
export function emptyToolSkeletons(): ToolSummary[] {
  return TOOL_METADATA.map((item) => ({
    ...item,
    installed: [],
    activeVersionId: null,
    remoteCount: 0
  }))
}

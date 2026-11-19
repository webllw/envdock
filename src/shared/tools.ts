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
  { id: 'php', displayName: 'PHP', accent: '#7b8fd4' },
  { id: 'python', displayName: 'Python', accent: '#f0c94c' },
  { id: 'go', displayName: 'Go', accent: '#4ab7d8' },
  { id: 'node', displayName: 'Node.js', accent: '#6cc24a' }
]

/** 取单个工具的展示元数据 */
export function toolMeta(id: ToolId): ToolMeta {
  return TOOL_METADATA.find((item) => item.id === id) ?? TOOL_METADATA[0]
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

/**
 * 版本源解析。
 *
 * 版本列表地址固定为各项目官方接口，不由配置改写。界面展示的地址与这里
 * 实际请求的地址来自同一份共享定义，用户可直接核对来源。
 */
import type { ToolId } from '@shared/domain'
import { officialSource } from '@shared/sources'

/** 取某工具的官方列表根地址，无内置源的工具返回 null */
export function activeSource(toolId: ToolId): string | null {
  return officialSource(toolId)?.url ?? null
}

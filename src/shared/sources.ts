/**
 * 各工具的官方版本列表地址。
 *
 * provider 从这里取地址请求版本列表，界面也从这里取同一份值展示，
 * 保证用户核对的地址就是实际发起请求的地址。
 * 只收录官方接口：多数第三方镜像仅镜像安装包，不镜像列表 API。
 */
import type { ToolId } from './domain'

export interface OfficialSource {
  /** 展示名称 */
  label: string
  /** 版本列表接口根地址 */
  url: string
}

export const OFFICIAL_SOURCES: Partial<Record<ToolId, OfficialSource>> = {
  java: {
    label: 'Eclipse Adoptium 官方 API',
    url: 'https://api.adoptium.net/v3'
  },
  php: {
    label: 'windows.php.net 官方',
    url: 'https://windows.php.net/downloads/releases'
  },
  python: {
    label: 'Python.org 官方',
    url: 'https://www.python.org/downloads/windows'
  },
  go: {
    label: 'Go 官方下载',
    url: 'https://go.dev/dl'
  },
  node: {
    label: 'Node.js 官方 dist',
    url: 'https://nodejs.org/dist'
  }
}

/** 取工具的官方源；尚未接入的工具返回 null */
export function officialSource(toolId: ToolId): OfficialSource | null {
  return OFFICIAL_SOURCES[toolId] ?? null
}

/** 地址可靠性说明：官方接口固定标注为可信，并如实反映是否走 HTTPS */
export function sourceReliability(url: string): {
  label: string
  tone: 'ok' | 'warning'
  detail: string
} {
  const https = /^https:\/\//i.test(url)
  return {
    label: '官方源',
    tone: https ? 'ok' : 'warning',
    detail: https
      ? '项目官方发布地址，HTTPS 加密传输，可直接核对域名'
      : '项目官方地址，但当前非 HTTPS 连接'
  }
}

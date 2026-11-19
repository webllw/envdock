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
  maven: {
    label: 'Maven Central 官方仓库',
    url: 'https://repo.maven.apache.org/maven2'
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

/** 应用自身更新所用的默认仓库 */
export const DEFAULT_UPDATE_REPO = 'https://github.com/webllw/envdock'

/** GitHub Releases API 根地址 */
export const GITHUB_API_BASE = 'https://api.github.com'

/**
 * 把仓库地址解析为 owner/repo。
 * 接受完整 URL、带 .git 后缀的 URL 以及 owner/repo 简写，便于用户直接粘贴浏览器地址。
 */
export function parseRepoSlug(input: string): { owner: string; repo: string } | null {
  const value = input.trim()
  if (!value) return null
  const match = value.match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (!match) return null
  const owner = match[1]
  const repo = match[2]
  if (!owner || !repo || owner === 'repo') return null
  return { owner, repo }
}

/** 由仓库地址得到 releases/latest 接口地址；地址不合法时返回 null */
export function latestReleaseUrl(input: string): string | null {
  const slug = parseRepoSlug(input)
  return slug ? `${GITHUB_API_BASE}/repos/${slug.owner}/${slug.repo}/releases/latest` : null
}

/** 由仓库地址得到用户可点击的 Releases 页面地址 */
export function releasesPageUrl(input: string): string | null {
  const slug = parseRepoSlug(input)
  return slug ? `https://github.com/${slug.owner}/${slug.repo}/releases` : null
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

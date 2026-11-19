/**
 * GitHub Releases 更新源。
 *
 * 从仓库最新 release 解析出版本号、发布说明与升级包资产。资产下载地址取
 * browser_download_url 绝对值，校验值取 GitHub 提供的 digest；没有 digest 时
 * 回退到同名 .sha256 附件。两者都缺失时拒绝发布，避免无校验的包进入升级流程。
 *
 * API 根地址可通过参数注入，验证脚本据此指向本地测试服务，生产环境使用默认值。
 */
import type { UpdateManifest } from '@shared/domain'
import { GITHUB_API_BASE, latestReleaseUrl } from '@shared/sources'
import { requestFetch } from './net'

/** release 资产的最小结构，只取更新需要的字段 */
interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  digest: string | null
}

interface GitHubRelease {
  tag_name: string
  body: string | null
  published_at: string
  draft: boolean
  prerelease: boolean
  assets: ReleaseAsset[]
}

/** 从 GitHub 的 digest 字段提取十六进制摘要 */
function digestToHex(digest: string | null): string | null {
  if (!digest) return null
  const match = digest.trim().match(/^sha256:([a-f0-9]{64})$/i)
  return match ? match[1].toLowerCase() : null
}

/** 从附件名与 digest 判断是否为升级包：只认 zip，且排除校验文件 */
function pickUpgradeAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const archives = assets.filter((asset) => /\.zip$/i.test(asset.name) && !/\.sha256$/i.test(asset.name))
  return archives.find((asset) => /app/i.test(asset.name)) ?? archives[0] ?? null
}

/**
 * 读取同名 .sha256 附件的内容。文件内容允许是「摘要」或「摘要 文件名」两种格式。
 */
async function readChecksumAsset(asset: ReleaseAsset, assets: ReleaseAsset[]): Promise<string | null> {
  const checksum = assets.find((item) => item.name === `${asset.name}.sha256`)
  if (!checksum) return null
  const response = await requestFetch(checksum.browser_download_url, {
    headers: { 'user-agent': 'EnvDock' },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`校验文件下载失败：HTTP ${response.status}`)
  const text = await response.text()
  const hex = text.trim().split(/\s+/)[0] ?? ''
  return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : null
}

/**
 * 获取最新 release 并整理为更新清单。
 *
 * 仓库地址无效时抛错；仓库尚无 release 时返回 null，交由调用方视作「已是最新」。
 * 升级包缺少 SHA-256 时同样抛错，安全条款优先于可用性。
 */
export async function fetchLatestRelease(options: {
  sourceUrl: string
  appVersion: string
  apiBase?: string
}): Promise<UpdateManifest | null> {
  const endpoint = latestReleaseUrl(options.sourceUrl)
  if (!endpoint) throw new Error('GitHub 仓库地址无效，应形如 https://github.com/owner/repo')

  const url = options.apiBase
    ? endpoint.replace(GITHUB_API_BASE, options.apiBase.replace(/\/+$/, ''))
    : endpoint
  const response = await requestFetch(url, {
    headers: {
      'user-agent': `EnvDock/${options.appVersion}`,
      accept: 'application/vnd.github+json'
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 404) return null
  // 匿名 API 限额 60 次/小时，走代理时出口 IP 由多人共享，极易触发 403/429。
  // 原始 HTTP 状态码对用户没有可操作性，这里区分限流并给出明确的处置方向。
  if (response.status === 403 || response.status === 429) {
    let detail = ''
    try {
      const body = (await response.json()) as { message?: string }
      detail = body.message ?? ''
    } catch {
      // 响应体非 JSON 时忽略，仍按状态码给出提示
    }
    if (/rate limit|abuse|secondary/i.test(detail)) {
      throw new Error('GitHub API 匿名配额已用尽（共享出口 IP 常见），请稍后重试或关闭代理改用直连')
    }
    throw new Error(`GitHub Releases 请求被拒绝：HTTP ${response.status}${detail ? `（${detail}）` : ''}`)
  }
  if (!response.ok) throw new Error(`GitHub Releases 请求失败：HTTP ${response.status}`)

  const release = (await response.json()) as GitHubRelease
  if (release.draft || release.prerelease) return null

  const asset = pickUpgradeAsset(release.assets ?? [])
  if (!asset) throw new Error('最新 release 未附带 zip 升级包')

  const version = release.tag_name.replace(/^v/i, '')
  const sha256 = digestToHex(asset.digest) ?? await readChecksumAsset(asset, release.assets ?? [])
  if (!sha256) throw new Error('升级包缺少 SHA-256 校验值：请在发布时附带校验文件')

  return {
    schemaVersion: 1,
    version,
    releasedAt: release.published_at,
    fileName: asset.name,
    downloadUrl: asset.browser_download_url,
    sha256,
    sizeBytes: asset.size,
    notes: release.body ?? ''
  }
}

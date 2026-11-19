/**
 * GitHub Releases 更新源。
 *
 * 版本发现走 Releases Atom feed（github.com 域），不占 api.github.com 的匿名配额。
 * 走代理时出口 IP 由多人共享，API 的 60 次/小时配额几乎必然被耗尽，feed 则不受此限。
 *
 * feed 只给出版本号、发布时间与说明，不含资产列表，因此升级包地址按发布命名约定拼接，
 * SHA-256 从同名 .sha256 附件读取（同样是 github.com 直链）。校验文件缺失时拒绝升级，
 * 安全条款优先于可用性。feed 根地址可通过参数注入，验证脚本据此指向本地测试服务。
 */
import type { UpdateManifest } from '@shared/domain'
import {
  GITHUB_WEB_BASE,
  latestReleaseFeedUrl,
  releaseAssetUrl,
  upgradeAssetName
} from '@shared/sources'
import { requestFetch } from './net'

/** Atom feed 的一个条目，只取更新需要的字段 */
interface FeedEntry {
  /** 原始 tag，含 v 前缀，用于拼接下载直链 */
  tag: string
  releasedAt: string
  notes: string
}

/** 预发布标记：feed 会收录 alpha/beta/rc，这些版本不作为正式更新 */
const PRERELEASE_PATTERN = /[-.]?(alpha|beta|rc|preview)[-.]?\d*/i

/** 反转义 feed 中作为文本出现的 HTML 实体 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** 把 feed 的 HTML 说明压成单行纯文本，供设置页展示 */
function toPlainText(html: string): string {
  return decodeEntities(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从 Atom XML 中按时间顺序解析发布条目，跳过 draft 之外的预发布版本。
 * 用正则而非 XML 解析器：feed 结构固定且字段有限，避免为一个入口引入额外依赖。
 */
function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
  const entries: FeedEntry[] = []
  for (const block of blocks) {
    const tagMatch = block.match(/\/releases\/tag\/([^"<]+)/)
    const updatedMatch = block.match(/<updated>([^<]+)<\/updated>/)
    if (!tagMatch || !updatedMatch) continue
    const tag = decodeEntities(tagMatch[1].trim())
    if (PRERELEASE_PATTERN.test(tag)) continue
    const contentMatch = block.match(/<content[^>]*>([\s\S]*?)<\/content>/)
    entries.push({
      tag,
      releasedAt: updatedMatch[1].trim(),
      notes: contentMatch ? toPlainText(contentMatch[1]) : ''
    })
  }
  return entries
}

/** 读取升级包同名 .sha256 附件；内容允许「摘要」或「摘要 文件名」两种格式 */
async function readChecksum(assetUrl: string): Promise<string | null> {
  const response = await requestFetch(`${assetUrl}.sha256`, {
    headers: { 'user-agent': 'EnvDock' },
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`校验文件下载失败：HTTP ${response.status}`)
  const text = await response.text()
  const hex = text.trim().split(/\s+/)[0] ?? ''
  return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : null
}

/** 把可注入的本地测试根地址替换进 feed 与资产直链 */
function withBase(url: string, base?: string): string {
  return base ? url.replace(GITHUB_WEB_BASE, base.replace(/\/+$/, '')) : url
}

/**
 * 获取最新正式发布并整理为更新清单。
 *
 * 仓库地址无效时抛错；仓库尚无 release 时返回 null，交由调用方视作「已是最新」。
 * 升级包缺少 SHA-256 时同样抛错，安全条款优先于可用性。
 */
export async function fetchLatestRelease(options: {
  sourceUrl: string
  appVersion: string
  webBase?: string
}): Promise<UpdateManifest | null> {
  const feedUrl = latestReleaseFeedUrl(options.sourceUrl)
  if (!feedUrl) throw new Error('GitHub 仓库地址无效，应形如 https://github.com/owner/repo')

  const response = await requestFetch(withBase(feedUrl, options.webBase), {
    headers: { 'user-agent': `EnvDock/${options.appVersion}` },
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`获取发布信息失败：HTTP ${response.status}`)

  const latest = parseFeed(await response.text())[0]
  if (!latest) return null

  const version = latest.tag.replace(/^v/i, '')
  const fileName = upgradeAssetName(version)
  const assetUrl = withBase(
    releaseAssetUrl(options.sourceUrl, latest.tag, fileName) ?? '',
    options.webBase
  )
  if (!assetUrl || !assetUrl.startsWith('http')) {
    throw new Error('GitHub 仓库地址无效，应形如 https://github.com/owner/repo')
  }

  const sha256 = await readChecksum(assetUrl)
  if (!sha256) throw new Error('升级包缺少 SHA-256 校验值：请在发布时附带同名 .sha256 文件')

  return {
    schemaVersion: 1,
    version,
    releasedAt: latest.releasedAt,
    fileName,
    downloadUrl: assetUrl,
    sha256,
    // feed 不携带资产大小，下载阶段按实际字节与摘要校验，不依赖此字段
    sizeBytes: 0,
    notes: latest.notes
  }
}

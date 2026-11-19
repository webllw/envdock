/**
 * PHP Provider：消费 windows.php.net 官方 releases.json。
 *
 * 该 feed 直接提供每个 Windows 发行包的相对路径与 sha256，
 * 因此不需要自建版本索引。release.json 不提供发布日期，releasedAt
 * 留空，界面按缺省处理，不用猜测值填充。
 */
import type {
  AppConfig,
  DownloadPlan,
  InstalledVersion,
  ToolProvider,
  VersionInfo
} from '@shared/domain'
import { toolMeta } from '@shared/tools'
import { fetchJson } from './http'
import { activeSource } from './sources'
import { makeActivationPlan, makeDeactivationPlan, mirrorUrls } from './common'
import {
  detectInstalled as scanInstalled,
  extractZip,
  writeVersionMetadata
} from './runtime'

const DEFAULT_BASE_URL = 'https://windows.php.net/downloads/releases'

/** 优先线程安全版 x64；与本地开发装 Xdebug 的常见需求一致 */
const VARIANT_PREFERENCE = [
  'ts-vs17-x64',
  'ts-vs16-x64',
  'ts-vc15-x64',
  'nts-vs17-x64',
  'nts-vs16-x64',
  'nts-vc15-x64',
  'ts-vs17-x86',
  'ts-vs16-x86'
]

interface ZipAsset {
  path: string
  sha256?: string
  size?: string
}

type VariantNode = { zip?: ZipAsset }
/** 顶层每个元素是一条主版本分支：version 为版本号，其余键为各线程安全/编译器变体 */
type ReleaseBranch = { version?: string } & Record<string, string | VariantNode | undefined>
type ReleaseFeed = Record<string, ReleaseBranch>

/** 从分支节点中挑出首选的 zip 资源 */
function pickAsset(branch: ReleaseBranch): ZipAsset | null {
  for (const variant of VARIANT_PREFERENCE) {
    const node = branch[variant]
    if (node && typeof node === 'object' && node.zip?.path) return node.zip
  }
  for (const value of Object.values(branch)) {
    if (value && typeof value === 'object' && value.zip?.path) return value.zip
  }
  return null
}

/** 遍历 feed 得到 (版本, 资源) 列表；只保留有 zip 的分支 */
function flattenFeed(feed: ReleaseFeed): { version: string; asset: ZipAsset }[] {
  const result: { version: string; asset: ZipAsset }[] = []
  for (const branch of Object.values(feed)) {
    if (!branch || typeof branch !== 'object') continue
    const version = branch.version
    if (typeof version !== 'string') continue
    const asset = pickAsset(branch)
    if (asset) result.push({ version, asset })
  }
  return result
}

export class PhpProvider implements ToolProvider {
  readonly id = 'php' as const
  readonly displayName = toolMeta('php').displayName
  readonly accent = toolMeta('php').accent

  private assetCache: Map<string, ZipAsset> | null = null

  constructor(private readonly config: AppConfig) {}

  /** 官方发行目录地址，统一为带尾部斜杠 */
  private baseUrl(): string {
    const url = activeSource(this.id) ?? DEFAULT_BASE_URL
    return url.replace(/\/+$/, '') + '/'
  }

  private async catalog(): Promise<{ version: string; asset: ZipAsset }[]> {
    const feed = await fetchJson<ReleaseFeed>(`${this.baseUrl()}releases.json`)
    if (!feed) return []
    const items = flattenFeed(feed)
    this.assetCache = new Map(items.map((item) => [item.version, item.asset]))
    return items
  }

  async listVersions(): Promise<VersionInfo[]> {
    const items = await this.catalog()
    return items.map(({ version }) => ({
      id: version,
      display: version,
      channel: 'stable' as const,
      releasedAt: ''
    })).sort((a, b) => b.display.localeCompare(a.display, undefined, { numeric: true }))
  }

  async resolveDownload(version: VersionInfo): Promise<DownloadPlan> {
    let asset = this.assetCache?.get(version.id)
    if (!asset) {
      await this.catalog()
      asset = this.assetCache?.get(version.id)
    }
    if (!asset) throw new Error(`windows.php.net 未提供 ${version.display} 的 Windows 发行包`)

    const officialUrl = `${this.baseUrl()}${asset.path}`
    const fileName = asset.path.split('/').pop() ?? `php-${version.id}.zip`
    const mirrored = mirrorUrls(officialUrl, this.config, () => null)

    return {
      url: mirrored.primary,
      fallbackUrls: mirrored.fallbacks,
      fileName,
      checksum: asset.sha256 ?? '',
      checksumAlgorithm: 'sha256'
    }
  }

  activate(version: VersionInfo) {
    const relativeDir = `runtimes/php/${version.id}`
    return makeActivationPlan(this.id, version, relativeDir, {
      PHP_HOME: relativeDir
    }, '')
  }

  deactivate() {
    return makeDeactivationPlan(this.id, 'runtimes/php')
  }

  async install(version: VersionInfo, archive: string, targetDir: string): Promise<void> {
    await extractZip(archive, targetDir, false)
    await writeVersionMetadata(targetDir, version)
  }

  detectInstalled(root: string): Promise<InstalledVersion[]> {
    return scanInstalled(root, this.id)
  }
}

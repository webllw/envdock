/**
 * Go Provider：消费 go.dev 官方下载索引。
 *
 * include=all 会返回全部历史版本，默认只返回最新两条；这里取全量后
 * 按 major.minor 主线收敛，每条主线只保留最新的稳定版。索引自带
 * Windows x64 zip 的 sha256，安装阶段直接复用列表阶段缓存的下载地址。
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
import { keepLatestPerLine, makeActivationPlan, makeDeactivationPlan, mirrorUrls } from './common'
import {
  detectInstalled as scanInstalled,
  extractZip,
  writeVersionMetadata
} from './runtime'

const DEFAULT_BASE_URL = 'https://go.dev/dl'

interface GoFile {
  filename?: string
  os?: string
  arch?: string
  sha256?: string
  kind?: string
}

interface GoRelease {
  version?: string
  stable?: boolean
  files?: GoFile[]
}

/** 列表阶段缓存的下载地址与校验和 */
interface ResolvedArchive {
  url: string
  checksum: string
}

/** 挑选 Windows x64 的 zip 归档，跳过安装包与其他架构 */
function pickWindowsZip(release: GoRelease): GoFile | null {
  for (const file of release.files ?? []) {
    if (file.os !== 'windows' || file.arch !== 'amd64') continue
    if (file.kind !== 'archive') continue
    if (!file.filename?.endsWith('.zip')) continue
    return file
  }
  return null
}

/** 展示号去掉 go 前缀，例如 go1.27.4 显示为 1.27.4 */
function displayOf(version: string): string {
  return version.replace(/^go/i, '')
}

export class GoProvider implements ToolProvider {
  readonly id = 'go' as const
  readonly displayName = toolMeta('go').displayName
  readonly accent = toolMeta('go').accent

  private readonly archiveCache = new Map<string, ResolvedArchive>()

  constructor(private readonly config: AppConfig) {}

  /** 官方下载目录地址，固定取内置源，不带尾斜杠 */
  private baseUrl(): string {
    return (activeSource(this.id) ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  async listVersions(): Promise<VersionInfo[]> {
    const base = this.baseUrl()
    const data = await fetchJson<GoRelease[]>(`${base}/?mode=json&include=all`)
    if (!Array.isArray(data)) return []

    const versions: VersionInfo[] = []
    for (const release of data) {
      if (!release.version || release.stable !== true) continue
      const file = pickWindowsZip(release)
      if (!file?.filename || !file.sha256) continue
      this.archiveCache.set(release.version, {
        url: `${base}/${file.filename}`,
        checksum: file.sha256
      })
      versions.push({
        id: release.version,
        display: displayOf(release.version),
        channel: 'stable',
        releasedAt: ''
      })
    }

    // Go 索引不含发行日期，主线按 major.minor 划分，如 1.27
    return keepLatestPerLine(versions, (version) => version.display.split('.').slice(0, 2).join('.'))
  }

  async resolveDownload(version: VersionInfo): Promise<DownloadPlan> {
    let resolved = this.archiveCache.get(version.id)
    if (!resolved) {
      await this.listVersions()
      resolved = this.archiveCache.get(version.id)
    }
    if (!resolved) {
      throw new Error(`无法从 go.dev 解析 ${version.display} 的下载地址或校验和`)
    }

    const fileName = resolved.url.split('/').pop() ?? `go${version.id}.windows-amd64.zip`
    const mirrored = mirrorUrls(resolved.url, this.config, () => null)
    return {
      url: mirrored.primary,
      fallbackUrls: mirrored.fallbacks,
      fileName,
      checksum: resolved.checksum,
      checksumAlgorithm: 'sha256'
    }
  }

  activate(version: VersionInfo) {
    const relativeDir = `runtimes/go/${version.id}`
    return makeActivationPlan(this.id, version, relativeDir, {
      GOROOT: relativeDir
    })
  }

  deactivate() {
    return makeDeactivationPlan(this.id, 'runtimes/go')
  }

  async install(version: VersionInfo, archive: string, targetDir: string): Promise<void> {
    // Go 的 zip 顶层是单个 go/ 目录，去掉这一层让 bin 位置稳定
    await extractZip(archive, targetDir, true)
    await writeVersionMetadata(targetDir, version)
  }

  detectInstalled(root: string): Promise<InstalledVersion[]> {
    return scanInstalled(root, this.id)
  }
}

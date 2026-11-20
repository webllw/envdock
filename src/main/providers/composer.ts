/**
 * Composer Provider：消费 getcomposer.org 官方版本接口。
 *
 * Composer 的发行物是单个 composer.phar，而不是解压目录。版本接口只提供
 * 下载地址与最低 PHP 版本，校验和需另行读取同路径的 .sha256sum 文件。
 * 本 provider 作为 PHP 的内部附属工具注册，不进入工具卡片与 IPC 用户入口。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DownloadPlan,
  InstalledVersion,
  ToolProvider,
  VersionInfo
} from '@shared/domain'
import { INTERNAL_TOOL_META } from '@shared/tools'
import { requestFetch } from '@main/core/net'
import { fetchJson } from './http'
import { activeSource } from './sources'
import { compareVersionIds, makeActivationPlan, makeDeactivationPlan } from './common'
import {
  detectInstalled as scanInstalled,
  installSingleFile,
  writeVersionMetadata
} from './runtime'

const DEFAULT_BASE = 'https://getcomposer.org'

interface ComposerRelease {
  path: string
  version: string
  'min-php'?: number
  lts?: boolean
  eol?: boolean
}

interface ComposerFeed {
  stable?: ComposerRelease[]
}

/** 官方 launcher，php 从 PATH 解析，切换 PHP 后自动跟随当前激活版本 */
const LAUNCHER = '@php "%~dp0composer.phar" %*\r\n'

/** 把 PHP 版本号编码为可比较整数，例如 8.3.12 -> 80312 */
export function parsePhpVersionNumber(versionId: string): number | null {
  const parts = (versionId.match(/\d+/g) ?? []).map(Number).slice(0, 3)
  if (parts.length === 0) return null
  return (parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0)
}

/**
 * 按 PHP 版本挑选兼容的最新 Composer。
 *
 * versions 需已按版本降序；phpVersionId 无法解析时取最新。均不兼容时返回 null，
 * 让调用方告警而不是装一个跑不起来的版本。纯函数，便于无网络验证。
 */
export function pickCompatibleVersion(
  versions: VersionInfo[],
  minPhpById: Map<string, number>,
  phpVersionId: string
): VersionInfo | null {
  if (versions.length === 0) return null
  const php = parsePhpVersionNumber(phpVersionId)
  if (php === null) return versions[0]
  return versions.find((item) => (minPhpById.get(item.id) ?? 0) <= php) ?? null
}

export class ComposerProvider implements ToolProvider {
  readonly id = 'composer' as const
  readonly displayName = INTERNAL_TOOL_META.displayName
  readonly accent = INTERNAL_TOOL_META.accent

  /** 列表阶段缓存每个版本的下载地址与最低 PHP 版本，安装阶段直接复用 */
  private readonly pathById = new Map<string, string>()
  private readonly minPhpById = new Map<string, number>()

  private baseUrl(): string {
    return (activeSource(this.id) ?? DEFAULT_BASE).replace(/\/+$/, '')
  }

  private async catalog(): Promise<VersionInfo[]> {
    const feed = await fetchJson<ComposerFeed>(`${this.baseUrl()}/versions`)
    const stable = Array.isArray(feed?.stable) ? feed.stable : []
    const versions = stable
      .filter((item) => item && item.version && item.path && !item.eol)
      .map<VersionInfo>((item) => {
        this.pathById.set(item.version, item.path)
        this.minPhpById.set(item.version, item['min-php'] ?? 0)
        return {
          id: item.version,
          display: item.version,
          channel: item.lts ? 'lts' : 'stable',
          releasedAt: ''
        }
      })
      .sort((a, b) => compareVersionIds(b.id, a.id))
    return versions
  }

  async listVersions(): Promise<VersionInfo[]> {
    return this.catalog()
  }

  /**
   * 挑选与给定 PHP 版本兼容的最新 Composer。
   * PHP 版本无法解析时返回最新稳定版，由运行时自行决定是否可用。
   */
  async resolveForPhp(phpVersionId: string): Promise<VersionInfo | null> {
    const versions = await this.catalog()
    return pickCompatibleVersion(versions, this.minPhpById, phpVersionId)
  }

  /** 读取 .sha256sum 文件，只接受 64 位十六进制哈希 */
  private async fetchChecksum(sumUrl: string): Promise<string | null> {
    try {
      const response = await requestFetch(sumUrl, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return null
      const value = (await response.text()).trim().split(/\s+/)[0] ?? ''
      return /^[0-9a-f]{64}$/i.test(value) ? value : null
    } catch {
      return null
    }
  }

  async resolveDownload(version: VersionInfo): Promise<DownloadPlan> {
    let path = this.pathById.get(version.id)
    if (!path) {
      await this.catalog()
      path = this.pathById.get(version.id)
    }
    if (!path) throw new Error(`getcomposer.org 未提供 ${version.display} 的下载地址`)

    const base = this.baseUrl()
    const checksum = await this.fetchChecksum(`${base}${path}.sha256sum`)
    if (!checksum) throw new Error(`无法从 getcomposer.org 获取 ${version.display} 的 SHA-256 校验和`)

    return {
      url: `${base}${path}`,
      fileName: `composer-${version.id}.phar`,
      checksum,
      checksumAlgorithm: 'sha256'
    }
  }

  async install(version: VersionInfo, archive: string, targetDir: string): Promise<void> {
    await installSingleFile(archive, targetDir, 'composer.phar')
    // 官方手册的 Windows launcher：php 由 PATH 解析，随当前激活的 PHP 切换
    await writeFile(join(targetDir, 'composer.cmd'), LAUNCHER, 'utf8')
    await writeVersionMetadata(targetDir, version)
  }

  activate(version: VersionInfo) {
    const relativeDir = `runtimes/composer/${version.id}`
    return makeActivationPlan(this.id, version, relativeDir, {}, '')
  }

  deactivate() {
    return makeDeactivationPlan(this.id, 'runtimes/composer')
  }

  detectInstalled(root: string): Promise<InstalledVersion[]> {
    return scanInstalled(root, this.id)
  }
}

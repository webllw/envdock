/**
 * Node.js Provider：消费nodejs.org 官方 dist 索引。
 *
 * 索引列出全部版本但不带校验和，Windows x64 zip 的 sha256 需按版本
 * 读取同目录下的 SHASUMS256.txt。版本按 major 主线收敛，每条主线只
 * 保留最新的发行版；lts 字段有值时标记为 lts，奇数 major 标记为 preview。
 */
import type {
  AppConfig,
  DownloadPlan,
  InstalledVersion,
  ToolProvider,
  VersionInfo
} from '@shared/domain'
import { toolMeta } from '@shared/tools'
import { fetchJson, fetchText } from './http'
import { activeSource } from './sources'
import { keepLatestPerLine, makeActivationPlan, makeDeactivationPlan, mirrorUrls } from './common'
import {
  detectInstalled as scanInstalled,
  extractZip,
  writeVersionMetadata
} from './runtime'

const DEFAULT_BASE_URL = 'https://nodejs.org/dist'

interface NodeRelease {
  version?: string
  date?: string
  lts?: string | false
  files?: string[]
}

/** 只接受正式的 vX.Y.Z 版本，跳过 alpha/beta/rc 与 nightly */
const FORMAL_VERSION = /^v\d+\.\d+\.\d+$/

export class NodeProvider implements ToolProvider {
  readonly id = 'node' as const
  readonly displayName = toolMeta('node').displayName
  readonly accent = toolMeta('node').accent

  constructor(private readonly config: AppConfig) {}

  /** 官方 dist 根目录，固定取内置源，不带尾斜杠 */
  private baseUrl(): string {
    return (activeSource(this.id) ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private fileNameOf(version: string): string {
    return `node-${version}-win-x64.zip`
  }

  /**
   * 从 SHASUMS256.txt 读取 zip 的校验和。
   * 校验文件是官方对每个发行版签发的明文清单，逐行匹配目标文件名。
   */
  private async checksumOf(version: string): Promise<string> {
    const base = this.baseUrl()
    const text = await fetchText(`${base}/${version}/SHASUMS256.txt`)
    if (!text) return ''
    const target = this.fileNameOf(version)
    for (const line of text.split(/\r?\n/)) {
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim())
      if (match && match[2].trim() === target) return match[1].toLowerCase()
    }
    return ''
  }

  async listVersions(): Promise<VersionInfo[]> {
    const base = this.baseUrl()
    const data = await fetchJson<NodeRelease[]>(`${base}/index.json`)
    if (!Array.isArray(data)) return []

    const versions: VersionInfo[] = []
    for (const release of data) {
      const version = release.version
      if (!version || !FORMAL_VERSION.test(version)) continue
      // files 是平台标签数组，win-x64-zip 表示提供 Windows x64 解压包
      if (!release.files?.includes('win-x64-zip')) continue
      const major = Number(version.slice(1).split('.')[0])
      const channel: VersionInfo['channel'] = release.lts
        ? 'lts'
        : major % 2 === 1
          ? 'preview'
          : 'stable'
      versions.push({
        id: version,
        display: version.slice(1),
        channel,
        releasedAt: release.date ?? ''
      })
    }

    // 主线为 major，如 v26 只保留该 major 下最新的发行版
    return keepLatestPerLine(versions, (version) => version.id.split('.')[0])
  }

  async resolveDownload(version: VersionInfo): Promise<DownloadPlan> {
    const base = this.baseUrl()
    const fileName = this.fileNameOf(version.id)
    const officialUrl = `${base}/${version.id}/${fileName}`
    const checksum = await this.checksumOf(version.id)
    const mirrored = mirrorUrls(officialUrl, this.config, () => null)

    return {
      url: mirrored.primary,
      fallbackUrls: mirrored.fallbacks,
      fileName,
      checksum,
      checksumAlgorithm: 'sha256'
    }
  }

  activate(version: VersionInfo) {
    const relativeDir = `runtimes/node/${version.id}`
    // 全局 npm 前缀与缓存由 core/env.ts 按主版本计算并写入注册表，
    // 这里只保留 HOME 变量以满足 provider 契约；Node 可执行文件在版本根目录。
    return makeActivationPlan(this.id, version, relativeDir, {
      NODE_HOME: relativeDir
    }, '')
  }

  deactivate() {
    return makeDeactivationPlan(this.id, 'runtimes/node')
  }

  async install(version: VersionInfo, archive: string, targetDir: string): Promise<void> {
    // 官方 zip 顶层是单个 node-vX-win-x64/ 目录，去掉这一层
    await extractZip(archive, targetDir, true)
    await writeVersionMetadata(targetDir, version)
  }

  detectInstalled(root: string): Promise<InstalledVersion[]> {
    return scanInstalled(root, this.id)
  }
}

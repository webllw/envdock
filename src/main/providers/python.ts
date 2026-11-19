/**
 * Python Provider：消费 python.org 官方下载页与 Windows release manifest。
 *
 * python.org 没有版本列表 JSON API，版本与日期从官方 downloads/windows
 * 页面解析；Windows 二进制官方不单独发布 sha256 文件，但每个版本目录
 * 下的 windows-<version>.json manifest 记录了完整运行版 zip 的 sha256，
 * 下载解析阶段读取该 manifest 获取地址与校验和。
 *
 * 选用完整运行版 amd64 zip 而非 embeddable：前者包含标准库与 pip，
 * 更符合开发用途；两者同在官方 manifest 中登记，来源一致。
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

const DEFAULT_BASE_URL = 'https://www.python.org/downloads/windows'
/** 官方 FTP 根，manifest 与 zip 都在这里；由 manifest 中的绝对 url 决定最终下载地址 */
const FTP_BASE = 'https://www.python.org/ftp/python'

interface PythonManifestEntry {
  id?: string
  url?: string
  hash?: { sha256?: string }
}

interface PythonManifest {
  versions?: PythonManifestEntry[]
}

/** 页面里的版本标题：Python 3.13.17 - Oct. 21, 2026 */
const VERSION_HEADING = /Python (\d+\.\d+\.\d+)\s*-\s*([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/g

/** 把 "Oct. 21, 2026" 转成 ISO 日期；无法解析时返回空串 */
function isoDate(raw: string): string {
  const cleaned = raw.replace(/\./g, '')
  const time = Date.parse(cleaned)
  return Number.isNaN(time) ? '' : new Date(time).toISOString().slice(0, 10)
}

export class PythonProvider implements ToolProvider {
  readonly id = 'python' as const
  readonly displayName = toolMeta('python').displayName
  readonly accent = toolMeta('python').accent

  constructor(private readonly config: AppConfig) {}

  /** 官方下载页地址，固定取内置源，不带尾斜杠 */
  private baseUrl(): string {
    return (activeSource(this.id) ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  async listVersions(): Promise<VersionInfo[]> {
    const html = await fetchText(this.baseUrl())
    if (!html) return []

    const seen = new Map<string, VersionInfo>()
    let match: RegExpExecArray | null
    VERSION_HEADING.lastIndex = 0
    while ((match = VERSION_HEADING.exec(html)) !== null) {
      const version = match[1]
      if (seen.has(version)) continue
      seen.set(version, {
        id: version,
        display: version,
        channel: 'stable',
        releasedAt: isoDate(match[2])
      })
    }

    // 主线为 major.minor，如 3.13 只保留该分支最新的补丁版本
    return keepLatestPerLine([...seen.values()], (version) => version.id.split('.').slice(0, 2).join('.'))
  }

  /**
   * 从版本 manifest 中挑出完整运行版 x64 zip。
   * id 形如 pythoncore-3.13-64，避开 embeddable / test / free-threaded 变体。
   */
  private async resolveFromManifest(version: string): Promise<DownloadPlan | null> {
    const manifestUrl = `${FTP_BASE}/${version}/windows-${version}.json`
    const manifest = await fetchJson<PythonManifest>(manifestUrl)
    const entry = manifest?.versions?.find(
      (item) => item.id === `pythoncore-${version.split('.').slice(0, 2).join('.')}-64`
    )
    if (!entry?.url || !entry.hash?.sha256) return null

    const fileName = entry.url.split('/').pop() ?? `python-${version}-amd64.zip`
    const mirrored = mirrorUrls(entry.url, this.config, () => null)
    return {
      url: mirrored.primary,
      fallbackUrls: mirrored.fallbacks,
      fileName,
      checksum: entry.hash.sha256,
      checksumAlgorithm: 'sha256'
    }
  }

  async resolveDownload(version: VersionInfo): Promise<DownloadPlan> {
    const plan = await this.resolveFromManifest(version.id)
    if (!plan) {
      throw new Error(`无法从 python.org manifest 解析 ${version.display} 的完整运行版 zip`)
    }
    return plan
  }

  activate(version: VersionInfo) {
    const relativeDir = `runtimes/python/${version.id}`
    // 完整运行版 zip 为平铺结构，python.exe 位于版本根目录，无 bin 子目录
    return makeActivationPlan(this.id, version, relativeDir, {
      // Python 官方识别 PYTHONHOME（无下划线）；垫片与激活脚本据此定位标准库
      PYTHONHOME: relativeDir
    }, '')
  }

  deactivate() {
    return makeDeactivationPlan(this.id, 'runtimes/python')
  }

  async install(version: VersionInfo, archive: string, targetDir: string): Promise<void> {
    // 官方 zip 为平铺结构，python.exe 与 Lib/ 直接在根目录，不能按单顶层目录剥离
    await extractZip(archive, targetDir, false)
    await writeVersionMetadata(targetDir, version)
  }

  detectInstalled(root: string): Promise<InstalledVersion[]> {
    return scanInstalled(root, this.id)
  }
}

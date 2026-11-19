/**
 * Java Provider：消费 Eclipse Adoptium 官方 API 获取 Temurin JDK。
 *
 * 版本 id 采用完整 semver（含 build，例如 21.0.13+9.0.LTS），避免同一
 * 版本号不同构建的歧义。列表来自 feature_releases 端点，可按主线返回
 * 全部 GA 版本；该响应同时携带下载链接与校验和，缓存后供安装阶段使用，
 * 无需再调用已变更行为的 assets/version 端点。
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

const DEFAULT_API_BASE = 'https://api.adoptium.net/v3'
/** 提供 GA 构建的主线版本；覆盖全部仍可下载的 Temurin 分支 */
const FEATURES = [8, 11, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]
const LTS_FEATURES = new Set([8, 11, 17, 21, 25])

interface AdoptiumPackage {
  link?: string
  checksum?: string
  size?: number
}

interface AdoptiumBinary {
  architecture?: string
  image_type?: string
  os?: string
  jvm_impl?: string
  package?: AdoptiumPackage
}

interface AdoptiumRelease {
  timestamp?: string
  updated_at?: string
  release_type?: string
  version_data?: {
    semver?: string
    major?: number
    optional?: string
  }
  binaries?: AdoptiumBinary[]
}

/** 列表阶段解析出的下载地址，安装阶段直接复用，避免重复请求失效端点 */
interface ResolvedPackage {
  url: string
  checksum: string
}

/** 挑选 Windows x64 的 JDK zip，跳过 JRE 与其他架构 */
function pickJdkZip(release: AdoptiumRelease): AdoptiumPackage | null {
  for (const binary of release.binaries ?? []) {
    const link = binary.package?.link
    if (!link?.endsWith('.zip')) continue
    if (binary.os !== 'windows' || binary.architecture !== 'x64') continue
    if (binary.image_type !== 'jdk') continue
    return binary.package ?? null
  }
  return null
}

/** 展示号保留 build，避免同一版本号的不同构建显示为重复项 */
function displayOf(semver: string): string {
  const [version, build] = semver.split('+')
  return build ? `${version}+${build.split('.')[0]}` : version
}

function toVersionInfo(release: AdoptiumRelease, feature: number): VersionInfo | null {
  const semver = release.version_data?.semver
  if (!semver) return null
  return {
    id: semver,
    display: displayOf(semver),
    channel: LTS_FEATURES.has(feature) || release.version_data?.optional === 'LTS' ? 'lts' : 'stable',
    releasedAt: release.timestamp ?? release.updated_at ?? ''
  }
}

export class JavaProvider implements ToolProvider {
  readonly id = 'java' as const
  readonly displayName = toolMeta('java').displayName
  readonly accent = toolMeta('java').accent

  private readonly packageCache = new Map<string, ResolvedPackage>()

  constructor(private readonly config: AppConfig) {}

  /** 版本列表 API 根地址，固定取内置官方源，不带 trailing slash */
  private apiBase(): string {
    return (activeSource(this.id) ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  }

  /**
   * 列出可下载的 GA 版本。
   * 每条 feature 主线单独请求，失败的主线跳过，不影响其他版本展示。
   * 下载链接与校验和随列表返回，按版本 id 缓存；收敛只影响展示，
   * 缓存保留全部条目，确保被跳过版本仍能解析下载地址。
   */
  async listVersions(): Promise<VersionInfo[]> {
    const base = this.apiBase()
    const results = await Promise.all(
      FEATURES.map(async (feature) => {
        const url = `${base}/assets/feature_releases/${feature}/ga?architecture=x64&image_type=jdk&os=windows&vendor=eclipse&page_size=50&sort_method=DEFAULT&sort_order=DESC`
        const data = await fetchJson<AdoptiumRelease[]>(url)
        if (!Array.isArray(data)) return [] as VersionInfo[]
        return data.flatMap((release) => {
          const version = toVersionInfo(release, feature)
          if (!version) return []
          const pkg = pickJdkZip(release)
          if (pkg?.link && pkg.checksum) {
            this.packageCache.set(version.id, { url: pkg.link, checksum: pkg.checksum })
          }
          return [version]
        })
      })
    )
    const merged = new Map<string, VersionInfo>()
    for (const item of results.flat()) merged.set(item.id, item)
    // 主线为 major.minor，例如 18.0 下的 18.0.2+101 / 18.0.1+10 只保留最大版本
    return keepLatestPerLine([...merged.values()], (version) =>
      version.display.split('+')[0].split('.').slice(0, 2).join('.')
    )
  }

  async resolveDownload(version: VersionInfo): Promise<DownloadPlan> {
    let resolved = this.packageCache.get(version.id)
    if (!resolved) {
      await this.listVersions()
      resolved = this.packageCache.get(version.id)
    }
    if (!resolved) {
      throw new Error(`无法从 Adoptium 解析 ${version.display} 的下载地址或校验和`)
    }

    const feature = Number(version.display.split('.')[0])
    const fileName = resolved.url.split('/').pop() ?? `temurin-${version.id}.zip`
    const mirrored = mirrorUrls(resolved.url, this.config, (mirror) => {
      if (mirror === 'tsinghua') {
        return `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${feature}/jdk/x64/windows/${fileName}`
      }
      return null
    })

    return {
      url: mirrored.primary,
      fallbackUrls: mirrored.fallbacks,
      fileName,
      checksum: resolved.checksum,
      checksumAlgorithm: 'sha256'
    }
  }

  activate(version: VersionInfo) {
    const relativeDir = `runtimes/java/${version.id}`
    return makeActivationPlan(this.id, version, relativeDir, {
      JAVA_HOME: relativeDir
    })
  }

  deactivate() {
    return makeDeactivationPlan(this.id, 'runtimes/java')
  }

  async install(version: VersionInfo, archive: string, targetDir: string): Promise<void> {
    await extractZip(archive, targetDir, true)
    await writeVersionMetadata(targetDir, version)
  }

  detectInstalled(root: string): Promise<InstalledVersion[]> {
    return scanInstalled(root, this.id)
  }
}

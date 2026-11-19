/**
 * Maven Provider：消费 Maven Central 官方仓库的发行包。
 *
 * 版本清单来自 apache-maven 的 maven-metadata.xml，逐个 version 解析；
 * 下载包与 SHA-512 校验文件放在同一版本的目录下，地址可由版本号推导。
 * Maven Central 只为较新的发行提供 .sha512，列表阶段会探测校验文件，
 * 没有校验和的版本不展示，避免用户选中后安装失败。
 */
import type {
  DownloadPlan,
  InstalledVersion,
  ToolProvider,
  VersionInfo
} from '@shared/domain'
import { toolMeta } from '@shared/tools'
import { requestFetch } from '@main/core/net'
import { fetchText } from './http'
import { activeSource } from './sources'
import { makeActivationPlan, makeDeactivationPlan } from './common'
import {
  detectInstalled as scanInstalled,
  extractZip,
  writeVersionMetadata
} from './runtime'

const DEFAULT_REPO_BASE = 'https://repo.maven.apache.org/maven2'
const ARTIFACT_PATH = 'org/apache/maven/apache-maven'

/** 预览阶段的优先级，数值越大越接近正式版 */
const STAGE_WEIGHT: Record<string, number> = { m: 1, alpha: 2, beta: 3, rc: 4 }
const STABLE_WEIGHT = 5

/** 从 metadata.xml 的 versioning/versions 段提取全部版本号 */
function parseVersions(xml: string): string[] {
  const block = xml.match(/<versions>([\s\S]*?)<\/versions>/i)
  if (!block) return []
  return [...block[1].matchAll(/<version>([^<]+)<\/version>/gi)].map((item) => item[1].trim())
}

interface ParsedVersion {
  /** 版本主体数字，例如 4.0.0 */
  core: number[]
  /** 预览阶段；正式版为 null */
  stage: string | null
  /** 预览阶段序号，例如 rc-7 中的 7 */
  stageNumber: number
}

function parseVersion(version: string): ParsedVersion {
  const [coreText, ...suffix] = version.split('-')
  const core = (coreText.match(/\d+/g) ?? []).map(Number)
  const stageToken = suffix.join('-').toLowerCase()
  const stageMatch = stageToken.match(/^(alpha|beta|rc|m)[.-]?(\d*)/)
  return {
    core,
    stage: stageMatch ? stageMatch[1] : null,
    stageNumber: stageMatch?.[2] ? Number(stageMatch[2]) : 0
  }
}

/** 预览标记：带 alpha/beta/rc/m 阶段的一律不是稳定版 */
function isPreview(version: string): boolean {
  return parseVersion(version).stage !== null
}

/**
 * Maven 版本比较：先比主体数字，再比预览阶段（正式版最高），最后比阶段序号。
 * 通用的 compareVersionIds 会把 alpha-13 排在 rc-7 之前，这里必须按语义修正。
 */
function compareMavenVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (diff !== 0) return diff
  }
  const leftStage = left.stage ? STAGE_WEIGHT[left.stage] ?? 0 : STABLE_WEIGHT
  const rightStage = right.stage ? STAGE_WEIGHT[right.stage] ?? 0 : STABLE_WEIGHT
  if (leftStage !== rightStage) return leftStage - rightStage
  return left.stageNumber - right.stageNumber
}

/** 每条主线只保留最新版本；主线粒度为 major.minor */
function keepLatestStablePerLine(versions: VersionInfo[]): VersionInfo[] {
  const latest = new Map<string, VersionInfo>()
  for (const version of versions) {
    const key = version.id.split('.').slice(0, 2).join('.')
    const current = latest.get(key)
    if (!current || compareMavenVersions(version.id, current.id) > 0) {
      latest.set(key, version)
    }
  }
  return [...latest.values()].sort((a, b) => compareMavenVersions(b.id, a.id))
}

export class MavenProvider implements ToolProvider {
  readonly id = 'maven' as const
  readonly displayName = toolMeta('maven').displayName
  readonly accent = toolMeta('maven').accent

  /** 列表阶段探测到的校验和，供安装阶段直接复用 */
  private readonly checksumCache = new Map<string, string>()

  /** 官方仓库根地址，固定取内置源，不带 trailing slash */
  private repoBase(): string {
    return (activeSource(this.id) ?? DEFAULT_REPO_BASE).replace(/\/+$/, '')
  }

  /** 某版本的产物目录地址 */
  private artifactUrl(version: string): string {
    return `${this.repoBase()}/${ARTIFACT_PATH}/${version}`
  }

  /** 探测并读取校验文件；缺失或格式非法时返回 null */
  private async fetchChecksum(version: string): Promise<string | null> {
    const url = `${this.artifactUrl(version)}/apache-maven-${version}-bin.zip.sha512`
    try {
      const response = await requestFetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return null
      const value = (await response.text()).trim().split(/\s+/)[0] ?? ''
      return /^[0-9a-f]{128}$/i.test(value) ? value : null
    } catch {
      return null
    }
  }

  async listVersions(): Promise<VersionInfo[]> {
    const xml = await fetchText(`${this.repoBase()}/${ARTIFACT_PATH}/maven-metadata.xml`)
    if (!xml) return []

    const versions = parseVersions(xml).map<VersionInfo>((version) => ({
      id: version,
      display: version,
      channel: isPreview(version) ? 'preview' : 'stable',
      // Maven Central 的 metadata 不含发布日期，留空避免使用推测值
      releasedAt: ''
    }))

    // 收敛后再探测校验和，把请求数压到每条主线一次
    const candidates = keepLatestStablePerLine(versions)
    const checked = await Promise.all(
      candidates.map(async (version) => {
        const checksum = await this.fetchChecksum(version.id)
        if (!checksum) return null
        this.checksumCache.set(version.id, checksum)
        return version
      })
    )
    return checked.filter((item): item is VersionInfo => item !== null)
  }

  async resolveDownload(version: VersionInfo): Promise<DownloadPlan> {
    const base = this.artifactUrl(version.id)
    const fileName = `apache-maven-${version.id}-bin.zip`
    let checksum = this.checksumCache.get(version.id)
    if (!checksum) {
      const fetched = await this.fetchChecksum(version.id)
      if (!fetched) throw new Error(`无法从 Maven Central 获取 ${version.display} 的 SHA-512 校验和`)
      checksum = fetched
      this.checksumCache.set(version.id, checksum)
    }

    return {
      url: `${base}/${fileName}`,
      fileName,
      checksum,
      checksumAlgorithm: 'sha512'
    }
  }

  activate(version: VersionInfo) {
    const relativeDir = `runtimes/maven/${version.id}`
    return makeActivationPlan(this.id, version, relativeDir, {
      MAVEN_HOME: relativeDir
    })
  }

  deactivate() {
    return makeDeactivationPlan(this.id, 'runtimes/maven')
  }

  async install(version: VersionInfo, archive: string, targetDir: string): Promise<void> {
    await extractZip(archive, targetDir, true)
    await writeVersionMetadata(targetDir, version)
  }

  detectInstalled(root: string): Promise<InstalledVersion[]> {
    return scanInstalled(root, this.id)
  }
}

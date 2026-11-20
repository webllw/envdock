/**
 * Provider 共用的安装落盘与本地版本探测逻辑。
 *
 * 每个版本目录写入一份 .envdock-version.json，记录版本标识与安装时间；
 * detectInstalled 依据这份元数据重建已安装列表，不依赖内存状态，
 * 因此应用重启或目录整体迁移后仍能正确识别。
 */
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { InstalledVersion, ToolId, VersionInfo } from '@shared/domain'

const METADATA_FILE = '.envdock-version.json'

interface VersionMetadata {
  versionId: string
  display: string
  installedAt: string
}

/** 递归统计目录字节数 */
export async function dirSize(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          /* 遍历期间文件可能消失 */
        }
      }
    }
  }
  await walk(dir)
  return total
}

/**
 * 解压 zip 到目标目录。
 *
 * Adoptium 的 zip 顶层是单个 jdk-x/ 目录，PHP 的 zip 直接是文件。
 * flattenSingleRoot 为真时会自动去掉这一层，使 bin 目录位置稳定。
 */
export async function extractZip(
  archive: string,
  targetDir: string,
  flattenSingleRoot: boolean
): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  const zip = new AdmZip(archive)
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory && !entry.entryName.endsWith('/'))
  const rootCandidates = new Set(
    entries.map((entry) => entry.entryName.replace(/\\/g, '/').split('/')[0])
  )
  // 顶层目录判定：所有条目都位于同一个根目录下，且没有任何文件散落在根之外
  const singleRoot = flattenSingleRoot && entries.length > 0 && rootCandidates.size === 1

  const stagingDir = `${targetDir}.staging`
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  for (const entry of entries) {
    // ZipSlip 防护：拒绝任何逃逸出暂存目录的路径
    const normalized = entry.entryName.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) continue

    const parts = normalized.split('/').filter(Boolean)
    const relative = singleRoot ? parts.slice(1).join('/') : parts.join('/')
    if (!relative) continue

    const dest = join(stagingDir, relative)
    await mkdir(join(dest, '..'), { recursive: true })
    await writeFile(dest, entry.getData())
  }

  await rm(targetDir, { recursive: true, force: true })
  await rename(stagingDir, targetDir)
}

/**
 * 安装单文件运行时（PHP phar 归档）。
 *
 * Composer 的官方发行物是一个 composer.phar，不需要解压。缓存文件名带版本，
 * 落盘时统一改回 composer.phar，使各版本目录内路径一致、垫片可稳定引用。
 */
export async function installSingleFile(
  archive: string,
  targetDir: string,
  fileName: string
): Promise<void> {
  const stagingDir = `${targetDir}.staging`
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  await copyFile(archive, join(stagingDir, fileName))
  await rm(targetDir, { recursive: true, force: true })
  await rename(stagingDir, targetDir)
}

/** 写入版本元数据，放在安装完成、目录就绪之后 */
export async function writeVersionMetadata(
  targetDir: string,
  version: VersionInfo
): Promise<void> {
  const metadata: VersionMetadata = {
    versionId: version.id,
    display: version.display,
    installedAt: new Date().toISOString()
  }
  await writeFile(join(targetDir, METADATA_FILE), JSON.stringify(metadata, null, 2), 'utf8')
}

/** 扫描某个工具的运行时目录，重建已安装版本列表 */
export async function detectInstalled(
  root: string,
  toolId: ToolId
): Promise<InstalledVersion[]> {
  const runtimeRoot = join(root, 'runtimes', toolId)
  if (!existsSync(runtimeRoot)) return []

  const entries = await readdir(runtimeRoot, { withFileTypes: true })
  const result: InstalledVersion[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(runtimeRoot, entry.name)
    const metadataFile = join(dir, METADATA_FILE)
    let metadata: VersionMetadata
    try {
      metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as VersionMetadata
    } catch {
      // 无元数据的目录视为外部放入，跳过，避免误报
      continue
    }
    result.push({
      versionId: metadata.versionId || entry.name,
      display: metadata.display || basename(entry.name),
      relativePath: `runtimes/${toolId}/${entry.name}`,
      sizeBytes: await dirSize(dir),
      installedAt: metadata.installedAt
    })
  }

  return result.sort((a, b) => b.installedAt.localeCompare(a.installedAt))
}

/** 删除版本目录，损坏或不存在的目录按成功处理 */
export async function removeVersionDir(root: string, toolId: ToolId, versionId: string): Promise<void> {
  await rm(join(root, 'runtimes', toolId, versionId), { recursive: true, force: true })
}

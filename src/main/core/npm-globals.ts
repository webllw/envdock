/**
 * npm 全局目录的版本隔离。
 *
 * PATH 中只保留一个稳定的入口目录，实际内容按 Node 主版本存放在 siblings
 * store 中。切换版本时重建入口 junction，避免复制全局包，也避免把不兼容的
 * CLI 从一个 Node 版本带到另一个版本。
 */
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { NPM_GLOBAL_DIR, npmGlobalDir } from './paths'

/** 全局目录每次同步的结果，changed 表示 junction 目标被重建 */
export interface NpmGlobalSyncResult {
  bucket: string
  changed: boolean
  target: string
}

/** 从 Node 版本标识提取主版本，无法识别时归入 system */
export function npmBucketName(versionId: string | null | undefined): string {
  if (!versionId) return 'system'
  const withoutPrefix = versionId.replace(/^[A-Za-z]+/, '')
  const major = Number.parseInt(withoutPrefix.split('.')[0], 10)
  return Number.isFinite(major) && major > 0 ? `node${major}` : 'system'
}

/** 由固定入口推导同级的版本仓库路径，避免仓库落到 junction 自身内部 */
export function npmGlobalStoreDir(root: string): string {
  return join(resolve(root), dirname(NPM_GLOBAL_DIR), `${basename(NPM_GLOBAL_DIR)}-store`)
}

/** 某个 Node 版本对应的实际全局目录 */
export function npmGlobalTargetDir(root: string, versionId: string | null | undefined): string {
  return join(npmGlobalStoreDir(root), npmBucketName(versionId))
}

function normalizeLinkTarget(value: string, from: string): string {
  const cleaned = value.startsWith('\\\\?\\') ? value.slice(4) : value
  const absolute = isAbsolute(cleaned) ? cleaned : join(dirname(from), cleaned)
  return resolve(absolute).toLowerCase()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}

/** 删除 junction 本身；短暂占用时重试，不触碰链接指向的目录内容 */
async function removeJunctionRobust(path: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await unlink(path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (!code || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw error
      await delay(25 * 2 ** attempt)
    }
  }
  throw new Error(`npm 全局目录入口被占用，无法切换：${path}`)
}

/** 旧版真实目录迁移到版本仓库；目标非空时保留为带时间戳的 legacy 目录 */
async function migrateLegacyDirectory(
  activeDir: string,
  targetDir: string,
  storeDir: string,
  bucket: string
): Promise<void> {
  const existing = await readdir(targetDir).catch(() => [])
  if (existing.length === 0) {
    await rmdir(targetDir).catch(() => undefined)
    await rename(activeDir, targetDir)
    return
  }
  await rename(activeDir, join(storeDir, `${bucket}-legacy-${Date.now()}`))
}

/**
 * 把稳定入口指向当前 Node 主版本的全局目录。
 *
 * 没有激活 Node 时保留现有指针，避免系统 npm 的全局安装被意外切到空目录。
 */
export async function syncNpmGlobalTarget(
  root: string,
  versionId: string | null | undefined
): Promise<NpmGlobalSyncResult> {
  if (!versionId) {
    return {
      bucket: 'system',
      changed: false,
      target: npmGlobalTargetDir(root, null)
    }
  }

  const activeDir = npmGlobalDir(root)
  const storeDir = npmGlobalStoreDir(root)
  const bucket = npmBucketName(versionId)
  const target = join(storeDir, bucket)

  await mkdir(storeDir, { recursive: true })
  await mkdir(target, { recursive: true })
  await mkdir(join(target, 'cache'), { recursive: true })

  const entry = await lstat(activeDir).catch(() => null)
  if (entry?.isSymbolicLink()) {
    const current = await readlink(activeDir)
    if (normalizeLinkTarget(current, activeDir) === normalizeLinkTarget(target, activeDir)) {
      return { bucket, changed: false, target }
    }
    await removeJunctionRobust(activeDir)
  } else if (entry?.isDirectory()) {
    await migrateLegacyDirectory(activeDir, target, storeDir, bucket)
  } else if (entry) {
    throw new Error(`npm 全局目录入口不是目录，无法切换：${activeDir}`)
  }

  await symlink(target, activeDir, 'junction')
  return { bucket, changed: true, target }
}

/**
 * 删除已无 Node 版本引用的全局包 bucket。
 *
 * 全局包按主版本隔离，同一主版本下的多个小版本共用一份 bucket，因此按删除后
 * 仍在的版本重算所需 bucket，只清理不再需要的那一份，避免误删其他版本的全局
 * 命令。删除前若入口 junction 正指向它，先摘掉指针，防止入口悬空。
 * 返回被删除的 bucket 名列表。
 */
export async function pruneNpmGlobalBuckets(
  root: string,
  remainingVersionIds: string[]
): Promise<string[]> {
  const keep = new Set(remainingVersionIds.map((id) => npmBucketName(id)))
  const entry = await lstat(npmGlobalDir(root)).catch(() => null)
  const entryTarget = entry?.isSymbolicLink()
    ? normalizeLinkTarget(await readlink(npmGlobalDir(root)), npmGlobalDir(root))
    : null

  const removed: string[] = []
  for (const item of await readdir(npmGlobalStoreDir(root), { withFileTypes: true }).catch(() => [])) {
    // 只处理 node<N> 形式的 bucket；system、legacy 等非版本目录不纳入清理
    if (!item.isDirectory() || !/^node\d+$/.test(item.name) || keep.has(item.name)) continue
    const target = join(npmGlobalStoreDir(root), item.name)
    if (entryTarget && entryTarget === normalizeLinkTarget(target, npmGlobalDir(root))) {
      await removeJunctionRobust(npmGlobalDir(root))
    }
    await rm(target, { recursive: true, force: true })
    removed.push(item.name)
  }
  return removed
}

/**
 * 全局包目录的版本隔离。
 *
 * 全局包按语言主版本放在同级 store 中，切换版本时改写
 * npm_config_prefix / PYTHONUSERBASE 变量指向对应 bucket。全程不建指针、不复制
 * 包体：PATH 里引用这些变量，新启动的进程自然落到当前主版本的全局目录。
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolId } from '@shared/domain'

/** 全局仓库相对根目录的固定位置；入口变量的值都指向这里的具体 bucket */
export const NPM_STORE_DIR = 'global/npm-store'
export const PYTHON_STORE_DIR = 'global/python-user'

/** 从版本标识提取主版本，无法识别时归入 system */
export function npmBucketName(versionId: string | null | undefined): string {
  if (!versionId) return 'system'
  const withoutPrefix = versionId.replace(/^[A-Za-z]+/, '')
  const major = Number.parseInt(withoutPrefix.split('.')[0], 10)
  return Number.isFinite(major) && major > 0 ? `node${major}` : 'system'
}

/** Python 原生 wheel 按主次版本 ABI 隔离，例如 3.13.17 -> py313 */
export function pythonBucketName(versionId: string | null | undefined): string {
  if (!versionId) return 'system'
  const matched = versionId.match(/(\d+)\.(\d+)/)
  return matched ? `py${matched[1]}${matched[2]}` : 'system'
}

export function globalStoreDir(root: string, tool: 'node' | 'python'): string {
  return join(resolve(root), tool === 'node' ? NPM_STORE_DIR : PYTHON_STORE_DIR)
}

export function globalBucketDir(root: string, tool: 'node' | 'python', versionId: string): string {
  const name = tool === 'node' ? npmBucketName(versionId) : pythonBucketName(versionId)
  return join(globalStoreDir(root, tool), name)
}

/** 确保当前激活版本对应的全局 bucket 及其子目录存在 */
export async function ensureGlobalBuckets(
  root: string,
  activeVersions: Partial<Record<ToolId, string>>
): Promise<void> {
  await mkdir(globalStoreDir(root, 'node'), { recursive: true })
  await mkdir(globalStoreDir(root, 'python'), { recursive: true })
  if (activeVersions.node) {
    const bucket = globalBucketDir(root, 'node', activeVersions.node)
    await mkdir(join(bucket, 'cache'), { recursive: true })
  }
  if (activeVersions.python) {
    const bucket = globalBucketDir(root, 'python', activeVersions.python)
    await mkdir(join(bucket, 'Scripts'), { recursive: true })
  }
}

/**
 * 删除已无版本引用的全局 bucket。
 *
 * 同一主版本的多个小版本共用一份 bucket，按删除后仍在的版本重算所需集合，
 * 只清理不再引用的那份，避免误删其他版本的全局命令。
 */
export async function pruneGlobalBuckets(
  root: string,
  remainingByTool: Partial<Record<'node' | 'python', string[]>>
): Promise<string[]> {
  const removed: string[] = []
  for (const tool of ['node', 'python'] as const) {
    const store = globalStoreDir(root, tool)
    const keep = new Set((remainingByTool[tool] ?? []).map((id) =>
      tool === 'node' ? npmBucketName(id) : pythonBucketName(id)
    ))
    const pattern = tool === 'node' ? /^node\d+$/ : /^py\d+$/
    for (const item of await readdir(store, { withFileTypes: true }).catch(() => [])) {
      if (!item.isDirectory() || !pattern.test(item.name) || keep.has(item.name)) continue
      await rm(join(store, item.name), { recursive: true, force: true })
      removed.push(`${tool}:${item.name}`)
    }
  }
  return removed
}

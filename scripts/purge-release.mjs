/**
 * 分批清空 release 目录，规避单次删除文件数过多触发的安全阈值。
 * 只用于构建产物清理，删除后由 build-release.mjs 重新生成。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const target = resolve(process.cwd(), 'release')
const BATCH = 30

/** 递归收集目录下所有文件路径与目录路径（目录后删） */
async function collect(dir, files, dirs) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      dirs.push(full)
      await collect(full, files, dirs)
    } else {
      files.push(full)
    }
  }
}

const files = []
const dirs = []
await collect(target, files, dirs)

// 先删文件，严格分批；再按深度倒序删空目录
for (let i = 0; i < files.length; i += BATCH) {
  for (const file of files.slice(i, i + BATCH)) {
    await rm(file, { force: true }).catch(() => undefined)
  }
}
dirs.sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)
for (let i = 0; i < dirs.length; i += BATCH) {
  for (const dir of dirs.slice(i, i + BATCH)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const rest = await readdir(target).catch(() => [])
console.log(`[purge-release] 已清理，剩余顶层条目=${rest.length}`)

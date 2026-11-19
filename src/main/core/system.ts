/**
 * 系统级变更的最小实现：仅用户级 PATH。
 *
 * 所有写入都先记录原值到 manifest，再由卸载流程精确回滚。
 * 不写系统级 PATH、不写开始菜单快捷方式——这两类变更的收益不足以
 * 承担恢复复杂度，界面相应开关明确标注为未接线。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SystemMutation } from '@shared/domain'

const run = promisify(execFile)
const PATH_KEY = 'HKCU\\Environment'

function newId(): string {
  return `mut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 读取用户级 PATH；无该项时返回 null */
export async function readUserPath(): Promise<string | null> {
  try {
    const { stdout } = await run('reg', ['query', PATH_KEY, '/v', 'Path'], { windowsHide: true })
    const match = stdout.match(/REG_EXPAND_SZ\s+(.*)$/m) ?? stdout.match(/REG_SZ\s+(.*)$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

async function writeUserPath(value: string): Promise<void> {
  await run('reg', ['add', PATH_KEY, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], {
    windowsHide: true
  })
}

/** 把 PATH 条目加入用户级 PATH，返回可回滚记录；已存在则不产生变更 */
export async function addPathEntry(entry: string): Promise<SystemMutation | null> {
  const current = await readUserPath()
  if (current) {
    const parts = current.split(';').filter(Boolean)
    if (parts.some((part) => part.toLowerCase() === entry.toLowerCase())) return null
  }

  const next = current ? `${entry};${current}` : entry
  await writeUserPath(next)
  return {
    id: newId(),
    kind: 'path',
    target: `${PATH_KEY}\\Path`,
    previousValue: current,
    currentValue: next,
    createdAt: new Date().toISOString()
  }
}

/** 移除此前写入的 PATH 条目，返回可回滚记录 */
export async function removePathEntry(entry: string): Promise<SystemMutation | null> {
  const current = await readUserPath()
  if (!current) return null
  const parts = current.split(';').filter((part) => part.toLowerCase() !== entry.toLowerCase())
  const next = parts.join(';')
  if (next === current) return null
  await writeUserPath(next)
  return {
    id: newId(),
    kind: 'path',
    target: `${PATH_KEY}\\Path`,
    previousValue: current,
    currentValue: next,
    createdAt: new Date().toISOString()
  }
}

/**
 * 按清单回滚一条变更。
 * 新建项（previousValue 为 null）回滚时删除注册表值，而不是写空串。
 */
export async function rollbackMutation(mutation: SystemMutation): Promise<void> {
  if (mutation.kind !== 'path') return
  if (mutation.previousValue === null) {
    await run('reg', ['delete', PATH_KEY, '/v', 'Path', '/f'], { windowsHide: true }).catch(() => undefined)
    return
  }
  await writeUserPath(mutation.previousValue)
}

/** 检测 PATH 是否包含指定条目，大小写不敏感 */
export async function hasPathEntry(entry: string): Promise<boolean> {
  const current = await readUserPath()
  if (!current) return false
  return current.split(';').some((part) => part.toLowerCase() === entry.toLowerCase())
}

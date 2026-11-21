/**
 * 系统级变更的最小实现：仅用户级 PATH 与环境变量。
 *
 * 写入只登记 EnvDock 自己写出的条目（ownership），回滚时按 ownership 精确
 * 撤销：变量仍是 EnvDock 写的值才删除，PATH 只移除登记过的条目。不保存也不
 * 恢复用户原值——用户中途清理或改写过的环境必须保持原样。
 *
 * 不写系统级 PATH、不写开始菜单快捷方式——这两类变更的收益不足以
 * 承担恢复复杂度，界面相应开关明确标注为未接线。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EnvOwnership, SystemMutation } from '@shared/domain'

const run = promisify(execFile)
const ENV_KEY = 'HKCU\\Environment'

function newId(): string {
  return `mut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function mutation(ownership: EnvOwnership, previousValue: string | null): SystemMutation {
  const target = ownership.kind === 'path-entry'
    ? `${ENV_KEY}\\Path`
    : `${ENV_KEY}\\${ownership.name}`
  return {
    id: newId(),
    kind: ownership.kind === 'path-entry' ? 'path' : 'registry',
    target,
    previousValue,
    currentValue: ownership.kind === 'path-entry' ? ownership.entry : ownership.value,
    createdAt: new Date().toISOString(),
    ownership
  }
}

/** 读取注册表值；REG_EXPAND_SZ 与 REG_SZ 都接受，无该项返回 null */
async function readRegValue(key: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await run('reg', ['query', key, '/v', name], { windowsHide: true })
    const match = stdout.match(/REG_EXPAND_SZ\s+(.*)$/m) ?? stdout.match(/REG_SZ\s+(.*)$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

async function writeRegValue(key: string, name: string, value: string, expand: boolean): Promise<void> {
  await run('reg', [
    'add', key, '/v', name,
    '/t', expand ? 'REG_EXPAND_SZ' : 'REG_SZ',
    '/d', value, '/f'
  ], { windowsHide: true })
}

async function deleteRegValue(key: string, name: string): Promise<void> {
  await run('reg', ['delete', key, '/v', name, '/f'], { windowsHide: true }).catch(() => undefined)
}

/** 读取用户级 PATH；无该项时返回 null */
export async function readUserPath(): Promise<string | null> {
  return readRegValue(ENV_KEY, 'Path')
}

/** PATH 含 `%VAR%` 引用，必须用 REG_EXPAND_SZ 才能在进程启动时展开 */
async function writeUserPath(value: string): Promise<void> {
  await writeRegValue(ENV_KEY, 'Path', value, true)
}

/** 读取用户级环境变量；未定义返回 null */
export async function readEnvVar(name: string): Promise<string | null> {
  return readRegValue(ENV_KEY, name)
}

/** 写入用户级环境变量 */
export async function writeEnvVar(name: string, value: string): Promise<void> {
  await writeRegValue(ENV_KEY, name, value, false)
}

/**
 * 把 PATH 条目加入用户级 PATH，返回可回滚记录；已存在则不产生变更。
 * PATH 里的条目本身是 `%HOME%` 引用，不含具体版本。
 */
export async function addPathEntry(entry: string): Promise<SystemMutation | null> {
  const current = await readUserPath()
  if (current) {
    const parts = current.split(';').filter(Boolean)
    if (parts.some((part) => part.toLowerCase() === entry.toLowerCase())) return null
  }
  const next = current ? `${entry};${current}` : entry
  await writeUserPath(next)
  // 旧值仅作记录；回滚不再写回
  return mutation({ kind: 'path-entry', entry }, current)
}

/** 移除一条 PATH 条目，返回可回滚记录；不存在则不产生变更 */
export async function removePathEntry(entry: string): Promise<SystemMutation | null> {
  const current = await readUserPath()
  if (!current) return null
  const parts = current.split(';').filter((part) => part.toLowerCase() !== entry.toLowerCase())
  const next = parts.join(';')
  if (next === current) return null
  await writeUserPath(next)
  return mutation({ kind: 'path-entry', entry }, current)
}

/** 检测 PATH 是否包含指定条目，大小写不敏感 */
export async function hasPathEntry(entry: string): Promise<boolean> {
  const current = await readUserPath()
  if (!current) return false
  return current.split(';').some((part) => part.toLowerCase() === entry.toLowerCase())
}

/**
 * 写入环境变量并返回可回滚记录；值未变化时复用传入的原记录，避免清单膨胀。
 */
export async function putEnvVar(
  name: string,
  value: string,
  existing: SystemMutation | undefined
): Promise<SystemMutation> {
  const current = await readEnvVar(name)
  if (current !== value) await writeEnvVar(name, value)
  if (existing?.ownership?.kind === 'env-var' && existing.ownership.value === value) return existing
  return mutation({ kind: 'env-var', name, value }, current)
}

/**
 * 按 ownership 回滚一条变更。
 *
 * 变量：仅当当前值仍等于 EnvDock 写入的值时删除；已被用户改写或删除则保留。
 * PATH：只移除登记过的条目，不触碰其余条目，也不恢复整条旧 PATH。
 */
export async function rollbackMutation(record: SystemMutation): Promise<void> {
  const own = record.ownership
  if (own?.kind === 'env-var') {
    const current = await readEnvVar(own.name)
    if (current !== null && current === own.value) await deleteRegValue(ENV_KEY, own.name)
    return
  }
  if (own?.kind === 'path-entry') {
    const current = await readUserPath()
    if (!current) return
    const parts = current.split(';').filter(
      (part) => part.toLowerCase() !== own.entry.toLowerCase()
    )
    await writeUserPath(parts.join(';'))
    return
  }
  // 旧记录没有 ownership：只移除 currentValue 里那一条 EnvDock 条目，不写回旧 PATH
  if (record.kind === 'path' && record.currentValue) {
    const current = await readUserPath()
    if (!current) return
    const parts = current.split(';').filter(
      (part) => part.toLowerCase() !== record.currentValue.toLowerCase()
    )
    await writeUserPath(parts.join(';'))
  }
}

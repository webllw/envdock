/**
 * 进程内激活脚本生成。
 *
 * 集成到用户级 PATH 由 core/env.ts 负责；这里生成的是手动 source 的脚本，
 * 只在当前 PowerShell/CMD 会话生效，不改注册表。脚本内容由当前激活版本推导，
 * 切换版本后重新生成，因此不需要垫片转发层。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolId } from '@shared/domain'
import { computeEnvPlan, toPowerShellRef, type EnvVariable } from './env'
import type { Layout } from './paths'

function psLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * 生成 PowerShell 与 CMD 激活脚本。
 *
 * 脚本直接写入 HOME 变量与全局前缀，并把引用条目加入 PATH。变量值是脚本
 * 生成时的绝对路径，迁移目录后下次启动会重新生成，不依赖脚本自身位置推导。
 */
export async function writeActivationScripts(
  layout: Layout,
  active: Partial<Record<ToolId, string>>
): Promise<void> {
  const plan = computeEnvPlan(layout.root, active)

  const psLines: string[] = [
    '# EnvDock 激活脚本，仅对当前 PowerShell 会话生效',
    ...plan.variables.map((item: EnvVariable) => `$env:${item.name} = '${psLiteral(item.value)}'`),
    ...plan.pathRefs.map((ref) => `$env:PATH = '${toPowerShellRef(ref)}' + [IO.Path]::PathSeparator + $env:PATH`)
  ]
  if (plan.variables.length === 0) psLines.push('# 当前没有激活的工具')
  psLines.push('Write-Host "EnvDock 环境已激活"')

  const cmdLines: string[] = [
    '@echo off',
    'rem EnvDock 激活脚本，仅对当前 CMD 会话生效',
    ...plan.variables.map((item: EnvVariable) => `set "${item.name}=${item.value}"`),
    ...plan.pathRefs.map((ref) => `set "PATH=${ref};%PATH%"`)
  ]
  if (plan.variables.length === 0) cmdLines.push('rem 当前没有激活的工具')
  cmdLines.push('echo EnvDock 环境已激活')

  await mkdir(layout.scriptsDir, { recursive: true })
  await writeFile(join(layout.scriptsDir, 'activate.ps1'), psLines.join('\r\n'), 'utf8')
  await writeFile(join(layout.scriptsDir, 'activate.bat'), cmdLines.join('\r\n'), 'utf8')
}

/**
 * 激活脚本与 current/bin 垫片生成。
 *
 * 脚本内部用自身所在位置推导环境根目录，不写入任何绝对安装路径，
 * 因此整个目录迁移后无需重写脚本即可继续使用。
 * 环境变量只在调用脚本的进程内生效，不改系统 PATH 和注册表。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolId } from '@shared/domain'
import type { Layout } from './paths'

/**
 * 各工具需要进入 PATH 的可执行文件；用于 current/bin 稳定垫片。
 * 元素为「垫片名」与「版本目录内的目标文件名」二元组，默认目标为同名 .exe；
 * Maven 的 mvn 是 .cmd 脚本，需显式指定目标扩展名，避免垫片指向不存在的 exe。
 * Python 的 pythonw 是无控制台入口，pip 等 Scripts 下的脚本需先 ensurepip，不纳入垫片。
 */
type ShimEntry = { name: string; target?: string }
const SHIMS: Record<ToolId, ShimEntry[]> = {
  java: [{ name: 'java' }, { name: 'javac' }, { name: 'jar' }],
  maven: [{ name: 'mvn', target: 'mvn.cmd' }],
  php: [{ name: 'php' }],
  python: [{ name: 'python' }, { name: 'pythonw' }],
  go: [{ name: 'go' }, { name: 'gofmt' }],
  node: [{ name: 'node' }]
}

/** 垫片目标文件名：未显式指定时按同名 exe 处理 */
function shimTarget(entry: ShimEntry): string {
  return entry.target ?? `${entry.name}.exe`
}

export interface ActiveTool {
  toolId: ToolId
  relativeBinDir: string
  envVars: Record<string, string>
}

/**
 * 生成 PowerShell 与 CMD 激活脚本。
 * 两个脚本都基于脚本文件位置计算根目录，保证目录可迁移。
 */
export async function writeActivationScripts(
  layout: Layout,
  active: ActiveTool[]
): Promise<void> {
  const psLines: string[] = [
    '# EnvDock 激活脚本，仅对当前 PowerShell 会话生效',
    '$envdockRoot = Split-Path -Parent $PSScriptRoot',
    'if (-not $envdockRoot) { throw "无法定位 EnvDock 根目录" }'
  ]
  const cmdLines: string[] = [
    '@echo off',
    'rem EnvDock 激活脚本，仅对当前 CMD 会话生效',
    'set "ENVDOCK_ROOT=%~dp0.."'
  ]

  for (const item of active) {
    psLines.push(`$envdockBin = Join-Path $envdockRoot '${item.relativeBinDir.replace(/\//g, "' -Path '")}'`)
    psLines.push("$env:PATH = $envdockBin + [IO.Path]::PathSeparator + $env:PATH")
    cmdLines.push(`set "ENVDOCK_BIN=%ENVDOCK_ROOT%\\${item.relativeBinDir.replace(/\//g, '\\')}"`)
    cmdLines.push('set "PATH=%ENVDOCK_BIN%;%PATH%"')
    for (const [key, value] of Object.entries(item.envVars)) {
      psLines.push(`$env:${key} = Join-Path $envdockRoot '${value.replace(/\//g, "' -Path '")}'`)
      cmdLines.push(`set "${key}=%ENVDOCK_ROOT%\\${value.replace(/\//g, '\\')}"`)
    }
  }

  psLines.push('Write-Host "EnvDock 环境已激活"')
  cmdLines.push('echo EnvDock 环境已激活')

  await writeFile(join(layout.scriptsDir, 'activate.ps1'), psLines.join('\r\n'), 'utf8')
  await writeFile(join(layout.scriptsDir, 'activate.bat'), cmdLines.join('\r\n'), 'utf8')
}

/**
 * 重建 current/bin 垫片。
 *
 * 垫片是固定路径的 .cmd 文件，内部转发到当前激活版本的真实可执行文件。
 * 用户级 PATH 只需在首次集成时指向这个目录，之后切换版本无需再改 PATH。
 */
export async function writeCurrentShims(layout: Layout, active: ActiveTool[]): Promise<void> {
  await rm(layout.currentBinDir, { recursive: true, force: true })
  await mkdir(layout.currentBinDir, { recursive: true })

  for (const item of active) {
    const entries = SHIMS[item.toolId]
    if (entries.length === 0) continue

    for (const entry of entries) {
      const names = entry.name
      const envSetup = Object.entries(item.envVars)
        .map(([key, value]) => `set "${key}=%~dp0..\\..\\${value.replace(/\//g, '\\')}"`)
        .join('\r\n')
      const content = [
        '@echo off',
        'rem EnvDock 生成的版本垫片，指向当前激活版本',
        envSetup,
        `set "ENVDOCK_EXE=%~dp0..\\..\\${item.relativeBinDir.replace(/\//g, '\\')}\\${shimTarget(entry)}"`,
        'if not exist "%ENVDOCK_EXE%" (',
        `  echo EnvDock: ${names} 对应的版本已不存在，请重新激活 & exit /b 1`,
        ')',
        '"%ENVDOCK_EXE%" %*'
      ]
        .filter(Boolean)
        .join('\r\n')
      await writeFile(join(layout.currentBinDir, `${names}.cmd`), content, 'utf8')
    }
  }

  // 环境变量展开后生成的垫片可能被误认为大型文本，这里保留一份说明供排查
  await writeFile(
    join(layout.scriptsDir, 'shims.txt'),
    active.flatMap((item) => SHIMS[item.toolId].map((entry) => `${item.toolId}: ${entry.name}.cmd`)).join('\r\n') ||
      '当前没有激活的工具',
    'utf8'
  )
}

/** 为某个工具生成 PATH 条目（相对根目录），供 PATH 集成使用 */
export function currentBinRelative(): string {
  return 'current/bin'
}

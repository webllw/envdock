/**
 * 环境变量方案：每个工具用专属 HOME 变量指向真实版本目录，PATH 只写变量引用。
 *
 * 切换版本时只改 HOME 变量的值，PATH 条目固定不变；进程启动时 Windows 展开
 * `%VAR%`，因此新开的终端直接拿到新版本，已开终端需要重启——界面在切换后提示。
 * 这是替代垫片与 junction 的方案：PATH 与 HOME 之间没有转发层。
 */
import { join } from 'node:path'
import type { ToolId } from '@shared/domain'
import { globalBucketDir } from './npm-globals'

/** 集成开关的标记变量，值固定为 1；只用它判断集成状态，不承载路径 */
export const MANAGED_FLAG = 'ENVDOCK_MANAGED'

/** 工具 HOME 变量及其注入 PATH 的引用条目 */
interface ToolEnvSpec {
  tool: ToolId
  homeVar: string
  pathRefs: string[]
}

/**
 * Composer 用 ENVDOCK_COMPOSER_HOME 而非 COMPOSER_HOME：后者是 Composer 官方
 * 读取的配置目录，占用会改变其行为。Composer 是 PHP 内部工具，不进用户列表。
 */
const TOOL_ENV: ToolEnvSpec[] = [
  { tool: 'java', homeVar: 'JAVA_HOME', pathRefs: ['%JAVA_HOME%\\bin'] },
  { tool: 'maven', homeVar: 'MAVEN_HOME', pathRefs: ['%MAVEN_HOME%\\bin'] },
  { tool: 'go', homeVar: 'GOROOT', pathRefs: ['%GOROOT%\\bin'] },
  { tool: 'node', homeVar: 'NODE_HOME', pathRefs: ['%NODE_HOME%'] },
  { tool: 'php', homeVar: 'PHP_HOME', pathRefs: ['%PHP_HOME%'] },
  {
    tool: 'python',
    homeVar: 'PYTHONHOME',
    pathRefs: ['%PYTHONHOME%', '%PYTHONHOME%\\Scripts']
  },
  {
    tool: 'composer',
    homeVar: 'ENVDOCK_COMPOSER_HOME',
    pathRefs: ['%ENVDOCK_COMPOSER_HOME%']
  }
]

/** 某个工具写出的全部变量名，与版本值无关，供取消激活时精确撤销 */
export function envVarNamesForTool(tool: ToolId): string[] {
  const spec = TOOL_ENV.find((item) => item.tool === tool)
  if (!spec) return []
  const names = [spec.homeVar]
  if (tool === 'node') names.push('npm_config_prefix', 'npm_config_cache')
  if (tool === 'python') names.push('PYTHONUSERBASE', 'PIP_USER')
  return names
}

/** 某个工具写出的全部 PATH 引用，与版本值无关 */
export function pathRefsForTool(tool: ToolId): string[] {
  const spec = TOOL_ENV.find((item) => item.tool === tool)
  if (!spec) return []
  const refs = [...spec.pathRefs]
  if (tool === 'node') refs.push('%npm_config_prefix%')
  if (tool === 'python') refs.push('%PYTHONUSERBASE%\\Scripts')
  return refs
}

export interface EnvVariable {
  name: string
  value: string
}

export interface EnvPlan {
  variables: EnvVariable[]
  pathRefs: string[]
}

/** 工具的真实版本目录，绝对路径 */
export function toolVersionDir(root: string, tool: ToolId, versionId: string): string {
  return join(root, 'runtimes', tool, versionId)
}

/**
 * 由当前激活版本推导完整环境变量计划。
 *
 * 全局包目录按语言主版本隔离：npm 走 npm_config_prefix / npm_config_cache，
 * Python 走 PYTHONUSERBASE 并开启 PIP_USER，使 pip 安装落到同一个固定位置。
 * 这些值与 HOME 变量一样随版本切换改写，但 PATH 引用本身不变。
 */
export function computeEnvPlan(
  root: string,
  active: Partial<Record<ToolId, string>>
): EnvPlan {
  const variables: EnvVariable[] = []
  const pathRefs: string[] = []

  for (const spec of TOOL_ENV) {
    const version = active[spec.tool]
    if (!version) continue
    variables.push({ name: spec.homeVar, value: toolVersionDir(root, spec.tool, version) })
    pathRefs.push(...spec.pathRefs)

    if (spec.tool === 'node') {
      const prefix = globalBucketDir(root, 'node', version)
      variables.push({ name: 'npm_config_prefix', value: prefix })
      variables.push({ name: 'npm_config_cache', value: join(prefix, 'cache') })
      pathRefs.push('%npm_config_prefix%')
    }

    if (spec.tool === 'python') {
      variables.push({ name: 'PYTHONUSERBASE', value: globalBucketDir(root, 'python', version) })
      variables.push({ name: 'PIP_USER', value: '1' })
      pathRefs.push('%PYTHONUSERBASE%\\Scripts')
    }
  }

  return { variables, pathRefs }
}

/** 固定值变量：集成开启时写入，标记 EnvDock 接管了环境 */
export function fixedVariables(): EnvVariable[] {
  return [{ name: MANAGED_FLAG, value: '1' }]
}

/** 把 `%VAR%` 引用转成 PowerShell 的 `$env:VAR` 形式，供进程内激活脚本使用 */
export function toPowerShellRef(pathRef: string): string {
  return pathRef.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_all, name: string) => `$env:${name}`)
}

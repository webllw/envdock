/**
 * Provider 共用的镜像重写与激活计划构造逻辑。
 */
import type {
  ActivationPlan,
  AppConfig,
  ToolId,
  VersionInfo
} from '@shared/domain'

/**
 * 比较版本标识的数字段，用于挑选同一主线上的最新版本。
 * 逐段提取全部数字再比较，兼容 v 前缀、+build 后缀与 go 前缀等写法。
 * 返回正数表示 a 更新。
 */
export function compareVersionIds(a: string, b: string): number {
  const parts = (value: string): number[] => (value.match(/\d+/g) ?? []).map(Number)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 每条主线只保留最新的一个版本。
 *
 * 主线粒度由 lineKey 决定（例如 Java 的 feature、Node 的 major），
 * 让版本列表覆盖全部大版本，但不展开同一主线的历史补丁版本。
 * 返回值按版本号降序排列。
 */
export function keepLatestPerLine(
  versions: VersionInfo[],
  lineKey: (version: VersionInfo) => string | null
): VersionInfo[] {
  const latest = new Map<string, VersionInfo>()
  for (const version of versions) {
    const key = lineKey(version)
    if (key === null) continue
    const current = latest.get(key)
    if (!current || compareVersionIds(version.id, current.id) > 0) {
      latest.set(key, version)
    }
  }
  return [...latest.values()].sort((a, b) => compareVersionIds(b.id, a.id))
}

/**
 * 根据镜像配置生成候选下载地址。
 *
 * 镜像路径无法在所有版本上验证，因此镜像地址仅作为首选尝试，
 * 原始官方地址始终作为最后兜底，保证安装不会因镜像失效而中断。
 */
export function mirrorUrls(
  officialUrl: string,
  config: AppConfig,
  builder: (mirror: AppConfig['mirror']) => string | null
): { primary: string; fallbacks: string[] } {
  if (config.mirror === 'official') return { primary: officialUrl, fallbacks: [] }
  const mirrored = builder(config.mirror)
  if (!mirrored || mirrored === officialUrl) return { primary: officialUrl, fallbacks: [] }
  return { primary: mirrored, fallbacks: [officialUrl] }
}

/** 由版本目录构造标准激活计划，各 provider 只需提供工具专属环境变量 */
export function makeActivationPlan(
  tool: ToolId,
  version: VersionInfo,
  relativeDir: string,
  extraEnv: Record<string, string>,
  /** 可执行文件所在子目录；PHP 的 exe 在版本根目录，传空串 */
  binSubDir = 'bin'
): ActivationPlan {
  const pathEntries = [binSubDir ? `${relativeDir}/${binSubDir}` : relativeDir]
  const envVars = { ...extraEnv }
  const lines = [
    `# EnvDock - ${tool} ${version.display}`,
    ...Object.entries(envVars).map(([key, value]) => `$env:${key} = '${value}'`),
    `$env:PATH = '${pathEntries[0]}' + [IO.Path]::PathSeparator + $env:PATH`
  ]
  return {
    tool,
    versionId: version.id,
    pathEntries,
    envVars,
    shellSnippet: lines.join('\n')
  }
}

/** 取消激活时只移除本工具的 PATH 项，不触碰其他工具 */
export function makeDeactivationPlan(tool: ToolId, relativeDir: string): ActivationPlan {
  return {
    tool,
    versionId: '',
    pathEntries: [],
    envVars: {},
    shellSnippet: `# EnvDock - ${tool} 未激活，bin: ${relativeDir}/bin`
  }
}

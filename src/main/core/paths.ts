/**
 * 环境根目录与内部布局的路径解析。
 *
 * 可迁移性的前提是：根目录之外不保存任何运行时数据，目录内部只存相对路径。
 * 因此所有绝对路径都在这里由根目录推导，业务代码不得自行拼接跨目录路径。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { app } from 'electron'

/** 根目录下固定的子目录名，变动会导致已安装版本失联 */
export const LAYOUT = {
  runtimes: 'runtimes',
  cache: 'cache',
  downloads: join('cache', 'downloads'),
  scripts: 'scripts',
  current: 'current',
  currentBin: join('current', 'bin'),
  app: 'app',
  appBackup: 'app.old',
  stateFile: 'state.json',
  manifestFile: 'manifest.json',
  versionFile: 'version.json',
  updates: 'updates',
  updateDownload: join('updates', 'download'),
  updateStaging: join('updates', 'staging'),
  updateConfirm: join('updates', 'confirmed')
} as const

/** 环境根目录的完整路径集合，均为绝对路径 */
export interface Layout {
  root: string
  runtimesDir: string
  cacheDir: string
  downloadsDir: string
  scriptsDir: string
  currentDir: string
  currentBinDir: string
  appDir: string
  appBackupDir: string
  stateFile: string
  manifestFile: string
  versionFile: string
  updatesDir: string
  updateDownloadDir: string
  updateStagingDir: string
  updateConfirmFile: string
}

/** 由根目录推导全部绝对路径 */
export function createLayout(root: string): Layout {
  const base = resolve(root)
  return {
    root: base,
    runtimesDir: join(base, LAYOUT.runtimes),
    cacheDir: join(base, LAYOUT.cache),
    downloadsDir: join(base, LAYOUT.downloads),
    scriptsDir: join(base, LAYOUT.scripts),
    currentDir: join(base, LAYOUT.current),
    currentBinDir: join(base, LAYOUT.currentBin),
    appDir: join(base, LAYOUT.app),
    appBackupDir: join(base, LAYOUT.appBackup),
    stateFile: join(base, LAYOUT.stateFile),
    manifestFile: join(base, LAYOUT.manifestFile),
    versionFile: join(base, LAYOUT.versionFile),
    updatesDir: join(base, LAYOUT.updates),
    updateDownloadDir: join(base, LAYOUT.updateDownload),
    updateStagingDir: join(base, LAYOUT.updateStaging),
    updateConfirmFile: join(base, LAYOUT.updateConfirm)
  }
}

/**
 * 定位环境根目录。
 *
 * 优先级：显式环境变量 > 打包后向上查找根目录标记 > 应用目录的上一级。
 * 开发态默认落在项目内的 .envdock-data，避免写入系统目录。
 */
export function resolveInstallRoot(): string {
  const fromEnv = process.env.ENVDOCK_ROOT
  if (fromEnv && isAbsolute(fromEnv) && existsSync(fromEnv)) return resolve(fromEnv)

  const appPath = app.getAppPath()

  if (app.isPackaged) {
    let cursor = appPath
    for (let i = 0; i < 4; i += 1) {
      const candidate = join(cursor, LAYOUT.manifestFile)
      if (existsSync(candidate)) return cursor
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    return dirname(appPath)
  }

  return join(appPath, '.envdock-data')
}

/** 把可能包含覆盖值的目标目录规范化为绝对路径 */
export function normalizeTargetRoot(target: string): string {
  return resolve(target)
}

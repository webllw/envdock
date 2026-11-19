/**
 * 应用自身升级引擎。
 *
 * 职责：检查远程更新清单、下载校验升级包、解压到 staging、写入挂起版本、
 * 生成进程外替换脚本并退出。新版本启动后由 confirmOnStartup 确认升级，
 * 超时未确认时由替换脚本自动回滚。
 *
 * 本模块不直接依赖 electron：重启动作通过构造参数注入，便于在测试环境中
 * 用临时目录验证完整状态机，而不真正启动桌面应用或改动系统 PATH。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { UpdateManifest, UpdateState, VersionState } from '@shared/domain'
import { downloadBytes, verifyChecksum } from './downloader'
import { fetchLatestRelease } from './github-release'
import type { Layout } from './paths'
import type { Store } from './store'

/** 打包产物的可执行文件名，与 electron-builder 的 productName 对应 */
export const APP_EXE_NAME = 'EnvDock.exe'

/** 替换脚本等待新版本写确认文件的轮询次数，每次约 0.5 秒，超时触发回滚 */
const CONFIRM_WAIT_TICKS = 60

export interface UpdaterOptions {
  layout: Layout
  store: Store
  /** 当前应用内建版本，来自 package.json */
  appVersion: string
  /** 状态变化回调，用于向渲染进程推送进度 */
  emit: (state: UpdateState) => void
  /** 请求应用退出；替换脚本负责随后启动新版本 */
  restart: () => void
  /** GitHub 网页根地址覆盖，仅用于验证环境指向本地服务 */
  webBase?: string
}

/**
 * 生成静默启动器。Node 的 windowsHide 对 detached 的 cmd /C 并非在所有 Windows
 * 版本上都生效，替换脚本执行期间会闪出甚至停留一个控制台窗口。VBS 的 Run 以
 * 窗口样式 0 启动脚本，可确保全程无窗口；//B 让 wscript 自身不弹对话框。
 */
export function buildSilentLauncher(scriptPath: string): string {
  const escaped = scriptPath.replace(/"/g, '""')
  return [
    'Set ws = CreateObject("WScript.Shell")',
    `ws.Run "${escaped}", 0, False`,
    ''
  ].join('\r\n')
}

/** 比较语义化版本号，a 大于 b 返回 1，相等返回 0，小于返回 -1 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value.split(/[.-]/).map((part) => {
      const num = Number.parseInt(part, 10)
      return Number.isNaN(num) ? 0 : num
    })
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * 生成进程外替换脚本。
 *
 * Windows 无法覆盖正在运行的 exe，脚本必须在主进程退出后执行：
 * 先结束同名残留进程 → 备份 app → 就位新版本 → 启动 → 轮询确认文件 →
 * 超时则回滚。所有路径在生成时展开为绝对路径；脚本是一次性临时文件，
 * 不参与目录迁移，因此可以安全写死。
 *
 * 不再按 PID 轮询等待：PID 退出后会被系统回收复用，findstr 匹配数字会把
 * 复用的无关进程误判为原进程，陷入死循环并反复弹出控制台窗口。改为在
 * Windows 任务管理器可见的层面前强制结束同名进程，再短暂等待文件句柄释放。
 */
export function buildReplaceScript(params: {
  root: string
  mode: 'upgrade' | 'rollback'
  timeoutTicks?: number
}): string {
  const { root, mode } = params
  const ticks = params.timeoutTicks ?? CONFIRM_WAIT_TICKS
  const app = join(root, 'app')
  const backup = join(root, 'app.old')
  const staging = join(root, 'updates', 'staging')
  const confirm = join(root, 'updates', 'confirmed')
  const exe = join(app, APP_EXE_NAME)
  const q = (value: string): string => `"${value}"`

  const lines = [
    '@echo off',
    'setlocal',
    `set "ROOT=${root}"`,
    `set "APP=${app}"`,
    `set "BACKUP=${backup}"`,
    `set "STAGING=${staging}"`,
    `set "CONFIRM=${confirm}"`,
    `set "EXE=${exe}"`,
    '',
    'rem 结束所有同名进程，确保 exe 与 app 目录没有句柄占用',
    `taskkill /F /IM ${APP_EXE_NAME} >nul 2>&1`,
    'rem 给文件系统一点时间释放句柄',
    'ping -n 2 127.0.0.1 >nul',
    ''
  ]

  if (mode === 'upgrade') {
    lines.push(
      'rem 备份当前应用本体',
      `if exist ${q(backup)} rmdir /S /Q ${q(backup)}`,
      `if exist ${q(app)} move /Y ${q(app)} ${q(backup)}`,
      'rem 新版本就位',
      `if not exist ${q(staging)} goto fail`,
      `move /Y ${q(staging)} ${q(app)}`,
      `if not errorlevel 1 goto launch`
    )
  } else {
    lines.push(
      'rem 回滚：当前应用丢弃，旧版本就位',
      `if not exist ${q(backup)} goto fail`,
      `if exist ${q(app)} rmdir /S /Q ${q(app)}`,
      `move /Y ${q(backup)} ${q(app)}`,
      `if not errorlevel 1 goto launch`
    )
  }

  lines.push(
    ':fail',
    'echo updater failed > "%ROOT%\\updates\\error.flag"',
    'goto end',
    '',
    ':launch',
    `start "" ${q(exe)}`,
    'rem 新版本启动后写确认文件；超时未写则回滚',
    `set /a N=0`,
    ':confirm',
    `if exist ${q(confirm)} goto success`,
    'ping -n 2 127.0.0.1 >nul',
    'set /a N+=1',
    `if %N% GEQ ${ticks} goto rollback`,
    'goto confirm',
    '',
    ':rollback',
    'taskkill /F /IM EnvDock.exe >nul 2>&1',
    `if exist ${q(app)} rmdir /S /Q ${q(app)}`,
    `if exist ${q(backup)} move /Y ${q(backup)} ${q(app)}`,
    `start "" ${q(exe)}`,
    'echo rolled back > "%ROOT%\\updates\\error.flag"',
    '',
    ':success',
    'endlocal',
    'exit /b 0',
    '',
    ':end',
    'endlocal',
    'exit /b 1'
  )
  return lines.join('\r\n') + '\r\n'
}

/** 把升级包解压到 staging；升级包内容是 app 目录的直接内容 */
async function extractToStaging(archive: string, stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  const zip = new AdmZip(archive)

  // 部分打包工具会把内容包一层 app/ 目录，统一剥离到 staging 根
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
  if (entries.length === 0) throw new Error('升级包内没有文件')
  const allUnderApp = entries.every((entry) => {
    const normalized = entry.entryName.replace(/\\/g, '/')
    return normalized.startsWith('app/')
  })

  for (const entry of entries) {
    const normalized = entry.entryName.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`升级包包含非法路径：${entry.entryName}`)
    }
    const relative = allUnderApp ? normalized.slice('app/'.length) : normalized
    if (!relative) continue
    const destination = join(stagingDir, relative)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, entry.getData())
  }

  const exePath = join(stagingDir, APP_EXE_NAME)
  if (!existsSync(exePath)) throw new Error(`升级包缺少 ${APP_EXE_NAME}`)
}

export class Updater {
  private available: UpdateManifest | null = null
  private current: UpdateState

  constructor(private readonly options: UpdaterOptions) {
    this.current = {
      phase: 'idle',
      currentVersion: options.appVersion,
      available: null,
      readyToApply: false,
      canRollback: existsSync(options.layout.appBackupDir),
      message: '',
      percent: 0
    }
  }

  state(): UpdateState {
    return { ...this.current, available: this.current.available ? { ...this.current.available } : null }
  }

  private publish(patch: Partial<UpdateState>): void {
    this.current = { ...this.current, ...patch }
    this.options.emit(this.state())
  }

  private sourceUrl(): string {
    return this.options.store.getState().config.update.sourceUrl.trim().replace(/\/+$/, '')
  }

  /** 写替换脚本与静默启动器并在后台拉起；VBS 负责隐藏脚本执行窗口 */
  private async launchReplaceScript(mode: 'upgrade' | 'rollback'): Promise<void> {
    const script = join(this.options.layout.updatesDir, 'replace.bat')
    await writeFile(script, buildReplaceScript({
      root: this.options.layout.root,
      mode
    }), 'utf8')
    const launcher = join(this.options.layout.updatesDir, 'run-silent.vbs')
    await writeFile(launcher, buildSilentLauncher(script), 'utf8')

    // 优先用 wscript 静默执行；不可用时退回 cmd.exe，仍保留 windowsHide
    const child = spawn('wscript.exe', ['//B', launcher], {
      cwd: this.options.layout.root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', () => {
      const fallback = spawn('cmd.exe', ['/C', script], {
        cwd: this.options.layout.root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      fallback.unref()
    })
    child.unref()
  }

  /** 从 GitHub Releases 拉取最新发布，与内建版本比较；已是最新返回 null */
  async check(): Promise<UpdateManifest | null> {
    const source = this.sourceUrl()
    if (!source) {
      this.publish({ phase: 'idle', available: null, readyToApply: false, message: '尚未配置更新源' })
      return null
    }
    this.publish({ phase: 'checking', message: '正在检查更新', percent: -1 })

    try {
      const manifest = await fetchLatestRelease({
        sourceUrl: source,
        appVersion: this.options.appVersion,
        webBase: this.options.webBase
      })
      if (!manifest) {
        this.available = null
        this.publish({
          phase: 'idle',
          available: null,
          readyToApply: false,
          message: `已是最新版本 ${this.options.appVersion}`
        })
        return null
      }

      if (compareVersions(manifest.version, this.options.appVersion) <= 0) {
        this.available = null
        this.publish({
          phase: 'idle',
          available: null,
          readyToApply: false,
          message: `已是最新版本 ${this.options.appVersion}`
        })
        return null
      }

      this.available = manifest
      this.publish({
        phase: 'available',
        available: manifest,
        readyToApply: false,
        message: `发现新版本 ${manifest.version}`,
        percent: 0
      })
      return manifest
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publish({ phase: 'error', message: `检查更新失败：${message}`, percent: -1 })
      throw error
    }
  }

  /** 下载并校验升级包，解压到 staging；不改动当前应用 */
  async prepare(): Promise<UpdateState> {
    const manifest = this.available ?? (await this.check())
    if (!manifest) throw new Error('没有可用的新版本')

    const url = manifest.downloadUrl
    // 文件名来自第三方 release 资产，收敛为 basename 避免路径逃逸
    const dest = join(this.options.layout.updateDownloadDir, basename(manifest.fileName))

    this.publish({ phase: 'downloading', message: '正在下载升级包', percent: 0 })
    await rm(`${dest}.part`, { force: true })
    await downloadBytes(url, `${dest}.part`, (received, total) => {
      const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1
      this.publish({
        phase: 'downloading',
        percent,
        message: `下载中 ${(received / 1024 / 1024).toFixed(1)} MB`
      })
    })

    this.publish({ phase: 'verifying', message: '正在校验升级包', percent: 99 })
    if (!(await verifyChecksum(`${dest}.part`, manifest.sha256, 'sha256'))) {
      await rm(`${dest}.part`, { force: true })
      throw new Error('升级包校验失败，可能下载不完整')
    }
    await rename(`${dest}.part`, dest)

    this.publish({ phase: 'extracting', message: '正在准备升级文件', percent: 100 })
    await extractToStaging(dest, this.options.layout.updateStagingDir)

    this.publish({
      phase: 'available',
      readyToApply: true,
      percent: 100,
      message: `新版本 ${manifest.version} 已就绪，重启后生效`
    })
    return this.state()
  }

  /**
   * 写入挂起版本并启动进程外替换脚本，随后请求应用退出。
   * 返回后界面会短暂显示“正在重启”，实际替换由脚本在主进程退出后完成。
   */
  async apply(): Promise<UpdateState> {
    if (!this.current.readyToApply || !this.available) {
      throw new Error('升级包尚未准备完成')
    }
    const manifest = this.available
    const version = this.options.store.getVersion()
    await this.options.store.updateVersion((draft) => {
      draft.previousVersion = version.currentVersion
      draft.pendingVersion = manifest.version
      draft.lastMessage = `正在升级到 ${manifest.version}`
    })
    await rm(this.options.layout.updateConfirmFile, { force: true })

    this.publish({ phase: 'restarting', percent: 100, message: '正在重启以完成升级' })
    await this.launchReplaceScript('upgrade')
    this.options.restart()
    return this.state()
  }

  /**
   * 启动确认。新版本首次启动时调用：版本匹配则写确认文件并清空挂起状态，
   * 使替换脚本停止等待。版本不匹配时保留挂起状态并记录，便于回滚。
   */
  async confirmOnStartup(): Promise<void> {
    const version = this.options.store.getVersion()
    if (!version.pendingVersion) {
      this.publish({
        currentVersion: this.options.appVersion,
        canRollback: existsSync(this.options.layout.appBackupDir),
        message: version.lastMessage
      })
      return
    }
    if (version.pendingVersion !== this.options.appVersion) {
      await this.options.store.updateVersion((draft) => {
        draft.lastMessage = `版本不一致：期望 ${version.pendingVersion}，实际 ${this.options.appVersion}`
      })
      return
    }
    await writeFile(this.options.layout.updateConfirmFile, this.options.appVersion, 'utf8')
    await this.options.store.updateVersion((draft) => {
      draft.currentVersion = this.options.appVersion
      draft.pendingVersion = null
      draft.lastMessage = `已升级到 ${this.options.appVersion}`
    })
    await rm(this.options.layout.updateStagingDir, { recursive: true, force: true })
    this.publish({
      phase: 'idle',
      currentVersion: this.options.appVersion,
      readyToApply: false,
      canRollback: existsSync(this.options.layout.appBackupDir),
      message: `已升级到 ${this.options.appVersion}`
    })
  }

  /** 回滚到上一版本：改写版本状态后启动反向替换脚本 */
  async rollback(): Promise<void> {
    if (!existsSync(this.options.layout.appBackupDir)) throw new Error('没有可回滚的旧版本')
    const version = this.options.store.getVersion()
    const target = version.previousVersion ?? version.currentVersion
    await this.options.store.updateVersion((draft) => {
      draft.currentVersion = target
      draft.pendingVersion = null
      draft.previousVersion = null
      draft.lastMessage = `已回滚到 ${target}`
    })
    await rm(this.options.layout.updateConfirmFile, { force: true })

    this.publish({ phase: 'restarting', message: '正在回滚', percent: 100 })
    await this.launchReplaceScript('rollback')
    this.options.restart()
  }

  /** 删除保留的上一版本目录，释放磁盘空间 */
  async discardOld(): Promise<void> {
    await rm(this.options.layout.appBackupDir, { recursive: true, force: true })
    this.publish({ canRollback: false, message: '已清理上一版本' })
  }

  /** 读取版本状态，供界面展示当前版本与挂起信息 */
  versionState(): VersionState {
    return this.options.store.getVersion()
  }

  /** 查询某文件路径是否存在，测试脚本用 */
  static async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  /** 提取升级包文件名，用于测试脚本核对下载落盘 */
  static packageName(manifest: UpdateManifest): string {
    return basename(manifest.fileName)
  }

  /** 读取本地文件内容，测试脚本用 */
  static async readText(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }
}

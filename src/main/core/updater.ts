/**
 * 应用自身升级与版本历史管理引擎。
 *
 * 职责：检查远程更新清单、下载校验升级包、解压到 staging、写入挂起版本、
 * 生成进程外替换脚本并退出。新版本启动后由 confirmOnStartup 确认升级。
 *
 * 版本历史统一放在 updates/history/<version>/，每个目录是一份完整的 app 副本。
 * 升级时归档当前版本，回退时归档当前版本并就位目标版本，因此历史始终是
 * 「当前运行版本之外的版本集合」，用户可对任意条目回退或删除。
 *
 * 本模块不直接依赖 electron：重启动作通过构造参数注入，便于在测试环境中
 * 用临时目录验证完整状态机，而不真正启动桌面应用或改动系统 PATH。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { AppHistoryEntry, UpdateManifest, UpdateState, VersionState } from '@shared/domain'
import { downloadBytes, verifyChecksum } from './downloader'
import { fetchLatestRelease } from './github-release'
import type { Layout } from './paths'
import type { Store } from './store'

/** 打包产物的可执行文件名，与 electron-builder 的 productName 对应 */
export const APP_EXE_NAME = 'EnvDock.exe'

/** 替换脚本等待新版本写确认文件的轮询次数，每次约 0.5 秒，超时触发回滚 */
const CONFIRM_WAIT_TICKS = 60

/** 版本目录名只允许普通版本字符，防止归档路径穿越 */
const VERSION_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

export function isValidVersionDir(version: string): boolean {
  return VERSION_DIR_PATTERN.test(version) && version !== '.' && version !== '..'
}

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

/**
 * 健壮删除目录树。
 *
 * Windows 上刚升级完的归档目录常被安全软件或残留进程短暂占用，fs.rm 递归
 * 删除到深处时会因单个文件删不掉而在 rmdir 阶段抛 ENOTEMPTY。分三层处理：
 * 先用 maxRetries 做指数退避；仍失败则改名再删——部分占用是按路径锁定的，
 * 改名后锁会失效；最后确实删不掉时返回残留路径，由调用方如实告知用户。
 */
export async function removeDirectoryRobust(dir: string): Promise<{ removed: boolean; residue?: string }> {
  const remove = () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  try {
    await remove()
    return { removed: true }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  try {
    await remove()
    return { removed: true }
  } catch {
    // 占用按路径锁定时改名即可解除；改名失败说明目录被独占，交由调用方提示用户
  }
  const residue = `${dir}.discard-${Date.now()}`
  try {
    await rename(dir, residue)
  } catch {
    return { removed: false }
  }
  try {
    await rm(residue, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    return { removed: true }
  } catch {
    return { removed: false, residue }
  }
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

/** 递归统计目录字节数，用于历史条目占用展示；读不到的分支按 0 计 */
async function directorySize(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = join(current, item.name)
      if (item.isDirectory()) {
        await walk(full)
      } else if (item.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          /* 遍历期间文件可能被删除，忽略 */
        }
      }
    }
  }
  await walk(dir)
  return total
}

/**
 * 生成进程外替换脚本。
 *
 * Windows 无法覆盖正在运行的 exe，脚本必须在主进程退出后执行。两类模式：
 * - upgrade：归档当前版本 → staging 就位 → 启动 → 等待确认 → 超时从归档恢复。
 * - switch：归档当前版本 → 指定历史版本就位 → 启动后立即退出。历史版本是
 *   此前已验证可运行的副本，不再等待确认——旧回滚逻辑正是因为等待一个
 *   永远不会被写入的确认文件，超时后杀掉刚启动的进程，导致应用不可用。
 *
 * 目录跨父目录移动只能用 move，且目标存在时会把源移入其中造成嵌套。因此
 * 每次 move 前先删除同名目标，确保 move 是原子改名；任一步失败都走 :recover
 * 把归档移回 app，绝不在 app 缺失或缺少 exe 时结束。
 */
export function buildReplaceScript(params: {
  root: string
  mode: 'upgrade' | 'switch'
  fromVersion: string
  targetVersion?: string
  timeoutTicks?: number
}): string {
  const { root, mode, fromVersion } = params
  const ticks = params.timeoutTicks ?? CONFIRM_WAIT_TICKS
  const app = join(root, 'app')
  const staging = join(root, 'updates', 'staging')
  const history = join(root, 'updates', 'history')
  const from = join(history, fromVersion)
  const fromExe = join(from, APP_EXE_NAME)
  const target = mode === 'switch' ? join(history, params.targetVersion ?? '') : ''
  const confirm = join(root, 'updates', 'confirmed')
  const exe = join(app, APP_EXE_NAME)
  const flag = join(root, 'updates', 'error.flag')
  const q = (value: string): string => `"${value}"`

  const lines = [
    '@echo off',
    'setlocal',
    `set "APP=${app}"`,
    `set "STAGING=${staging}"`,
    `set "HISTORY=${history}"`,
    `set "FROM=${from}"`,
    `set "CONFIRM=${confirm}"`,
    `set "EXE=${exe}"`,
    '',
    'rem 结束所有同名进程，确保 exe 与 app 目录没有句柄占用',
    `taskkill /F /IM ${APP_EXE_NAME} >nul 2>&1`,
    'ping -n 3 127.0.0.1 >nul',
    '',
    'rem 归档当前版本：同名目标先删除，move 到不存在的路径才是原子改名',
    `if not exist ${q(history)} mkdir ${q(history)} >nul 2>&1`,
    `if not exist ${q(app)} goto fail`,
    `if exist ${q(from)} rmdir /S /Q ${q(from)} >nul 2>&1`,
    `move ${q(app)} ${q(from)} >nul 2>&1`,
    'if errorlevel 1 goto fail',
    `if exist ${q(app)} goto fail`,
    `if not exist ${q(fromExe)} goto recover`,
    ''
  ]

  if (mode === 'upgrade') {
    lines.push(
      'rem 就位新版本：app 已腾空，move 是改名而非移入子目录',
      `if not exist ${q(staging)} goto recover`,
      `move ${q(staging)} ${q(app)} >nul 2>&1`,
      'if errorlevel 1 goto recover',
      `if not exist ${q(exe)} goto recover`,
      'goto launch'
    )
  } else {
    lines.push(
      'rem 就位历史版本：目标目录从归档移出，当前版本已安全留在归档中',
      `if not exist ${q(target)} goto recover`,
      `move ${q(target)} ${q(app)} >nul 2>&1`,
      'if errorlevel 1 goto recover',
      `if not exist ${q(exe)} goto recover`,
      'goto switched'
    )
  }

  lines.push(
    '',
    ':recover',
    'rem 归档仍在，把当前版本移回 app；先删除可能残缺的 app 避免嵌套移动',
    `if not exist ${q(fromExe)} goto fail`,
    `if exist ${q(app)} rmdir /S /Q ${q(app)} >nul 2>&1`,
    `if exist ${q(app)} goto fail`,
    `move ${q(from)} ${q(app)} >nul 2>&1`,
    'if errorlevel 1 goto fail',
    `if not exist ${q(exe)} goto fail`,
    `start "" ${q(exe)}`,
    `echo version switch recovered, no change > ${q(flag)}`,
    'goto end',
    '',
    ':fail',
    'rem 归档尚未建立时 app 仍原样存在，尽量启动它',
    `if exist ${q(exe)} start "" ${q(exe)}`,
    `echo version switch failed > ${q(flag)}`,
    'goto end'
  )

  if (mode === 'upgrade') {
    lines.push(
      '',
      ':launch',
      `start "" ${q(exe)}`,
      'rem 新版本启动后写确认文件；超时未写则从归档恢复旧版本',
      'set /a N=0',
      ':confirm',
      `if exist ${q(confirm)} goto success`,
      'ping -n 2 127.0.0.1 >nul',
      'set /a N+=1',
      `if %N% GEQ ${ticks} goto timeout`,
      'goto confirm',
      '',
      ':timeout',
      `taskkill /F /IM ${APP_EXE_NAME} >nul 2>&1`,
      'ping -n 3 127.0.0.1 >nul',
      `if exist ${q(app)} rmdir /S /Q ${q(app)} >nul 2>&1`,
      `if not exist ${q(fromExe)} goto fail`,
      `move ${q(from)} ${q(app)} >nul 2>&1`,
      'if errorlevel 1 goto fail',
      `if not exist ${q(exe)} goto fail`,
      `start "" ${q(exe)}`,
      `echo upgrade timed out, rolled back > ${q(flag)}`,
      'goto end'
    )
  } else {
    lines.push('', ':switched')
  }

  lines.push(
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

/**
 * 把升级包内容解压到目标目录。升级包根即 app 目录内容；部分打包工具会多包
 * 一层 app/，统一剥离。路径做穿越校验，完成后校验主程序确实落盘。
 */
async function extractAppArchive(archive: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  const zip = new AdmZip(archive)

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
    const destination = join(targetDir, relative)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, entry.getData())
  }

  const exePath = join(targetDir, APP_EXE_NAME)
  if (!existsSync(exePath)) throw new Error(`升级包缺少 ${APP_EXE_NAME}`)
}

/** 把升级包解压到 staging；升级包内容是 app 目录的直接内容 */
async function extractToStaging(archive: string, stagingDir: string): Promise<void> {
  await extractAppArchive(archive, stagingDir)
}

export class Updater {
  private available: UpdateManifest | null = null
  private current: UpdateState
  private history: AppHistoryEntry[] = []

  constructor(private readonly options: UpdaterOptions) {
    this.current = {
      phase: 'idle',
      currentVersion: options.appVersion,
      available: null,
      readyToApply: false,
      canRollback: false,
      history: [],
      message: '',
      percent: 0
    }
  }

  state(): UpdateState {
    return {
      ...this.current,
      available: this.current.available ? { ...this.current.available } : null,
      history: this.history.map((item) => ({ ...item }))
    }
  }

  private publish(patch: Partial<UpdateState>): void {
    this.current = { ...this.current, ...patch }
    this.options.emit(this.state())
  }

  private sourceUrl(): string {
    return this.options.store.getState().config.update.sourceUrl.trim().replace(/\/+$/, '')
  }

  /**
   * 扫描历史版本并刷新列表，按版本号降序。
   *
   * 来源有两处，按版本号合并去重：updates/history/<version> 的完整 app 副本，
   * 与 updates/download/EnvDock-<version>-app.zip 的升级包缓存。早期版本的
   * 归档机制只保留单份 app.old，很多版本只留下升级包；把两处都纳入，才能列出
   * 全部下载过的版本。升级包内容就是完整的 app 目录，同样可用于回退。
   */
  async loadHistory(): Promise<AppHistoryEntry[]> {
    const archiveDir = this.options.layout.updateHistoryDir
    const downloadDir = this.options.layout.updateDownloadDir
    const byVersion = new Map<string, AppHistoryEntry>()

    let archives: string[] = []
    try {
      const entries = await readdir(archiveDir, { withFileTypes: true })
      archives = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      /* 目录尚未建立，按空列表处理 */
    }

    for (const name of archives) {
      if (!isValidVersionDir(name)) continue
      const full = join(archiveDir, name)
      let archivedAt = new Date(0).toISOString()
      let sizeBytes = 0
      try {
        archivedAt = (await stat(full)).mtime.toISOString()
      } catch {
        /* 目录在扫描期间被删除，保留默认值 */
      }
      sizeBytes = await directorySize(full)
      byVersion.set(name, {
        version: name,
        archivedAt,
        sizeBytes,
        launchable: existsSync(join(full, APP_EXE_NAME)),
        source: 'archive'
      })
    }

    // 升级包文件名形如 EnvDock-1.0.6-app.zip；只认已完成文件，跳过 .part 临时件
    const packagePattern = /^EnvDock-(.+)-app\.zip$/i
    let packages: string[] = []
    try {
      const entries = await readdir(downloadDir, { withFileTypes: true })
      packages = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    } catch {
      /* 下载目录尚未建立，按空列表处理 */
    }

    for (const fileName of packages) {
      const match = packagePattern.exec(fileName)
      if (!match) continue
      const version = match[1]
      if (!isValidVersionDir(version)) continue
      const full = join(downloadDir, fileName)
      let archivedAt = new Date(0).toISOString()
      let sizeBytes = 0
      try {
        const info = await stat(full)
        archivedAt = info.mtime.toISOString()
        sizeBytes = info.size
      } catch {
        /* 文件在扫描期间被删除，保留默认值 */
      }
      const existing = byVersion.get(version)
      if (existing) {
        // 同版本两处都在：合并占用与时间，升级包同样使条目可回退
        byVersion.set(version, {
          ...existing,
          sizeBytes: existing.sizeBytes + sizeBytes,
          archivedAt: existing.archivedAt > archivedAt ? existing.archivedAt : archivedAt,
          launchable: existing.launchable || sizeBytes > 0,
          source: 'both'
        })
      } else {
        byVersion.set(version, {
          version,
          archivedAt,
          sizeBytes,
          launchable: sizeBytes > 0,
          source: 'package'
        })
      }
    }

    const result = [...byVersion.values()]
    result.sort((a, b) => compareVersions(b.version, a.version))
    this.history = result
    this.publish({ canRollback: result.length > 0 })
    return result
  }

  /**
   * 把旧版 app.old 迁移为历史归档。老用户的 app.old 是升级前的完整 app，
   * 直接改名到 history/<previousVersion>，避免升级到新机制后旧版本失联。
   */
  private async migrateLegacyBackup(): Promise<void> {
    const backup = this.options.layout.appBackupDir
    if (!existsSync(backup)) return
    const previous = this.options.store.getVersion().previousVersion
    const name = previous && isValidVersionDir(previous) ? previous : 'legacy-backup'
    const dest = join(this.options.layout.updateHistoryDir, name)
    await mkdir(this.options.layout.updateHistoryDir, { recursive: true })
    if (existsSync(dest)) {
      await removeDirectoryRobust(backup)
      return
    }
    try {
      await rename(backup, dest)
    } catch {
      // 目录被占用时保留原样，不阻断启动
    }
  }

  /** 启动初始化：迁移旧备份并载入历史 */
  async init(): Promise<void> {
    await this.migrateLegacyBackup()
    await this.loadHistory()
  }

  /** 写替换脚本与静默启动器并在后台拉起；VBS 负责隐藏脚本执行窗口 */
  private async launchReplaceScript(params: {
    mode: 'upgrade' | 'switch'
    fromVersion: string
    targetVersion?: string
  }): Promise<void> {
    const script = join(this.options.layout.updatesDir, 'replace.bat')
    await writeFile(script, buildReplaceScript({
      root: this.options.layout.root,
      ...params
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
    await this.launchReplaceScript({ mode: 'upgrade', fromVersion: this.options.appVersion })
    this.options.restart()
    return this.state()
  }

  /** 启动确认。新版本首次启动时调用：版本匹配则写确认文件并清空挂起状态 */
  async confirmOnStartup(): Promise<void> {
    const version = this.options.store.getVersion()
    if (!version.pendingVersion) {
      this.publish({
        currentVersion: this.options.appVersion,
        message: version.lastMessage
      })
      await this.loadHistory()
      return
    }
    if (version.pendingVersion !== this.options.appVersion) {
      await this.options.store.updateVersion((draft) => {
        draft.lastMessage = `版本不一致：期望 ${version.pendingVersion}，实际 ${this.options.appVersion}`
      })
      await this.loadHistory()
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
      message: `已升级到 ${this.options.appVersion}`
    })
    await this.loadHistory()
  }

  /** 从升级包缓存还原出完整的归档目录，供 switch 脚本就位 */
  private async restoreArchiveFromPackage(packagePath: string, archiveDir: string): Promise<void> {
    await extractAppArchive(packagePath, archiveDir)
  }

  /**
   * 回退到指定历史版本：先改写版本状态，再启动 switch 脚本。
   * 历史版本已验证可运行，脚本就位后直接启动并退出，不进入确认等待。
   */
  async rollbackTo(versionId: string): Promise<void> {
    if (!isValidVersionDir(versionId)) throw new Error('版本号不合法')
    if (compareVersions(versionId, this.options.appVersion) === 0) {
      throw new Error('不能回退到当前正在运行的版本')
    }
    // 归档目录不存在时，尝试从升级包缓存还原。早期版本只留下升级包，没有
    // 这一步就无法回退。解压后统一走 switch 脚本，两条来源共用同一条路径。
    const archive = join(this.options.layout.updateHistoryDir, versionId)
    if (!existsSync(join(archive, APP_EXE_NAME))) {
      const packagePath = join(this.options.layout.updateDownloadDir, `EnvDock-${versionId}-app.zip`)
      if (!existsSync(packagePath)) throw new Error(`历史版本 ${versionId} 不存在或已损坏`)
      await this.restoreArchiveFromPackage(packagePath, archive)
    }
    await this.options.store.updateVersion((draft) => {
      draft.currentVersion = versionId
      draft.pendingVersion = null
      draft.previousVersion = null
      draft.lastMessage = `已回退到 ${versionId}`
    })
    await rm(this.options.layout.updateConfirmFile, { force: true })

    this.publish({ phase: 'restarting', message: `正在回退到 ${versionId}`, percent: 100 })
    await this.launchReplaceScript({
      mode: 'switch',
      fromVersion: this.options.appVersion,
      targetVersion: versionId
    })
    this.options.restart()
  }

  /** 兼容旧入口：回退到历史列表中的最新版本 */
  async rollback(): Promise<void> {
    const list = await this.loadHistory()
    const target = list.find((item) => item.launchable && compareVersions(item.version, this.options.appVersion) !== 0)
    if (!target) throw new Error('没有可回退的历史版本')
    await this.rollbackTo(target.version)
  }

  /** 删除指定历史版本，同时清理归档目录与升级包缓存；当前运行版本不可删除 */
  async discardVersion(versionId: string): Promise<void> {
    if (!isValidVersionDir(versionId)) throw new Error('版本号不合法')
    if (compareVersions(versionId, this.options.appVersion) === 0) {
      throw new Error('当前运行版本不能删除')
    }
    const dir = join(this.options.layout.updateHistoryDir, versionId)
    const packagePath = join(this.options.layout.updateDownloadDir, `EnvDock-${versionId}-app.zip`)
    const hasDir = existsSync(dir)
    const hasPackage = existsSync(packagePath)
    if (!hasDir && !hasPackage) {
      await this.loadHistory()
      return
    }

    if (hasDir) {
      const result = await removeDirectoryRobust(dir)
      if (!result.removed) {
        const hint = result.residue
          ? `文件仍被占用，已移至 ${result.residue}，重启后可手动删除`
          : '目录被占用，请关闭 EnvDock 后手动删除该版本目录'
        throw new Error(hint)
      }
    }
    if (hasPackage) await rm(packagePath, { force: true })

    await this.loadHistory()
    this.publish({ message: `已删除历史版本 ${versionId}` })
  }

  /** 兼容旧入口：删除历史列表中最旧的版本 */
  async discardOld(): Promise<void> {
    const list = await this.loadHistory()
    const target = [...list].sort((a, b) => compareVersions(a.version, b.version))[0]
    if (!target) return
    await this.discardVersion(target.version)
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

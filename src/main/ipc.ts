/**
 * IPC 处理器注册。
 *
 * 本模块是渲染进程与引擎之间唯一的桥。每个 handler 对应 IPC 契约中的
 * 一个方法，参数在此做基本校验，业务错误以 reject 传给渲染进程。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { IPC_CHANNELS, type ActivationRequest, type InstallRequest, type RelocateRequest } from '@shared/ipc'
import type { ToolId } from '@shared/domain'
import { parseRepoSlug } from '@shared/sources'
import { TOOL_METADATA } from '@shared/tools'
import { Engine } from './core/engine'
import { normalizeTargetRoot } from './core/paths'

const TOOL_IDS: ToolId[] = TOOL_METADATA.map((item) => item.id)

/** 窗口生命周期动作，由主进程注入，IPC 层不直接持有 BrowserWindow */
export interface WindowActions {
  hide: () => void
  minimize: () => void
  quit: () => void
  requestClose: () => void
  refreshTray: () => void
}

function assertToolId(value: unknown): ToolId {
  if (typeof value !== 'string' || !TOOL_IDS.includes(value as ToolId)) {
    throw new Error(`无效的工具标识：${String(value)}`)
  }
  return value as ToolId
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} 不能为空`)
  return value
}

/**
 * 注册全部 IPC handler。
 * 进度事件通过 webContents 主动推送，不放在 invoke 返回值里。
 */
export function registerIpc(engine: Engine, windows: WindowActions): void {
  ipcMain.handle(IPC_CHANNELS.bootstrap, async () => engine.bootstrap())

  ipcMain.handle(IPC_CHANNELS.windowHide, async () => windows.hide())
  ipcMain.handle(IPC_CHANNELS.windowMinimize, async () => windows.minimize())
  ipcMain.handle(IPC_CHANNELS.windowQuit, async () => windows.quit())
  ipcMain.handle(IPC_CHANNELS.windowClose, async () => windows.requestClose())
  ipcMain.handle(IPC_CHANNELS.refreshTray, async () => windows.refreshTray())

  ipcMain.handle(IPC_CHANNELS.listVersions, async (_event, toolId: unknown) =>
    engine.listVersions(assertToolId(toolId))
  )

  ipcMain.handle(IPC_CHANNELS.install, async (event, req: InstallRequest) => {
    assertToolId(req.toolId)
    assertString(req.versionId, 'versionId')
    const win = BrowserWindow.fromWebContents(event.sender)
    await engine.install(req.toolId, req.versionId)
    win?.webContents.send(IPC_CHANNELS.progress, {
      toolId: req.toolId,
      versionId: req.versionId,
      phase: 'done',
      percent: 100,
      message: '安装完成'
    })
    windows.refreshTray()
  })

  ipcMain.handle(IPC_CHANNELS.activate, async (_event, req: ActivationRequest) => {
    assertToolId(req.toolId)
    assertString(req.versionId, 'versionId')
    await engine.activate(req.toolId, req.versionId)
    windows.refreshTray()
  })

  ipcMain.handle(IPC_CHANNELS.deactivate, async (_event, req: { toolId: ToolId }) => {
    assertToolId(req.toolId)
    await engine.deactivate(req.toolId)
    windows.refreshTray()
  })

  ipcMain.handle(IPC_CHANNELS.uninstallVersion, async (_event, req: ActivationRequest) => {
    assertToolId(req.toolId)
    assertString(req.versionId, 'versionId')
    await engine.uninstallVersion(req.toolId, req.versionId)
    windows.refreshTray()
  })

  ipcMain.handle(IPC_CHANNELS.recheckHealth, async () => engine.healthCheck())

  ipcMain.handle(IPC_CHANNELS.checkUpdate, async () => engine.checkUpdate())
  ipcMain.handle(IPC_CHANNELS.applyUpdate, async () => engine.upgrade())
  ipcMain.handle(IPC_CHANNELS.clearUpdateResidue, async () => engine.clearUpdateResidue())
  ipcMain.handle(IPC_CHANNELS.getUpdateState, async () => engine.getUpdateState())
  ipcMain.handle(IPC_CHANNELS.checkProxy, async (_event, url: unknown, enabled: unknown) => {
    if (typeof url !== 'string' || typeof enabled !== 'boolean') throw new Error('代理探测参数不合法')
    return engine.checkProxy(url, enabled)
  })
  ipcMain.handle(IPC_CHANNELS.setUpdSource, async (_event, req: import('@shared/ipc').SetUpdateSourceRequest) => {
    if (typeof req?.sourceUrl !== 'string' || typeof req?.autoCheck !== 'boolean') {
      throw new Error('更新源参数不合法')
    }
    const sourceUrl = req.sourceUrl.trim()
    if (!parseRepoSlug(sourceUrl)) throw new Error('请填写有效的 GitHub 仓库地址，例如 https://github.com/owner/repo')
    return engine.setConfig({ update: { sourceUrl, autoCheck: req.autoCheck } })
  })

  ipcMain.handle(IPC_CHANNELS.setConfig, async (_event, req: Partial<import('@shared/domain').AppConfig>) =>
    engine.setConfig(req)
  )

  ipcMain.handle(IPC_CHANNELS.setPathIntegration, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须为布尔值')
    await engine.setConfig({ pathIntegration: enabled })
    return engine.setPathIntegration(enabled)
  })

  ipcMain.handle(IPC_CHANNELS.relocate, async (_event, req: RelocateRequest) => {
    assertString(req.targetRoot, 'targetRoot')
    return engine.relocate(normalizeTargetRoot(req.targetRoot))
  })

  ipcMain.handle(IPC_CHANNELS.uninstallAll, async () => {
    await engine.rollbackAll()
    const layout = engine.getLayout()
    // 回滚系统变更，再清理应用本体之外的全部环境数据。
    // app/ 保留：应用正在其中运行无法自删；绿色版的完整卸载由用户删除整个根目录完成。
    for (const name of ['runtimes', 'cache', 'scripts', 'current', 'updates', 'state.json', 'manifest.json', 'version.json', 'app.old']) {
      await rm(join(layout.root, name), { recursive: true, force: true })
    }
  })

  ipcMain.handle(IPC_CHANNELS.chooseDirectory, async (_event, title: unknown) => {
    const win = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: typeof title === 'string' && title.length > 0 ? title : '选择目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.openTerminal, async () => {
    const script = join(engine.getLayout().scriptsDir, 'activate.bat')
    // 进入交互式 shell 前先执行激活脚本，环境变量只在该终端进程内生效
    const { spawn } = await import('node:child_process')
    const child = spawn('cmd.exe', ['/K', script], {
      cwd: engine.getLayout().root,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
  })
}

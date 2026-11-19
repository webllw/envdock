import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { createLayout, resolveInstallRoot } from './core/paths'
import { Store } from './core/store'
import { Engine } from './core/engine'
import { registerIpc, type WindowActions } from './ipc'
import { createTray, refreshTray } from './core/tray'
import { IPC_CHANNELS } from '@shared/ipc'
import type { UpdateState } from '@shared/domain'

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'

let tray: Electron.Tray | null = null
let engine: Engine | null = null
let mainWindow: BrowserWindow | null = null
/** 区分用户主动退出与窗口关闭；只有前者才真正结束进程 */
let quitting = false

/**
 * 关闭窗口的统一决策入口，标题栏 X 与 Alt+F4 都汇入这里。
 * event 来自系统 close 事件，需要 preventDefault 才能拦下退出；
 * 由 IPC 主动触发时没有 event，窗口本身不会因此关闭。
 */
function handleClose(event?: Electron.Event): void {
  if (quitting) return
  event?.preventDefault()

  const behavior = engine?.getState().config.closeBehavior ?? 'ask'
  if (behavior === 'tray') {
    mainWindow?.hide()
    return
  }
  if (behavior === 'quit') {
    quitApp()
    return
  }

  // 未记住选择：交给渲染层弹出询问，用户确认后再执行对应动作
  mainWindow?.webContents.send(IPC_CHANNELS.closeRequest)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    // 无系统标题栏，窗口按钮由界面自绘；尺寸固定，不提供最大化与缩放
    frame: false,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow = win

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    void win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())

  // Alt+F4 与系统级关闭走同一套决策，避免绕过询问直接退出
  win.on('close', (event) => handleClose(event))

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

function showWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function minimizeWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
}

function quitApp(): void {
  quitting = true
  app.quit()
}

async function bootstrapEngine(): Promise<Engine> {
  const root = resolveInstallRoot()
  const layout = createLayout(root)
  const appVersion = app.getVersion()
  const store = new Store(layout, appVersion)

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  const instance = new Engine(layout, store, (event) => {
    broadcast(IPC_CHANNELS.progress, event)
  }, {
    appVersion,
    emitUpdate: (state: UpdateState) => broadcast(IPC_CHANNELS.updateProgress, state),
    // 升级替换脚本会在主进程退出后启动新版本，这里标记退出以绕过托盘隐藏
    restart: quitApp
  })
  await instance.init()
  return instance
}

// Electron 默认把 userData 写到 AppData；重定向到环境根目录，避免污染 C 盘
app.setPath('userData', join(resolveInstallRoot(), '.electron-data'))

void app.whenReady().then(async () => {
  try {
    engine = await bootstrapEngine()
    createWindow()

    const windowActions: WindowActions = {
      hide: () => mainWindow?.hide(),
      minimize: minimizeWindow,
      quit: quitApp,
      requestClose: () => handleClose(),
      refreshTray: () => refreshTray(tray)
    }
    registerIpc(engine, windowActions)

    tray = createTray(engine, { show: showWindow, quit: quitApp })

    app.on('activate', () => showWindow())
  } catch (error) {
    console.error('[envdock] 引擎初始化失败', error)
  }
})

// 窗口关闭不再结束进程，仅托盘菜单退出或记住"直接退出"时触发
app.on('window-all-closed', () => {
  if (quitting) app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { createLayout, resolveInstallRoot } from './core/paths'
import { Store } from './core/store'
import { Engine } from './core/engine'
import { registerIpc } from './ipc'
import { IPC_CHANNELS } from '@shared/ipc'
import type { UpdateState } from '@shared/domain'

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    void win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

async function bootstrapEngine(): Promise<void> {
  const root = resolveInstallRoot()
  const layout = createLayout(root)
  const appVersion = app.getVersion()
  const store = new Store(layout, appVersion)

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  // 升级替换脚本会在主进程退出后启动新版本，这里只负责干净退出
  const requestRestart = (): void => {
    app.quit()
  }

  const instance = new Engine(layout, store, (event) => {
    broadcast(IPC_CHANNELS.progress, event)
  }, {
    appVersion,
    emitUpdate: (state: UpdateState) => broadcast(IPC_CHANNELS.updateProgress, state),
    restart: requestRestart
  })
  await instance.init()
  registerIpc(instance)
}

// Electron 默认把 userData 写到 AppData；重定向到环境根目录，避免污染 C 盘
app.setPath('userData', join(resolveInstallRoot(), '.electron-data'))

void app.whenReady().then(async () => {
  try {
    await bootstrapEngine()
  } catch (error) {
    console.error('[envdock] 引擎初始化失败', error)
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

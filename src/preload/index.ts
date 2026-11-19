/**
 * 渲染进程与主进程之间的类型化桥。
 * 只暴露契约中声明的方法，不开放 ipcRenderer 本身。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type EnvdockApi } from '@shared/ipc'
import type {
  AppConfig,
  AppStateData,
  BootstrapPayload,
  HealthCheckItem,
  Manifest,
  ProgressEvent,
  ToolId,
  UpdateManifest,
  UpdateState,
  VersionInfo
} from '@shared/domain'

const api: EnvdockApi = {
  platform: process.platform,

  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap) as Promise<BootstrapPayload>,

  listVersions: (toolId: ToolId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listVersions, toolId) as Promise<VersionInfo[]>,

  install: (req) => ipcRenderer.invoke(IPC_CHANNELS.install, req) as Promise<void>,

  activate: (req) => ipcRenderer.invoke(IPC_CHANNELS.activate, req) as Promise<void>,

  deactivate: (req) => ipcRenderer.invoke(IPC_CHANNELS.deactivate, req) as Promise<void>,

  uninstallVersion: (req) => ipcRenderer.invoke(IPC_CHANNELS.uninstallVersion, req) as Promise<void>,

  recheckHealth: () =>
    ipcRenderer.invoke(IPC_CHANNELS.recheckHealth) as Promise<HealthCheckItem[]>,

  setConfig: (req) => ipcRenderer.invoke(IPC_CHANNELS.setConfig, req) as Promise<AppStateData>,

  setPathIntegration: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPathIntegration, enabled) as Promise<Manifest>,

  relocate: (req) => ipcRenderer.invoke(IPC_CHANNELS.relocate, req) as Promise<Manifest>,

  uninstallAll: () => ipcRenderer.invoke(IPC_CHANNELS.uninstallAll) as Promise<void>,

  chooseDirectory: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory, title) as Promise<string | null>,

  openTerminal: () => ipcRenderer.invoke(IPC_CHANNELS.openTerminal) as Promise<void>,

  checkUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.checkUpdate) as Promise<UpdateManifest | null>,
  applyUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.applyUpdate) as Promise<UpdateState>,
  rollbackUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.rollbackUpdate) as Promise<void>,
  discardOldVersion: () => ipcRenderer.invoke(IPC_CHANNELS.discardOldVersion) as Promise<void>,
  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateState) as Promise<UpdateState>,
  setUpdSource: (req) => ipcRenderer.invoke(IPC_CHANNELS.setUpdSource, req) as Promise<import('@shared/domain').AppStateData>,

  checkProxy: (url, enabled) => ipcRenderer.invoke(IPC_CHANNELS.checkProxy, url, enabled) as Promise<import('@shared/ipc').ProxyTestResult>,

  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ProgressEvent): void => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.progress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.progress, handler)
  },

  onUpdateProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdateState): void => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.updateProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.updateProgress, handler)
  }
}

contextBridge.exposeInMainWorld('envdock', api)

declare global {
  interface Window {
    envdock: EnvdockApi
  }
}

/** 供界面判断宿主接口是否可用；运行在纯浏览器预览时为 false */
export const isHostAvailable = typeof window !== 'undefined' && Boolean(window.envdock)

/** 配置类型导出，避免界面侧重复声明 */
export type { AppConfig }

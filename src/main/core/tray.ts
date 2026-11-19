/**
 * 系统托盘：常驻图标与快捷版本切换菜单。
 *
 * 窗口关闭时隐藏到托盘而非退出，退出只能从托盘菜单发起。
 * 菜单在每次弹出前重建，直接读取引擎的已装版本与全局激活状态，
 * 因此界面或托盘任一侧切换版本后，另一侧下次打开即为最新。
 */
import { Menu, Tray, nativeImage } from 'electron'
import type { LocalToolVersions } from '@shared/domain'
import { TRAY_ICON_DATA_URL } from '../tray-icon'
import type { Engine } from './engine'

export interface TrayActions {
  /** 显示并聚焦主窗口 */
  show: () => void
  /** 退出应用 */
  quit: () => void
}

function buildMenu(
  tools: LocalToolVersions[],
  actions: TrayActions,
  engine: Engine
): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: '显示主界面', click: actions.show },
    { type: 'separator' }
  ]

  let hasVersions = false
  for (const tool of tools) {
    if (tool.installed.length === 0) continue
    hasVersions = true
    const submenu: Electron.MenuItemConstructorOptions[] = tool.installed.map((version) => ({
      label: `${version}${version === tool.active ? '   当前' : ''}`,
      type: 'radio',
      checked: version === tool.active,
      click: () => {
        void engine.activate(tool.id, version).catch(() => undefined)
      }
    }))
    template.push({ label: tool.displayName, submenu })
  }

  if (!hasVersions) {
    template.push({ label: '尚未安装任何版本', enabled: false })
  }

  template.push({ type: 'separator' }, { label: '退出 EnvDock', click: actions.quit })
  return Menu.buildFromTemplate(template)
}

/**
 * 创建托盘图标并挂接菜单。
 *
 * 左键点击显示主窗口；右键弹出动态菜单。返回的对象额外挂 refreshTray，
 * 供界面侧在激活版本变化后重建菜单，避免下次右键读到过期快照。
 */
export function createTray(engine: Engine, actions: TrayActions): Tray {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  const tray = new Tray(icon)
  tray.setToolTip('EnvDock')

  const refresh = (): void => {
    void engine.localVersions().then((tools) => {
      tray.setContextMenu(buildMenu(tools, actions, engine))
    })
  }

  tray.on('click', actions.show)
  tray.on('right-click', () => {
    void engine.localVersions().then((tools) => {
      tray.popUpContextMenu(buildMenu(tools, actions, engine))
    })
  })
  refresh()

  return Object.assign(tray, { refreshTray: refresh })
}

/** 请求托盘重建菜单；无托盘时安全返回 */
export function refreshTray(tray: Tray | null): void {
  const hook = (tray as (Tray & { refreshTray?: () => void }) | null)?.refreshTray
  hook?.()
}

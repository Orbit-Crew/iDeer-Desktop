import { app, Menu, nativeImage, Tray } from 'electron'
import { trayIconPng } from './trayIcon'

/**
 * Issue 86: the tray's thin wiring. The context menu carries exactly two
 * entries — 显示主窗口 and 退出 — and a plain click acts like 显示主窗口, the
 * same show+focus surface a notification click already uses. Everything
 * decision-shaped (when an exit drains, when a close hides) lives in
 * lifecycle.ts; this module only builds the Tray.
 */

export const TRAY_TOOLTIP = 'iDeer Desktop'
export const TRAY_SHOW_LABEL = '显示主窗口'
export const TRAY_EXIT_LABEL = '退出'

export interface TrayActions {
  onShow(): void
  onExit(): void
}

/** The app's own executable icon when the platform can provide it, the drawn
 * disc otherwise — no new binary asset either way. */
async function loadTrayIcon(): Promise<Electron.NativeImage> {
  try {
    const icon = await app.getFileIcon(process.execPath)
    if (!icon.isEmpty()) return icon
  } catch { /* The drawn icon below is the fallback. */ }
  return nativeImage.createFromBuffer(trayIconPng())
}

export async function createAppTray(actions: TrayActions): Promise<Tray> {
  const tray = new Tray(await loadTrayIcon())
  tray.setToolTip(TRAY_TOOLTIP)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: TRAY_SHOW_LABEL, click: () => actions.onShow() },
    { label: TRAY_EXIT_LABEL, click: () => actions.onExit() }
  ]))
  tray.on('click', () => actions.onShow())
  return tray
}

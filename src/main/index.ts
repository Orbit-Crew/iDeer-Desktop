// Node 16 compatibility runs in the build banner before any imports.
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createMainWindow } from './window'
import type { DesktopStatus } from '../shared/desktop'
import { RuntimeProcess } from './runtime'

// Set before ready and before any session, store or window is created.
app.setName('iDeer Desktop')
const userData = join(app.getPath('appData'), 'iDeer Desktop')
app.setPath('userData', userData)
mkdirSync(userData, { recursive: true })
mkdirSync(join(userData, 'Session'), { recursive: true })
app.setPath('sessionData', join(userData, 'Session'))
app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  const runtime = new RuntimeProcess(
    app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.runtime'),
    join(userData, 'Runtime')
  )
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void runtime.stop().finally(() => app.quit())
  })

  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.orbitcrew.ideer.desktop')
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ label: '退出应用', role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'selectAll' }] }
    ]))
    mainWindow = createMainWindow()
    void runtime.start()

    const requireMainFrame = (event: Electron.IpcMainInvokeEvent): void => {
      if (!mainWindow || event.sender !== mainWindow.webContents ||
          event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('Untrusted desktop IPC sender')
      }
    }

    ipcMain.handle('desktop:status', (event): DesktopStatus => {
      requireMainFrame(event)
      const status = runtime.status()
      return { version: app.getVersion(), server: status.connection, runtime: status }
    })
    ipcMain.handle('desktop:runtime:start', (event) => {
      requireMainFrame(event)
      return runtime.start()
    })
    ipcMain.handle('desktop:runtime:stop', (event) => {
      requireMainFrame(event)
      return runtime.stop()
    })
    ipcMain.handle('desktop:quit', (event) => {
      requireMainFrame(event)
      // Let invoke resolve before destroying its renderer.
      setImmediate(() => app.quit())
    })
  }).catch((error: unknown) => {
    dialog.showErrorBox('iDeer Desktop 启动失败', String(error))
    app.exit(1)
  })

  app.on('window-all-closed', () => app.quit())
}

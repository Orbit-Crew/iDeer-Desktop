// Node 16 compatibility runs in the build banner before any imports.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMainWindow } from './window'
import type { DesktopStatus, UpdateCheckResult } from '../shared/desktop'
import { RuntimeProcess } from './runtime'
import { checkOnline, verifyUpdate, type UpdateVerification } from './updates'

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
    ipcMain.handle('desktop:workspace:choose', async (event) => {
      requireMainFrame(event)
      if (runtime.status().login?.state !== 'authenticated') throw new Error('WORKSPACE_UNAVAILABLE')
      const binding = runtime.workspaceScope()
      const chosen = await dialog.showOpenDialog(mainWindow!, { title: '选择工作目录', properties: ['openDirectory'] })
      if (chosen.canceled || chosen.filePaths.length !== 1) return
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '确认工作目录的数据边界',
        message: '允许本次账号与设备读取此目录？写入可在聊天中选择逐次或持续授权。',
        detail: `${chosen.filePaths[0]}\n\n仅在会话请求列举、读取或搜索时，将所需文件名或文本发送到 Server 和模型。不会自动上传整个目录。模型仅能看到逻辑目录。目录不会登记为平台 Resource。授权保存在本机，同账号与设备重启后继续有效。切换目录将使旧路径失效。`,
        buttons: ['取消', '确认目录授权'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (runtime.workspaceScope() !== binding) throw new Error('WORKSPACE_BINDING_CHANGED')
      if (confirmation.response === 1) await runtime.selectWorkspace(chosen.filePaths[0], binding)
    })
    ipcMain.handle('desktop:chat', (event, command) => {
      requireMainFrame(event)
      return runtime.chat(command)
    })
    ipcMain.handle('desktop:manage', (event, action, grantId) => {
      requireMainFrame(event)
      return runtime.manage(action, grantId)
    })
    ipcMain.handle('desktop:receipts', async (event, action, offset = 0) => {
      requireMainFrame(event)
      if (!['history', 'clear-confirmed'].includes(action)) throw new Error('RECEIPT_ACTION_INVALID')
      const receiptScope = runtime.receiptOwnershipScope()
      if (action === 'clear-confirmed') {
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '清理已确认回执', message: '清理已由 Server 确认的回执详情？',
          detail: '未确认和结果待核实的记录会保留。清理后仍保留任务归属与清理标记，不会再次执行操作。',
          buttons: ['取消', '清理已确认记录'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (runtime.receiptOwnershipScope() !== receiptScope) throw new Error('RECEIPT_BINDING_CHANGED')
        if (confirmation.response !== 1) return runtime.receipts('history', offset)
      }
      return runtime.receipts(action, offset, receiptScope)
    })
    ipcMain.handle('desktop:runtime:start', (event) => {
      requireMainFrame(event)
      return runtime.start()
    })
    ipcMain.handle('desktop:runtime:stop', (event) => {
      requireMainFrame(event)
      return runtime.stop()
    })
    ipcMain.handle('desktop:login:begin', async (event, server: string, deviceName: string) => {
      requireMainFrame(event)
      const url = await runtime.beginLogin(server, deviceName)
      await shell.openExternal(url)
    })
    // Issue 107: online check and offline import only verify and stage a
    // pending update in memory. Neither path installs anything, touches the
    // program directory, or needs any secret.
    const bundledRuntimePython = (): string => {
      try {
        const runtimeDirectory = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.runtime')
        return JSON.parse(readFileSync(join(runtimeDirectory, 'distribution.lock.json'), 'utf8')).python || ''
      } catch { return '' }
    }
    const updateCurrent = () => ({ desktopVersion: app.getVersion(), runtimePython: bundledRuntimePython(), protocolVersion: 1 })
    // The pinned verification key ships inside the app; production rotates it.
    const publicKeyPem = readFileSync(app.isPackaged
      ? join(process.resourcesPath, 'updates/updates-public-key.pem')
      : join(app.getAppPath(), 'resources/updates/updates-public-key.pem'), 'utf8')
    const toView = (result: UpdateVerification): UpdateCheckResult => result.pending ? { ok: true, error: '', pending: {
      kind: result.pending.kind, source: result.pending.source, verifiedAt: result.pending.verifiedAt,
      advice: result.pending.advice, desktopVersion: result.pending.manifest.desktop.version,
      runtimePython: result.pending.manifest.runtime.python,
      serverCompatibility: result.pending.manifest.serverCompatibility,
      fileCount: result.pending.manifest.files.length, deletionCount: result.pending.manifest.deletions.length } }
      : { ok: result.ok, error: result.error, pending: null }
    ipcMain.handle('desktop:updates:check', async (event): Promise<UpdateCheckResult> => {
      requireMainFrame(event)
      const origin = runtime.serverOrigin()
      if (!origin) throw new Error('UPDATE_ORIGIN_UNKNOWN')
      return toView(await checkOnline(origin, updateCurrent(), publicKeyPem))
    })
    ipcMain.handle('desktop:updates:import', async (event): Promise<UpdateCheckResult> => {
      requireMainFrame(event)
      const chosen = await dialog.showOpenDialog(mainWindow!, {
        title: '导入离线更新清单', filters: [{ name: '更新清单 (manifest.json)', extensions: ['json'] }], properties: ['openFile'] })
      if (chosen.canceled || chosen.filePaths.length !== 1) return { ok: false, error: 'UPDATE_IMPORT_CANCELED', pending: null }
      const manifestPath = chosen.filePaths[0]
      const manifestText = readFileSync(manifestPath, 'utf8')
      const signatureHex = readFileSync(manifestPath + '.sig', 'utf8').trim()
      return toView(verifyUpdate(manifestText, signatureHex, publicKeyPem, updateCurrent(), 'offline'))
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

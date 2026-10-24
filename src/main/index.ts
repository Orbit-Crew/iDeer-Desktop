// Node 16 compatibility runs in the build banner before any imports.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMainWindow } from './window'
import type { DesktopStatus, InstallOutcome, UpdateCheckResult } from '../shared/desktop'
import { RuntimeProcess } from './runtime'
import { checkOnline, verifyUpdate, type PendingUpdate, type UpdateVerification } from './updates'
import { applyPatch, requestInstall } from './installer'
import { blocksLocalTask, checkCompatibility, type CompatibilityDeclaration } from './compat'
import { backupTargets, readRecoveryState, resolveRestart, writeRecoveryState, type RecoveryState } from './recovery'

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
  // Issue 109: the recovery record survives restarts in the user-data area.
  let recovery: RecoveryState | null = null
  // Issue 110: the signed compatibility gate for the running combination.
  let compatibility: CompatibilityDeclaration | null = null
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
      // The gate stops new local work at the declared level; it never grants
      // anything, and history, records and reads stay available throughout.
      if (blocksLocalTask(compatibility, command)) throw new Error('COMPAT_TASK_STOPPED')
      return runtime.chat(command)
    })
    ipcMain.handle('desktop:compatibility:refresh', async (event) => {
      requireMainFrame(event)
      const origin = runtime.serverOrigin()
      if (!origin) throw new Error('COMPAT_ORIGIN_UNKNOWN')
      const evaluation = await checkCompatibility(origin, publicKeyPem, { protocolVersion: 1 })
      compatibility = evaluation.declaration
      return evaluation.declaration ? {
        level: evaluation.declaration.level, disabledCapabilities: evaluation.declaration.disabledCapabilities,
        notes: evaluation.declaration.notes, advice: evaluation.advice,
        candidateCombo: evaluation.declaration.candidateCombo } : { error: evaluation.error }
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
    let lastPending: PendingUpdate | null = null
    let lastPendingManifestPath = ''
    // Patches apply inside the installed program directory only; a dev checkout refuses.
    const programRoot = (): string => {
      if (!app.isPackaged) throw new Error('UPDATE_PACKAGED_ONLY')
      return join(process.resourcesPath)
    }
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
      const verification = verifyUpdate(manifestText, signatureHex, publicKeyPem, updateCurrent(), 'offline')
      // The full verified manifest is kept in memory for the installer; the
      // renderer only ever sees the summary view.
      lastPending = verification.pending
      lastPendingManifestPath = verification.pending ? manifestPath : ''
      return toView(verification)
    })
    // Issue 108: the only install entry. It requires the verified pending
    // state, an explicit user confirmation, and the drain coordinator.
    // Issue 109: a failed or rolled-back recovery disables further automatic
    // installs until manual repair; user data is never a recovery target.
    recovery = readRecoveryState(userData)
    const recoveryBlocked = (): boolean => recovery?.state === 'recovery-failed'
    ipcMain.handle('desktop:updates:recovery', (event): RecoveryState | null => {
      requireMainFrame(event)
      return recovery
    })
    ipcMain.handle('desktop:updates:install', async (event): Promise<InstallOutcome> => {
      requireMainFrame(event)
      if (recoveryBlocked()) throw new Error('UPDATE_RECOVERY_LOCKED')
      if (!lastPending) throw new Error('UPDATE_NOT_STAGED')
      const outcome = await requestInstall(lastPending, {
        status: () => runtime.status(),
        drain: (action) => runtime.installDrain(action),
        confirm: async (pending) => {
          const confirmation = await dialog.showMessageBox(mainWindow!, {
            type: 'question', title: '确认安装更新',
            message: pending.kind === 'full'
              ? '已验证的更新要求完整安装包。排空任务并停止本程序后,将运行安装包。'
              : '已验证的补丁将在此设备应用。排空任务并停止本程序后,写入程序目录并重启。',
            detail: `目标组合:Desktop ${pending.manifest.desktop.version} · Runtime Python ${pending.manifest.runtime.python}\n` +
              `文件 ${pending.manifest.files.length} 个,删除 ${pending.manifest.deletions.length} 项。\n` +
              '在途任务会等待其终态;超时不视为排空完成,未确认回执会保留。',
            buttons: ['取消', '确认并排空安装'], defaultId: 0, cancelId: 0, noLink: true })
          return confirmation.response === 1
        },
        apply: (files, deletions) => {
          // Issue 109: every overwritten or deleted file is backed up first so
          // a failed restart verification can restore the exact prior bytes.
          const stamp = String(Date.now())
          backupTargets({ manifest: { files, deletions } } as PendingUpdate, programRoot(), stamp)
          return applyPatch({ manifest: { files, deletions } } as PendingUpdate,
            lastPendingManifestPath ? join(lastPendingManifestPath, '..') : '', programRoot())
        },
        launch: async (installerPath) => {
          const { spawn } = await import('node:child_process')
          if (!installerPath) throw new Error('UPDATE_FULL_INSTALLER_UNAVAILABLE')
          spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore', shell: false }).unref()
        },
        quit: () => new Promise(resolveQuit => { setImmediate(() => { app.quit(); resolveQuit() }) })
      }, { programRoot: programRoot() })
      if (outcome.installed && lastPending) {
        recovery = { state: 'applied-pending-verify', stamp: String(Date.now()), programRoot: programRoot(),
          desktopVersion: lastPending.manifest.desktop.version, runtimePython: lastPending.manifest.runtime.python,
          detail: 'waiting for the restart to verify the installed combination' }
        writeRecoveryState(userData, recovery)
      }
      return outcome
    })
    // Issue 109: one-shot restart verification of a previously applied update.
    recovery = readRecoveryState(userData)
    if (recovery?.state === 'applied-pending-verify') {
      const backupDir = join(recovery.programRoot, 'resources', 'updates', `backup-${recovery.stamp}`)
      recovery = resolveRestart(recovery, lastPending, existsSync(join(backupDir, 'backup-manifest.json')) ? backupDir : null,
        userData, { desktopVersion: app.getVersion(), runtimePython: bundledRuntimePython() })
    }
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

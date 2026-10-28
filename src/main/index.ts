// Node 16 compatibility runs in the build banner before any imports.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createMainWindow } from './window'
import type { DesktopStatus, InstallOutcome, KnowledgeGraphCommand, KnowledgeImportOutcome, KnowledgePublishOutcome, SkillCommand, SkillImportPreview, UpdateCheckResult, WikiCommand } from '../shared/desktop'
import { RuntimeProcess } from './runtime'
import { downloadThreadArtifact } from './artifact-download'
import { type PendingUpdate, type UpdateVerification } from './updates'
import { UpdateService } from './update-stage'
import { requestInstall } from './installer'
import { initializeDataFormat, readDataFormat, readRecoveryState, type RecoveryState } from './recovery'
import { captureOwnedProcessTree, launchMaintenance, prepareTransaction } from './maintenance'
import { serveMaintenanceHealth, stopMaintenanceRuntime } from './maintenance-health'

// Set before ready and before any session, store or window is created.
app.setName('iDeer Desktop')
const selectedUserData = app.commandLine.getSwitchValue('user-data-dir')
if (selectedUserData && !isAbsolute(selectedUserData)) throw new Error('USER_DATA_DIRECTORY_MUST_BE_ABSOLUTE')
const userData = selectedUserData || join(app.getPath('appData'), 'iDeer Desktop')
const maintenanceId = app.commandLine.getSwitchValue('ideer-maintenance')
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
    join(userData, 'Runtime'), Boolean(maintenanceId), app.getVersion()
  )
  let quitting = false
  // Issue 109: the recovery record survives restarts in the user-data area.
  let recovery: RecoveryState | null = null
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

  app.whenReady().then(async () => {
    recovery = readRecoveryState(userData)
    const helperScript = join(app.getAppPath(), 'out/main/update-helper.cjs')
    if (recovery?.state === 'applied-pending-verify' && !maintenanceId) {
      if (!recovery.journalPath) throw new Error('UPDATE_RECOVERY_JOURNAL_MISSING_MANUAL_REPAIR')
      await launchMaintenance(recovery.journalPath, helperScript)
      app.quit()
      return
    }
    initializeDataFormat(userData)
    app.setAppUserModelId('com.orbitcrew.ideer.desktop')
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ label: '退出应用', role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'selectAll' }] }
    ]))
    await runtime.start()
    const maintenanceSession = maintenanceId ? await serveMaintenanceHealth({ id: maintenanceId, userData, executable: process.execPath,
      desktopVersion: app.getVersion(), electronVersion: process.versions.electron, runtime,
      quit: async () => { app.quit() } }) : null
    if (maintenanceId && !maintenanceSession) return
    mainWindow = createMainWindow()
    if (maintenanceSession) {
      const healthWindow = mainWindow
      let loadFailed = false
      healthWindow.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame) { loadFailed = true; maintenanceSession.failed() }
      })
      healthWindow.webContents.once('did-finish-load', () => {
        if (loadFailed) return
        // This fixed query traverses the shipped preload and actual trusted
        // main-frame IPC handler after all handlers below are registered.
        void healthWindow.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 20000
          while (!document.querySelector('[data-desktop-ready="true"]')) {
            if (Date.now() > deadline) throw new Error('UPDATE_RENDERER_NOT_READY')
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          return window.ideer.getStatus()
        })()`, true)
          .then((observed: DesktopStatus) => maintenanceSession.usable(observed))
          .catch(() => maintenanceSession.failed())
      })
    }

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
    ipcMain.handle('desktop:chat', async (event, command) => {
      requireMainFrame(event)
      // The gate stops new local work at the declared level; it never grants
      // anything, and history, records and reads stay available throughout.
      if (command?.action === 'download') {
        return downloadThreadArtifact(runtime, command, async (name) => {
          if (!mainWindow) throw new Error('DOWNLOAD_WINDOW_UNAVAILABLE')
          const selected = await dialog.showSaveDialog(mainWindow, { title: '保存平台附件',
            defaultPath: name, buttonLabel: '保存附件', properties: ['showOverwriteConfirmation'] })
          return selected.canceled ? undefined : selected.filePath
        })
      }
      return runtime.chat(command)
    })
    ipcMain.handle('desktop:compatibility:refresh', async (event) => {
      requireMainFrame(event)
      const origin = runtime.serverOrigin()
      if (!origin) throw new Error('COMPAT_ORIGIN_UNKNOWN')
      const state = await runtime.chat({ action: 'compatibility' })
      return state.compatibility || { error: state.error || 'COMPAT_RUNTIME_UNAVAILABLE' }
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
      if (maintenanceBusy()) throw new Error('UPDATE_INSTALL_BUSY')
      return runtime.start()
    })
    // Issue 112: the explicit import flow. The renderer only chooses the
    // platform KB identity; file picking and the content boundary confirmation
    // stay in the trusted main process.
    ipcMain.handle('desktop:knowledge:import', async (event, kbId: string): Promise<KnowledgeImportOutcome> => {
      requireMainFrame(event)
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_IMPORT_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE')
      if (typeof kbId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(kbId)) throw new Error('KNOWLEDGE_IMPORT_KB_INVALID')
      const chosen = await dialog.showOpenDialog(mainWindow!, {
        title: '选择要导入的文件', properties: ['openFile', 'multiSelections'] })
      if (chosen.canceled || !chosen.filePaths.length) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '确认本地知识导入',
        message: '在设备侧解析所选文件，并在平台登记你的私有知识库新版本？',
        detail: '仅登记文件名、大小、类型与 SHA-256 指纹清单；原文件与设备侧索引不会自动上传。每次导入生成一个新的不可变版本，不覆盖已登记版本。',
        buttons: ['取消', '确认导入'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      return runtime.importKnowledge(kbId, chosen.filePaths)
    })
    // Issue 115: the explicit server publication flow. The preview step is
    // read-only; content leaves the device only after the owner has seen the
    // destination and confirmed in the trusted main process.
    ipcMain.handle('desktop:knowledge:publish', async (
      event, kbId: string, revisionId: string): Promise<KnowledgePublishOutcome> => {
      requireMainFrame(event)
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_PUBLISH_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('KNOWLEDGE_PUBLISH_WORKSPACE_UNAVAILABLE')
      if (typeof kbId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(kbId)) throw new Error('KNOWLEDGE_PUBLISH_KB_INVALID')
      if (typeof revisionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revisionId)) throw new Error('KNOWLEDGE_PUBLISH_REVISION_INVALID')
      const chosen = await dialog.showOpenDialog(mainWindow!, {
        title: '选择要发布到服务端的文件', properties: ['openFile', 'multiSelections'] })
      if (chosen.canceled || !chosen.filePaths.length) throw new Error('KNOWLEDGE_PUBLISH_CANCELED')
      const preview = await runtime.publishKnowledge(kbId, revisionId, chosen.filePaths, false)
      if (preview.confirmed !== false) throw new Error('KNOWLEDGE_PUBLISH_FAILED')
      const summary = preview.documents.map((document) =>
        `${document.filename}（${document.mime}，${document.bytes} 字节）`).join('、')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '确认发布到服务端知识库',
        message: `将所选内容上传到平台新建的独立服务端知识库「${preview.destination.displayName}」？`,
        detail: `包含文件：${summary}\n\n服务端副本初始为私有；团队访问必须经过平台可见性申请与审批。你设备上的知识库保持私有，不改变可见性，也不会自动双向同步。取消则不会上传任何内容。`,
        buttons: ['取消，不上传', '确认发布'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_PUBLISH_CANCELED')
      return (await runtime.publishKnowledge(kbId, revisionId, chosen.filePaths, true)) as KnowledgePublishOutcome
    })
    // Issue 116: the controlled knowledge-graph entry. The renderer only
    // names the authorized KB/Revision and the action; the Server owns the
    // graph, and a source locate answers with this device's own workspace
    // path, which never leaves the machine.
    ipcMain.handle('desktop:knowledge:graph', (event, command: KnowledgeGraphCommand) => {
      requireMainFrame(event)
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_GRAPH_UNAUTHENTICATED')
      return runtime.knowledgeGraph(command)
    })
    // Issue 118: the controlled wiki entry. The renderer only names the
    // authorized KB/Revision and the action; the Server owns every page and
    // its authorization, and no page body is fetched or cached anywhere else.
    ipcMain.handle('desktop:knowledge:wiki', (event, command: WikiCommand) => {
      requireMainFrame(event)
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_WIKI_UNAUTHENTICATED')
      return runtime.knowledgeWiki(command)
    })
    // Issue 120: the skill package import flow. Package picking, the
    // device-side preview, and the upload confirmation stay in the trusted
    // main process: the preview uploads nothing, a canceled flow never
    // leaves the device, and the confirmed upload lands a private draft that
    // only the platform's own draft/publish flow can turn into a version.
    ipcMain.handle('desktop:skills', async (event, command: SkillCommand): Promise<SkillImportPreview | { confirmed: true; resourceId: string; slug: string; revision: number; contentHash: string; fileCount: number; totalBytes: number } | { resourceId: string; version: number; contentHash: string }> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' || !['import', 'publish'].includes(command.action)) throw new Error('SKILL_COMMAND_INVALID')
      const status = runtime.status()
      if (command.action === 'import') {
        if (status.login?.state !== 'authenticated') throw new Error('SKILL_IMPORT_UNAUTHENTICATED')
        if (!['markdown', 'zip', 'directory'].includes(command.kind)) throw new Error('SKILL_COMMAND_INVALID')
        const chosen = command.kind === 'directory'
          ? await dialog.showOpenDialog(mainWindow!, { title: '选择要导入的技能目录', properties: ['openDirectory'] })
          : await dialog.showOpenDialog(mainWindow!, { title: '选择要导入的技能包',
              filters: command.kind === 'markdown'
                ? [{ name: '技能 Markdown', extensions: ['md'] }]
                : [{ name: '技能包 (ZIP)', extensions: ['zip'] }], properties: ['openFile'] })
        if (chosen.canceled || chosen.filePaths.length !== 1) throw new Error('SKILL_IMPORT_CANCELED')
        // Step 1: the read-only device-side preview. Nothing uploads; the
        // exact upload scope — body excerpt, scripts, references, hashes —
        // is shown for confirmation.
        const preview = await runtime.importSkill(command.kind, chosen.filePaths, false)
        if (preview.confirmed !== false) throw new Error('SKILL_IMPORT_FAILED')
        const roleNames = { body: '正文', script: '脚本', reference: '引用', attachment: '附件' }
        const scope = preview.files.map(file => `${file.path}（${roleNames[file.role]}，${file.bytes} 字节）`).join('、')
        const excerpt = preview.bodyExcerpt.trim().slice(0, 600)
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认上传技能包',
          message: `将「${preview.name}」上传为你的私有平台技能草稿？`,
          detail: `正文摘录：${excerpt || '（空）'}\n\n上传范围：${scope}\n\n包指纹 ${preview.packageHash.slice(0, 16)}… 与上传内容绑定，平台校验一致后才会创建草稿。上传后的技能归属当前账号，初始为私有（private）；发布版本需另行确认，沿用平台既有的草稿校验与发布流程。取消则不会上传任何内容。`,
          buttons: ['取消，不上传', '确认上传'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('SKILL_IMPORT_CANCELED')
        // Step 2: the confirmed upload re-reads the exact bytes and lands the
        // private draft; publication stays a separate explicit step.
        return runtime.importSkill(command.kind, chosen.filePaths, true)
      }
      if (status.login?.state !== 'authenticated') throw new Error('SKILL_PUBLISH_UNAUTHENTICATED')
      if (typeof command.resourceId !== 'string' || !Number.isSafeInteger(command.expectedDraftRevision)) throw new Error('SKILL_COMMAND_INVALID')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '确认发布技能版本',
        message: '将该技能草稿发布为平台上的新版本副本？',
        detail: '发布沿用平台既有的草稿校验与发布流程，生成新的不可变版本副本；已固定该技能版本的任务不受新版本影响。',
        buttons: ['取消', '确认发布'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('SKILL_PUBLISH_CANCELED')
      return runtime.publishSkill(command.resourceId, command.expectedDraftRevision)
    })
    ipcMain.handle('desktop:runtime:stop', (event) => {
      requireMainFrame(event)
      if (maintenanceBusy()) throw new Error('UPDATE_INSTALL_BUSY')
      return runtime.stop()
    })
    ipcMain.handle('desktop:login:begin', async (event, server: string, deviceName: string) => {
      requireMainFrame(event)
      if (maintenanceBusy()) throw new Error('UPDATE_INSTALL_BUSY')
      const url = await runtime.beginLogin(server, deviceName)
      await shell.openExternal(url)
    })
    // Both entries publish only a complete verified release in the private
    // profile staging area. Installation still requires a separate consent.
    const bundledRuntimePython = (): string => {
      try {
        const runtimeDirectory = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.runtime')
        return JSON.parse(readFileSync(join(runtimeDirectory, 'distribution.lock.json'), 'utf8')).python || ''
      } catch { return '' }
    }
    const updateCurrent = () => ({ desktopVersion: app.getVersion(), electronVersion: process.versions.electron,
      runtimePython: bundledRuntimePython(), protocolVersion: 1, dataFormat: readDataFormat(userData), readableFormats: [1] })
    // The pinned verification key ships inside the app; production rotates it.
    const publicKeyPem = readFileSync(app.isPackaged
      ? join(process.resourcesPath, 'updates/updates-public-key.pem')
      : join(app.getAppPath(), 'resources/updates/updates-public-key.pem'), 'utf8')
    const updates = new UpdateService({ directory: join(userData, 'Updates'), publicKeyPem, current: updateCurrent })
    const startupUpdate = !maintenanceId && existsSync(join(userData, 'Updates/pending.json')) ? updates.restore() : null
    let lastPending: PendingUpdate | null = startupUpdate?.pending || null
    // Patches apply inside the installed program directory only; a dev checkout refuses.
    const programRoot = (): string => {
      if (!app.isPackaged) throw new Error('UPDATE_PACKAGED_ONLY')
      return dirname(process.execPath)
    }
    const toView = (result: UpdateVerification): UpdateCheckResult => result.pending ? { ok: true, error: '', pending: {
      kind: result.pending.kind, source: result.pending.source, verifiedAt: result.pending.verifiedAt,
      advice: result.pending.advice, desktopVersion: result.pending.manifest.desktop.version,
      runtimePython: result.pending.manifest.runtime.python,
      serverCompatibility: result.pending.manifest.serverCompatibility,
      fileCount: result.pending.manifest.files.length, deletionCount: result.pending.manifest.deletions.length } }
      : { ok: result.ok, error: result.error, pending: null }
    ipcMain.handle('desktop:updates:check', async (event, mode?: unknown, ...extra: unknown[]): Promise<UpdateCheckResult> => {
      requireMainFrame(event)
      if ((mode !== undefined && mode !== 'staged') || extra.length) throw new Error('UPDATE_ACTION_INVALID')
      if (mode === 'staged') {
        const result = updates.readStaged()
        lastPending = result.pending
        return toView(!result.pending && startupUpdate?.error ? { ok: false, error: startupUpdate.error, pending: null } : result)
      }
      if (installing || recoveryBlocked()) throw new Error('UPDATE_INSTALL_BUSY')
      updates.cancel()
      lastPending = null
      const origin = runtime.serverOrigin()
      if (!origin) throw new Error('UPDATE_ORIGIN_UNKNOWN')
      const result = await updates.check(origin)
      lastPending = updates.staged?.pending || null
      return toView(result)
    })
    ipcMain.handle('desktop:updates:import', async (event): Promise<UpdateCheckResult> => {
      requireMainFrame(event)
      if (installing || recoveryBlocked()) throw new Error('UPDATE_INSTALL_BUSY')
      updates.cancel()
      lastPending = null
      const chosen = await dialog.showOpenDialog(mainWindow!, {
        title: '导入离线更新清单', filters: [{ name: '更新清单 (manifest.json)', extensions: ['json'] }], properties: ['openFile'] })
      const verification = await updates.import(chosen.canceled || chosen.filePaths.length !== 1 ? null : chosen.filePaths[0])
      lastPending = updates.staged?.pending || null
      return toView(verification)
    })
    // Online and offline staging share the same confirmed, drain-safe handoff.
    recovery = readRecoveryState(userData)
    let installing = false
    const maintenanceBusy = (): boolean => installing || readRecoveryState(userData)?.state === 'applied-pending-verify'
    const recoveryBlocked = (): boolean => {
      const state = readRecoveryState(userData)
      return Boolean(state && state.state !== 'updated')
    }
    ipcMain.handle('desktop:updates:recovery', (event): RecoveryState | null => {
      requireMainFrame(event)
      return readRecoveryState(userData)
    })
    ipcMain.handle('desktop:updates:install', async (event): Promise<InstallOutcome> => {
      requireMainFrame(event)
      if (installing) throw new Error('UPDATE_INSTALL_BUSY')
      if (recoveryBlocked()) throw new Error('UPDATE_RECOVERY_LOCKED')
      if (!lastPending) throw new Error('UPDATE_NOT_STAGED')
      installing = true
      try {
        const staged = updates.validateStaged()
        let relatedPids: number[] = []
        return await requestInstall(staged.pending, {
          status: () => runtime.status(),
          drain: action => runtime.installDrain(action),
          stop: async () => {
            relatedPids = captureOwnedProcessTree(process.pid)
            await runtime.stopForInstall()
          },
          confirm: async pending => {
            const confirmation = await dialog.showMessageBox(mainWindow!, {
              type: 'question', title: '确认安装更新',
              message: '排空任务并停止程序后安装已签名的更新，然后核实 Desktop 和 Runtime 实际启动。',
              detail: `目标组合: Desktop ${pending.manifest.desktop.version} · Runtime Python ${pending.manifest.runtime.python}\n` +
                '写入效果不明、记录无法保存或进程不能停止时，不会修改程序。未确认回执会保留。',
              buttons: ['取消', '确认并排空安装'], defaultId: 0, cancelId: 0, noLink: true })
            return confirmation.response === 1
          },
          handoff: async () => {
            const verified = updates.validateStaged()
            if (verified.id !== staged.id) throw new Error('UPDATE_STAGE_CHANGED')
            const path = prepareTransaction({ stage: verified, programRoot: programRoot(), userData,
              executable: process.execPath, current: updateCurrent(), publicKeyPem, parentPid: process.pid, relatedPids })
            await launchMaintenance(path, helperScript)
          },
          quit: async () => { setImmediate(() => app.quit()) }
        })
      } finally { installing = false }
    })
    ipcMain.handle('desktop:quit', (event) => {
      requireMainFrame(event)
      // Let invoke resolve before destroying its renderer.
      setImmediate(() => app.quit())
    })
  }).catch((error: unknown) => {
    if (maintenanceId) {
      // A modal startup dialog would prevent the external helper from
      // confirming exit and safely restoring a failed candidate.
      void stopMaintenanceRuntime(runtime).then(() => app.exit(1)).catch(() => {})
      return
    }
    dialog.showErrorBox('iDeer Desktop 启动失败', String(error))
    app.exit(1)
  })

  app.on('window-all-closed', () => app.quit())
}

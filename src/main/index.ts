// Node 16 compatibility runs in the build banner before any imports.
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell, webContents } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createMainWindow } from './window'
import type { BrowserCommand, CadCommand, ConnectorCommand, ConnectorInternalOutcome, ConnectorOutcome, DatasetCommand, DatasetOperationView, DesktopStatus, FilesCommand, InstallOutcome, KnowledgeCleanupOutcome, KnowledgeDeleteOutcome, KnowledgeGraphCommand, KnowledgeImportOutcome, KnowledgePublishOutcome, ModelCommand, ModelSettingsView, NotificationCenterView, NotificationCommand, OfficialTemplateCommand, OfficialTemplatesView, PreferenceCommand, PreferencesView, ProjectCommand, ProjectOperationView, RuntimeNotifyEvent, ScheduleCommand, SchedulesOutcome, SkillCommand, SkillImportPreview, SkillPreferenceCommand, SkillPreferencesView, SkillScriptCommand, SkillScriptView, TemplateCommand, TemplateView, ThreadCommand, ThreadView, UpdateCheckResult, WikiCommand } from '../shared/desktop'
import { BROWSER_PARTITION } from '../shared/desktop'
import { BrowserPaneService } from './browserPane'
import { CadPaneService } from './cadPane'
import { loadOcctFromDirs } from './cad/stepToMesh'
import { AgentBrowserHub, type AgentBrowserPort } from './agentBrowser'
// Issue 86: the window lifecycle's decision layer (close-to-tray vs true
// exit) and the shell's device-local preference store.
import { drainForExit, EXIT_DRAIN_NOTES, shouldExitOnClose, shouldInterceptClose } from './lifecycle'
import { parsePreferenceCommand, ShellPreferenceStore } from './preferences'
import { createAppTray } from './tray'
import { RuntimeProcess } from './runtime'
import { RemoteBrowserHub } from './remoteBrowser'
import { TerminalSessions, startDirForProject } from './terminal'
import { formatDeclarationSummary } from './skillDeclaration'
import { NotificationRegistry, describeNotification } from './notifications'
import { downloadThreadArtifact } from './artifact-download'
import { exportChatTranscript } from './chat-export'
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
  // Issue 86: the shell's device-local window-lifecycle preference, owned by
  // main (a small userData JSON) because main alone decides at close time.
  const shellPreferences = new ShellPreferenceStore(join(userData, 'preferences.json'))
  let tray: Electron.Tray | null = null
  // Issue 86: the one true-exit entry. Tray 退出, the app menu's 退出应用, the
  // renderer's 退出应用 and a 关窗即退出 close all land here: stop admitting new
  // tasks on the owned Runtime, wait for the in-flight set within the same
  // bounded predicate the installer uses (aborting the drain on a timeout or
  // on blocked records, with an honest note), then hand to the existing
  // before-quit teardown. The hide-to-tray close never reaches this path, so
  // a resident window can never kill the Runtime.
  let exitRequested = false
  const requestExit = (): void => {
    if (exitRequested) return
    exitRequested = true
    void drainForExit({
      status: () => runtime.status(),
      drain: (action) => runtime.installDrain(action),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now
    })
      .then((outcome) => {
        if (outcome === 'drained' || !Notification.isSupported()) return
        new Notification({ title: 'iDeer Desktop 退出', body: EXIT_DRAIN_NOTES[outcome] }).show()
      })
      .catch(() => {})
      .finally(() => app.quit())
  }
  // Issue 110: the human terminal's desktop-local PTY sessions. They live in
  // memory only — a restart opens new sessions and never pretends old ones
  // survived — and every exit path kills them.
  let terminalSessions: TerminalSessions | null = null
  // Issue 109: the recovery record survives restarts in the user-data area.
  let recovery: RecoveryState | null = null
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    tray?.destroy()
    tray = null
    terminalSessions?.killAll()
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
    // Issue 86: the menu exit is a true exit, so it rides the same drain
    // coordinator as the tray and renderer exits instead of a bare quit.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ label: '退出应用', click: () => requestExit() }] },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'selectAll' }] }
    ]))
    await runtime.start()
    const maintenanceSession = maintenanceId ? await serveMaintenanceHealth({ id: maintenanceId, userData, executable: process.execPath,
      desktopVersion: app.getVersion(), electronVersion: process.versions.electron, runtime,
      quit: async () => { app.quit() } }) : null
    if (maintenanceId && !maintenanceSession) return
    // Issue 107: the browser pane's one fixed partition and its device-side
    // gates exist before any window loads, so a pane's first webview is
    // already guarded. The workspace root resolution rides the Runtime's own
    // guarded `files locate` path — the physical folder never leaves main.
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    const browserPane = new BrowserPaneService(browserSession, {
      push: (paneEvent) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:browser:events', paneEvent)
      },
      resolveWorkspaceRoot: async () => {
        const status = runtime.status()
        if (status.login?.state !== 'authenticated' || status.workspace?.state !== 'ready' ||
            !status.workspace.logicalRoot) return null
        try {
          const located = await runtime.files('locate', status.workspace.logicalRoot) as { physical?: unknown }
          return typeof located?.physical === 'string' && located.physical ? located.physical : null
        } catch {
          return null
        }
      },
      confirmClear: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: '清空浏览器分区',
          message: '清空浏览器窗格独立分区的全部站点数据？',
          detail: '将清除该分区内的 Cookie、站点存储与缓存：所有浏览器页签的登录态会被移除，需要重新登录。已下载到授权文件夹的文件不受影响；系统浏览器与平台凭据本就不在此分区。',
          buttons: ['取消', '确认清空'], defaultId: 0, cancelId: 0, noLink: true
        })
        return confirmation.response === 1
      },
      destroyPartitionGuests: () => {
        // A crashed renderer runs no JavaScript, so nothing can re-persist
        // after the wipe. Guests are out-of-process frames; this never takes
        // down the app's own renderer.
        for (const contents of webContents.getAllWebContents()) {
          if (contents.session === browserSession && !contents.isDestroyed()) contents.forcefullyCrashRenderer()
        }
      },
      clearStorage: async () => {
        await browserSession.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage', 'websql', 'shadercache'] })
        await browserSession.clearCache()
        await browserSession.clearAuthCache()
      }
    })
    browserPane.attachPartition()
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') browserPane.hardenGuest(contents)
    })
    // Issue 108: the agent's controlled channel into the pane. The Runtime
    // forwards one consented, tier-resolved action at a time; the hub
    // announces each action on the pane's fact channel before it runs and
    // bounds every fact on the way back. The port below is the only place
    // where the channel touches a real webContents, and every operation is
    // a fixed gesture — the channel can never run invented page code.
    const paneGuests = () => webContents.getAllWebContents().filter((contents) =>
      contents.session === browserSession && contents.getType() === 'webview' && !contents.isDestroyed())
    const paneGuest = (tabId: number | null) => {
      const guests = paneGuests()
      if (tabId !== null) {
        const named = guests.find((contents) => contents.id === tabId)
        if (!named) throw new Error('AGENT_BROWSER_NO_TAB')
        return named
      }
      if (guests.length !== 1) throw new Error('AGENT_BROWSER_NO_TAB')
      return guests[0]
    }
    const agentBrowserPort: AgentBrowserPort = {
      observe: async () => ({
        tabs: paneGuests().map((contents) => ({ id: contents.id, url: contents.getURL(), title: contents.getTitle() }))
      }),
      observeText: async (tabId) => {
        const contents = paneGuest(tabId)
        // One fixed read expression — never a caller-supplied script.
        const text = await contents.executeJavaScript('document.body ? document.body.innerText : ""', false)
        return { url: contents.getURL(), title: contents.getTitle(), text: typeof text === 'string' ? text : '' }
      },
      navigate: async (tabId, url) => {
        const contents = paneGuest(tabId)
        await contents.loadURL(url)
        return { url: contents.getURL() }
      },
      goBack: async (tabId) => {
        paneGuest(tabId).goBack()
        return {}
      },
      goForward: async (tabId) => {
        paneGuest(tabId).goForward()
        return {}
      },
      reload: async (tabId) => {
        paneGuest(tabId).reload()
        return {}
      },
      pressKey: async (key, tabId) => {
        const contents = paneGuest(tabId)
        contents.sendInputEvent({ type: 'rawKeyDown', keyCode: key })
        contents.sendInputEvent({ type: 'keyUp', keyCode: key })
        return {}
      },
      typeText: async (text, tabId) => {
        paneGuest(tabId).insertText(text)
        return {}
      },
      click: async (x, y, tabId) => {
        const contents = paneGuest(tabId)
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        return {}
      },
      submit: async (tabId) => {
        // 提交 means the focused form's own submit: an Enter keystroke on
        // the guest's focused element — no synthesized page script. Whether
        // a form actually submitted is unconfirmable from here, so the
        // result carries no submitted fact (效果待核实: no invented success).
        const contents = paneGuest(tabId)
        contents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        return {}
      },
      download: async (url) => {
        // The pane session's will-download gate routes this into the
        // confirmed workspace exactly like a human-started download.
        browserSession.downloadURL(url)
        return { queued: true }
      }
    }
    const agentBrowserHub = new AgentBrowserHub(agentBrowserPort, (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:browser:events', event)
    })
    runtime.onAgentBrowserCommand((id, command) => {
      void agentBrowserHub.handle(id, command).then((outcome) =>
        runtime.agentBrowserReply(id, outcome.result, outcome.error))
    })
    mainWindow = createMainWindow()
    // Issue 86: the tray-resident presence. A window close never quits by
    // itself: the resident default (and an in-flight exit) hides to the tray
    // with the Runtime, tasks, approvals and notifications untouched; with
    // 关窗即退出 the close IS the exit request and routes through the same
    // drain coordinator, so a close can never skip the drain. The teardown's
    // own closes (quitting) take the natural path — and so does the whole
    // update-maintenance helper instance: it has no tray icon, so a hide
    // there would be an unrestorable zombie window (review finding).
    mainWindow.on('close', (event) => {
      if (!shouldInterceptClose(Boolean(maintenanceId), quitting)) return
      event.preventDefault()
      mainWindow?.hide()
      if (shouldExitOnClose(shellPreferences.load().closeToTray, exitRequested)) requestExit()
    })
    // Issue 86: the tray. Click or 显示主窗口 restores and focuses the hidden
    // window (the same surface notifications jump back to); only the menu's
    // 退出 performs the true exit. The update-maintenance helper instance
    // stays tray-free — it is not a user-facing session.
    if (!maintenanceId) {
      tray = await createAppTray({
        onShow: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        },
        onExit: () => requestExit()
      })
    }
    // Issue 77: the Desktop's notification center. The owned Runtime reports
    // background-session facts; the trusted main process owns the ledger, the
    // OS toasts and the one push channel back to the renderer. Records made
    // before this point would have no window to reach, and the Runtime has
    // just started with no sessions to report — nothing is silently dropped.
    const notifications = new NotificationRegistry()
    const pushNotifications = (): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:notifications', notifications.list())
    }
    const activateNotification = (payload: { id: string; threadId: string }): void => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('desktop:notification:activate', payload)
    }
    runtime.onNotify((event: RuntimeNotifyEvent) => {
      const record = notifications.record(event)
      if (!record) return
      if (Notification.isSupported()) {
        // The one shared fact line (notifications.ts) keeps the toast and the
        // center pane wording identical; future event kinds extend the union
        // and the descriptor instead of this chat-agnostic handler.
        const copy = describeNotification(event)
        const toast = new Notification(copy)
        toast.on('click', () => activateNotification({ id: record.id, threadId: event.threadId }))
        toast.show()
      }
      pushNotifications()
    })
    ipcMain.handle('desktop:notifications', (event, command: NotificationCommand): NotificationCenterView => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object') throw new Error('NOTIFICATION_COMMAND_INVALID')
      const keys = Object.keys(command).length
      if (command.action === 'list' && keys === 1) return notifications.list()
      if (command.action === 'read' && keys === 2 && typeof command.id === 'string' && command.id.length <= 64) {
        notifications.markRead(command.id)
        return notifications.list()
      }
      if (command.action === 'read-all' && keys === 1) {
        notifications.markAllRead()
        return notifications.list()
      }
      if (command.action === 'clear' && keys === 1) {
        notifications.clear()
        return notifications.list()
      }
      throw new Error('NOTIFICATION_COMMAND_INVALID')
    })
    // Issue 109: the remote browser entry. The stream socket, the platform
    // access token and the paired origin stay inside the bundled Runtime;
    // this hub only forwards bounded events to the one fixed push channel
    // and routes the four fixed commands (open/close/input/retrieve). A
    // remote file is retrieved only through the artifact path with the
    // native save dialog — the bytes never enter the renderer.
    const remoteBrowserHub = new RemoteBrowserHub(runtime, {
      push: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:remote-browser:events', event)
      }
    }, async (name) => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('DOWNLOAD_WINDOW_UNAVAILABLE')
      const selected = await dialog.showSaveDialog(mainWindow, { title: '取回远端文件',
        defaultPath: name, buttonLabel: '取回到本机', properties: ['showOverwriteConfirmation'] })
      return selected.canceled ? undefined : selected.filePath
    })
    runtime.onRemoteBrowserEvent((message) => remoteBrowserHub.onRuntimeEvent(message))
    ipcMain.handle('desktop:remote-browser', (event, command) => {
      requireMainFrame(event)
      return remoteBrowserHub.handle(command)
    })
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
    // Issue 107: the browser pane's one invoke entry. The renderer names the
    // clear action only; the confirmation dialog and the storage clearing
    // stay in this trusted process.
    ipcMain.handle('desktop:browser', (event, command: BrowserCommand): Promise<void> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' || command.action !== 'clear' ||
          Object.keys(command).length !== 1) {
        throw new Error('BROWSER_COMMAND_INVALID')
      }
      return browserPane.clear()
    })

    // Issue 86: the shell preference family. The renderer reads and writes
    // the device-local window-lifecycle boolean only; the store lives in
    // this trusted process's userData and every reply re-reads it.
    ipcMain.handle('desktop:preferences', (event, command: PreferenceCommand): PreferencesView => {
      requireMainFrame(event)
      const parsed = parsePreferenceCommand(command)
      if (parsed.action === 'set') shellPreferences.save({ closeToTray: parsed.closeToTray })
      return { closeToTray: shellPreferences.load().closeToTray }
    })
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
    // Issue 94: the human file-browsing seam. The renderer names a
    // workspace-logical path and one action; browsing and previewing need no
    // approval (the Runtime resolves with the same guards as the Agent read
    // path, consent-free), and an external open/reveal resolves the physical
    // path here in the trusted process only — it never reaches the renderer,
    // and the OS launch stays a shell call on a Runtime-guarded location.
    ipcMain.handle('desktop:files', async (event, command: FilesCommand) => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object') throw new Error('FILES_COMMAND_INVALID')
      const keys = Object.keys(command).length
      if (typeof command.path !== 'string' || command.path.length === 0 || keys !== 2) throw new Error('FILES_COMMAND_INVALID')
      if (command.action === 'list' || command.action === 'read') return runtime.files(command.action, command.path)
      if (command.action === 'open' || command.action === 'reveal') {
        if (runtime.status().workspace?.state !== 'ready') throw new Error('WORKSPACE_UNAVAILABLE')
        const located = await runtime.files('locate', command.path)
        const physical = located as { physical: string }
        if (typeof physical.physical !== 'string' || !physical.physical) throw new Error('FILES_OPEN_FAILED')
        if (command.action === 'open') {
          const failure = await shell.openPath(physical.physical)
          if (failure) throw new Error('FILES_OPEN_FAILED')
          return
        }
        shell.showItemInFolder(physical.physical)
        return
      }
      throw new Error('FILES_COMMAND_INVALID')
    })
    // Issue 115: the CAD viewer's read entry. The renderer names a
    // workspace-logical model file; containment rides the Runtime's own
    // `locate` gate, and the conversion (OCCT WASM for STEP, local readers
    // for STL/OBJ) with its honest caps runs here in the trusted process —
    // the physical path and the file bytes never reach the renderer, and an
    // over-cap model is refused by code instead of silently degraded.
    const cadPane = new CadPaneService({
      locate: (path) => runtime.files('locate', path) as Promise<{ physical: string }>,
      // Packaged: <install>/resources/occt (extraResources, outside the asar).
      // Development: the checkout's own resources/occt — the converter is a
      // pinned repository resource, never an npm-resolved copy.
      loadOcct: () => loadOcctFromDirs([
        join(process.resourcesPath, 'occt'),
        join(app.getAppPath(), 'resources', 'occt')
      ])
    })
    ipcMain.handle('desktop:cad', async (event, command: CadCommand) => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object') throw new Error('CAD_COMMAND_INVALID')
      const keys = Object.keys(command).length
      if (command.action !== 'read-mesh' || typeof command.path !== 'string' ||
          command.path.length === 0 || keys !== 2) throw new Error('CAD_COMMAND_INVALID')
      return cadPane.readMesh(command.path)
    })
    // Issue 110: the human terminal seam (decision #59). Desktop-local PTY
    // sessions owned by the main frame only; the start dir resolves here from
    // the bound workspace (convenience, not a boundary) and falls back to the
    // user home. No approval, no receipt, no notification: a human using their
    // own terminal is free, and terminal output stays on this separate channel
    // — never the trusted desktop:* bridge, never the Runtime.
    const terminals = new TerminalSessions({
      onData: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:data', payload)
      },
      onExit: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:exit', payload)
      }
    }, async (projectId: string) => {
      // Issue 92: the selected project's bound folder is the preferred start
      // dir, resolved from the Runtime's own binding snapshot; the workspace
      // locate and the user home stay the fallback chain. The renderer names
      // a project id only — never a path.
      const status = runtime.status()
      return startDirForProject(projectId, status.projectBindings, async () => {
        if (status.login?.state !== 'authenticated' || status.workspace?.state !== 'ready') throw new Error('TERMINAL_START_DIR_UNAVAILABLE')
        const located = await runtime.files('locate', '/')
        const physical = (located as { physical: string }).physical
        if (typeof physical !== 'string' || !physical) throw new Error('TERMINAL_START_DIR_UNAVAILABLE')
        return physical
      })
    })
    terminalSessions = terminals
    ipcMain.handle('terminal:spawn', async (event, projectId?: unknown) => {
      requireMainFrame(event)
      // Issue 92: the optional argument is the selected project's id — an id
      // selector the manager sanitizes; a path can never ride this argument.
      return terminals.spawn(event.sender.id, typeof projectId === 'string' ? projectId : undefined)
    })
    ipcMain.handle('terminal:write', (event, sessionId: string, data: string) => {
      requireMainFrame(event)
      terminals.write(event.sender.id, sessionId, data)
    })
    ipcMain.handle('terminal:resize', (event, sessionId: string, cols: number, rows: number) => {
      requireMainFrame(event)
      terminals.resize(event.sender.id, sessionId, cols, rows)
    })
    ipcMain.handle('terminal:kill', (event, sessionId: string) => {
      requireMainFrame(event)
      terminals.kill(event.sender.id, sessionId)
    })
    // A crashed or reloaded renderer must not leak shells (linz behavior kept;
    // ownership is main-frame-wide because requireMainFrame admits that frame only).
    mainWindow.webContents.once('destroyed', () => terminalSessions?.killAll())
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
      // Issue 79: the conversation export. The renderer names the mode and
      // target only; the document is derived in this trusted process from the
      // Runtime's own state reply, the save dialog stays native and the
      // renderer never supplies write content.
      if (command?.action === 'export') {
        return exportChatTranscript(runtime, command, async (name) => {
          if (!mainWindow) throw new Error('CHAT_EXPORT_WINDOW_UNAVAILABLE')
          const selected = await dialog.showSaveDialog(mainWindow, { title: '导出会话为 Markdown',
            defaultPath: name, buttonLabel: '导出', properties: ['showOverwriteConfirmation'] })
          return selected.canceled ? undefined : selected.filePath
        })
      }
      // Issue 74: entering the full tier is an explicit decision made in the
      // trusted main process. The renderer never signs the confirm flag; the
      // runtime refuses a full-tier switch without it, so the dialog is not
      // decoration but the only path that can produce one.
      if (command?.action === 'tier' && command.tier === 'full') {
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'warning', title: '切入完全模式',
          message: '在当前会话切入完全模式？',
          detail: '完全模式下，Agent 在授权文件夹内的操作（含命令行执行）不再逐次询问；文件夹外与保护路径在所有档位始终拒绝。档位只在当前会话生效，重新打开或新建会话都会恢复默认的“变更前询问”。',
          buttons: ['取消，保持现状', '切入完全模式'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('SESSION_TIER_CANCELED')
        return runtime.chat({ ...command, confirm: true })
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
    // Issue 111: the Agent terminal pane reads this identity's own command
    // history and stops Runs through the same durable fence as chat; the
    // workspace scope travels from the main-side selection, never the
    // renderer.
    ipcMain.handle('desktop:terminal:history', (event, threadId?: string) => {
      requireMainFrame(event)
      if (threadId !== undefined && (typeof threadId !== 'string' || !threadId || threadId.length > 128)) {
        throw new Error('TERMINAL_THREAD_INVALID')
      }
      return runtime.terminalHistory(threadId)
    })
    ipcMain.handle('desktop:terminal:stop', (event, runId: string) => {
      requireMainFrame(event)
      if (typeof runId !== 'string' || !runId || runId.length > 256) throw new Error('TERMINAL_RUN_INVALID')
      return runtime.terminalStop(runId)
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
        detail: '设备侧将真实解析 PDF/DOCX/XLSX/CSV 与文本文件，并在本机记录解析结果（解析器与版本、页/表定位）；平台仅登记文件名、大小、类型与 SHA-256 指纹清单，原文件与解析结果不会自动上传。本机不解析的格式（如 .doc/.xls/.ppt）会如实标记，可在导入后通过「发布此版本到服务端」显式上传原件交平台解析。每次导入生成一个新的不可变版本，不覆盖已登记版本。',
        buttons: ['取消', '确认导入'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      return runtime.importKnowledge(kbId, chosen.filePaths)
    })
    // Issue 96: the doc library's recursive folder import. The renderer only
    // names the platform KB identity; the directory picking and the content
    // boundary confirmation stay in the trusted main process, and the Runtime
    // runs the walk/dedup/registration job in background with cancel.
    ipcMain.handle('desktop:knowledge:folder', async (event, kbId: string): Promise<unknown> => {
      requireMainFrame(event)
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_IMPORT_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE')
      if (typeof kbId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(kbId)) throw new Error('KNOWLEDGE_IMPORT_KB_INVALID')
      const chosen = await dialog.showOpenDialog(mainWindow!, {
        title: '选择要导入的文件夹', properties: ['openDirectory'] })
      if (chosen.canceled || !chosen.filePaths.length) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '确认整文件夹导入',
        message: '递归导入所选文件夹及其子文件夹到平台知识库？',
        detail: '设备侧将递归读取文件夹内支持的文档（PDF/DOCX/XLSX/CSV 与文本），按内容指纹自动去重：与已导入内容相同的文件会被跳过并在进度中提示。导入在后台进行，可随时取消；每批最多 200 个文件，每个批次生成一个新的不可变版本。平台仅登记文件名、大小、类型与 SHA-256 指纹清单，原文件不会上传。文件夹必须位于已确认的工作目录内。',
        buttons: ['取消', '开始后台导入'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      return runtime.importKnowledgeFolder(kbId, chosen.filePaths[0])
    })
    // Issue 96: the folder import cancel command; a cancel without a running
    // job is an honest no-op.
    ipcMain.handle('desktop:knowledge:folder-cancel', (event) => {
      requireMainFrame(event)
      return runtime.cancelKnowledgeFolder()
    })
    // Issue 97: one registered revision's background index rebuild. The
    // renderer names the frozen identity only; the Runtime re-verifies every
    // document against the live workspace bytes on its own job thread, and
    // the reply is the running job's bounded view.
    ipcMain.handle('desktop:knowledge:index-rebuild', (event, kbId: string, revisionId: string, manifestHash: string) => {
      requireMainFrame(event)
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_INDEX_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('KNOWLEDGE_INDEX_WORKSPACE_UNAVAILABLE')
      if (typeof kbId !== 'string' || !kbId || kbId.length > 64) throw new Error('KNOWLEDGE_INDEX_KB_INVALID')
      if (typeof revisionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revisionId)) throw new Error('KNOWLEDGE_INDEX_REVISION_INVALID')
      if (typeof manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error('KNOWLEDGE_INDEX_MANIFEST_INVALID')
      return runtime.rebuildKnowledgeIndex(kbId, revisionId, manifestHash)
    })
    // Issue 97: the index rebuild cancel command; a cancel without a running
    // job is an honest no-op.
    ipcMain.handle('desktop:knowledge:index-rebuild-cancel', (event) => {
      requireMainFrame(event)
      return runtime.cancelKnowledgeIndexRebuild()
    })
    // Issue 96: batch delete of import records. The confirmation stays in the
    // trusted main process; a delete only removes device-local display rows.
    ipcMain.handle('desktop:knowledge:delete', async (event, ids: string[]): Promise<{ deleted: number }> => {
      requireMainFrame(event)
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
          ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) throw new Error('KNOWLEDGE_IMPORT_IDS_INVALID')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '删除导入记录',
        message: `删除所选 ${ids.length} 条导入记录？`,
        detail: '仅删除本机的导入记录（显示事实），不影响平台知识库与已登记的版本。',
        buttons: ['取消', '删除所选记录'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      return runtime.deleteKnowledgeImports(ids)
    })
    // Issue 96: retry one failed import record from its stored workspace
    // source; the confirmation stays in the trusted main process.
    ipcMain.handle('desktop:knowledge:retry', async (event, recordId: string): Promise<KnowledgeImportOutcome> => {
      requireMainFrame(event)
      if (typeof recordId !== 'string' || !/^[0-9a-f]{64}$/.test(recordId)) throw new Error('KNOWLEDGE_IMPORT_ID_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_IMPORT_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '重新导入失败的记录',
        message: '重新导入该失败记录的原始文件？',
        detail: '设备侧会按记录中保存的工作目录来源重新读取这些文件，并重新执行全部目录校验与解析；重试生成新的导入记录，原失败记录保留。',
        buttons: ['取消', '重新导入'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      return runtime.retryKnowledgeImport(recordId)
    })
    // Issue 101: 删除=库新版本. The renderer names the frozen revision and the
    // documents to drop (by their own frozen content hashes); the platform
    // issues the successor revision, so the historical record and every old
    // reference stay traceable. No original file is read or touched, and the
    // confirmation stays in this trusted process.
    ipcMain.handle('desktop:knowledge:delete-documents', async (
      event, kbId: string, revisionId: string, contentHashes: string[]): Promise<KnowledgeDeleteOutcome> => {
      requireMainFrame(event)
      if (typeof kbId !== 'string' || !kbId || kbId.length > 64) throw new Error('KNOWLEDGE_INDEX_KB_INVALID')
      if (typeof revisionId !== 'string' || !revisionId || revisionId.length > 64) throw new Error('KNOWLEDGE_INDEX_REVISION_INVALID')
      if (!Array.isArray(contentHashes) || contentHashes.length < 1 || contentHashes.length > 200 ||
          contentHashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) throw new Error('KNOWLEDGE_DELETE_DOCUMENTS_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_IMPORT_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '删除文档并登记库新版本',
        message: `从该版本删除所选 ${contentHashes.length} 个文档并登记库新版本？`,
        detail: '设备将把剩余文档在平台登记为新版本（删除=库新版本）：旧版本与所有历史引用（图谱、Wiki、检索引用）保留可追溯，仍指向其当时版本。本机文件不会被删除或修改；删除文档不清理其设备侧索引，可用「清理本机索引」另行物理清理。',
        buttons: ['取消', '删除并登记新版本'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      return runtime.deleteKnowledgeDocuments(kbId, revisionId, contentHashes)
    })
    // Issue 101: the user's separate physical cleanup. Purging removes this
    // revision's device BM25 index rows and offline snapshot cache and marks
    // its references 原件已不在; the original files are never touched here.
    ipcMain.handle('desktop:knowledge:cleanup', async (
      event, kbId: string, revisionId: string, manifestHash: string): Promise<KnowledgeCleanupOutcome> => {
      requireMainFrame(event)
      if (typeof kbId !== 'string' || !kbId || kbId.length > 64) throw new Error('KNOWLEDGE_INDEX_KB_INVALID')
      if (typeof revisionId !== 'string' || !revisionId || revisionId.length > 64) throw new Error('KNOWLEDGE_INDEX_REVISION_INVALID')
      if (typeof manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error('KNOWLEDGE_INDEX_MANIFEST_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_IMPORT_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '清理该版本的本机索引与快照',
        message: '物理清除该版本的设备侧检索索引与离线快照缓存？',
        detail: '将删除该版本在本机的全文索引与离线快照缓存（物理清理），并把旧引用标记为「原件已不在」；记录本身保留可追溯。清理是删除之外的独立操作，且不会删除工作目录中的任何原文件。',
        buttons: ['取消', '确认清理'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('KNOWLEDGE_IMPORT_CANCELED')
      return runtime.cleanupKnowledgeRevision(kbId, revisionId, manifestHash)
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
    // Issue 98: the user's own library search. The renderer names the
    // authorized KB/Revision and the query only; the search runs entirely
    // device-side over the same engines as the broker task, and its answer
    // carries the library identity, the page/table citations, and the
    // honest evidenceComplete fact — read-only compute, no dialogs.
    ipcMain.handle('desktop:knowledge:search', (event, kbId: string, revisionId: string, query: string) => {
      requireMainFrame(event)
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('KNOWLEDGE_SEARCH_UNAUTHENTICATED')
      return runtime.knowledgeSearch(kbId, revisionId, query)
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
        // Issue 82: the declared languages, permissions, and dependencies are
        // part of the decision the user confirms — import success never
        // implies executability, and undeclared capabilities are never
        // silently granted.
        const declaration = formatDeclarationSummary(preview.files, preview.environment, preview.permissions)
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认上传技能包',
          message: `将「${preview.name}」上传为你的私有平台技能草稿？`,
          detail: `正文摘录：${excerpt || '（空）'}\n\n上传范围：${scope}\n\n${declaration}\n\n包指纹 ${preview.packageHash.slice(0, 16)}… 与上传内容绑定，平台校验一致后才会创建草稿。上传后的技能归属当前账号，初始为私有（private）；发布版本需另行确认，沿用平台既有的草稿校验与发布流程。取消则不会上传任何内容。导入成功不等于脚本可执行：每次执行仍需脚本授权。`,
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
    // Issue 121: the trigger-preference entry. The renderer only names the
    // account's Skill and the preference fields; the Server stores the rows,
    // performs every match at Run preparation, and re-validates visibility,
    // publication and the dependency closure. Nothing here runs a model or
    // matches locally — the Desktop has no matching code by design.
    ipcMain.handle('desktop:skill-preferences', async (event, command: SkillPreferenceCommand): Promise<SkillPreferencesView> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' || !['list', 'set', 'clear'].includes(command.action)) throw new Error('SKILL_PREFERENCE_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('SKILL_PREFERENCE_UNAUTHENTICATED')
      return runtime.skillPreferences(command)
    })
    // Issue 73: the model settings surface. The renderer only names the
    // action and the model name; the authorized list, the account default
    // (the same preference the Web writes) and the device-local fallback
    // pick all live behind the Server's own endpoints. No provider, Base URL
    // or key field exists in this family — the Desktop never holds a model
    // credential.
    ipcMain.handle('desktop:models', async (event, command: ModelCommand): Promise<ModelSettingsView> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' ||
          !['list', 'set-default', 'set-fallback'].includes(command.action)) throw new Error('MODEL_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('MODEL_UNAUTHENTICATED')
      return runtime.models(command)
    })
    // Issue 122: the device's own Skill script grant list. Listing and
    // revoking happen only on the owned Runtime's binding-scoped registry;
    // nothing here can create a grant — approvals live in the consent flow.
    ipcMain.handle('desktop:skill-scripts', async (event, command: SkillScriptCommand): Promise<SkillScriptView> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' || !['list', 'revoke'].includes(command.action)) throw new Error('SKILL_SCRIPT_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('SKILL_SCRIPT_UNAUTHENTICATED')
      return runtime.skillScripts(command)
    })
    // Issue 72: the session sidebar's Thread management. Rename and delete
    // write the Server's own Thread API after the identity fence; a delete is
    // confirmed here in the trusted main process, and the local receipt ledger
    // is never touched — unconfirmed receipts stay queryable on this device.
    ipcMain.handle('desktop:threads', async (event, command: ThreadCommand): Promise<ThreadView> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' || !['list', 'search', 'rename', 'delete'].includes(command.action)) throw new Error('THREADS_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('THREADS_UNAUTHENTICATED')
      if (command.action === 'delete') {
        if (typeof command.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.threadId)) throw new Error('THREADS_COMMAND_INVALID')
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认删除平台会话',
          message: `删除平台会话 ${command.threadId}？`,
          detail: '删除会同时移除该会话在平台上的对话历史，操作不可恢复。本机保存的未确认回执不会清除，仍可在回执历史中查看。'
            + '如该会话正在对话中，请先等当前 Run 结束再删除。',
          buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('THREADS_CANCELED')
      }
      return runtime.threads(command)
    })
    // Issue 91: platform project management. Every action rides the Server's
    // own Project API through the Runtime's chat-session fence; a delete is
    // confirmed here in the trusted main process first. Nothing on this path
    // touches local files or directory grants — deleting or archiving a
    // project is platform-side organization only, and the Server clears
    // Thread membership itself.
    // Issue 92: the device-local folder binding actions join the family. The
    // renderer names the project only; the folder is chosen in the native
    // dialog here and confirmed with the boundary explanation before the
    // Runtime records it — a path supplied by the renderer never reaches the
    // wire, and a canceled dialog is a user decision, not a failure.
    ipcMain.handle('desktop:projects', async (event, command: ProjectCommand): Promise<ProjectOperationView> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' ||
          !['list', 'create', 'rename', 'archive', 'restore', 'delete', 'bind-folder', 'unbind-folder'].includes(command.action)) throw new Error('PROJECTS_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('PROJECTS_UNAUTHENTICATED')
      if (command.action === 'delete') {
        if (typeof command.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.projectId)) throw new Error('PROJECTS_COMMAND_INVALID')
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认删除平台项目',
          message: '删除该平台项目？',
          detail: '项目将被删除且不可恢复；项目内的会话不会被删除，会回到散会话。本机文件与目录授权不受影响。',
          buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('PROJECTS_CANCELED')
      }
      if (command.action === 'bind-folder' || command.action === 'unbind-folder') {
        if (typeof command.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.projectId)) throw new Error('PROJECTS_COMMAND_INVALID')
      }
      if (command.action === 'bind-folder') {
        const chosen = await dialog.showOpenDialog(mainWindow!, { title: '选择项目文件夹', properties: ['openDirectory'] })
        if (chosen.canceled || chosen.filePaths.length !== 1) throw new Error('PROJECTS_CANCELED')
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认绑定项目文件夹',
          message: '将该文件夹绑定为这个项目在本机的工作文件夹？',
          detail: `${chosen.filePaths[0]}\n\n绑定按“项目+设备”记录，仅保存在本机：换设备登录时该项目显示未绑定（原设备绑定不迁移）。受控终端将以该文件夹为起始目录；也可在未选择工作目录时将其设为文件工具的工作目录。删除项目或解绑都不会删除本机文件。`,
          buttons: ['取消', '确认绑定'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('PROJECTS_CANCELED')
        const bound = await runtime.projects({ action: 'bind-folder', projectId: command.projectId, path: chosen.filePaths[0] })
        // Issue 92: the file tools' boundary input is the confirmed device
        // workspace. When none is selected yet, the bound folder may become
        // it through the same explicit confirmation the workspace chooser
        // uses; an existing workspace is never touched, and a failed offer
        // never undoes the binding.
        if (runtime.status().workspace?.state !== 'ready') {
          const offer = await dialog.showMessageBox(mainWindow!, {
            type: 'question', title: '设为工作目录',
            message: '本机还没有工作目录。将绑定的文件夹同时设为工作目录？',
            detail: '文件工具（列举/读取/写入）以确认的工作目录为边界。可以稍后在文件面板中另行选择或更换。',
            buttons: ['暂不', '设为工作目录'], defaultId: 0, cancelId: 0, noLink: true
          })
          // Re-read after the modal: a workspace may have become ready while
          // it was open (another chooser round, a reconnect) — an accepted
          // offer must never overwrite it. Failures stay swallowed: the bind
          // is already committed and the chooser remains authoritative.
          if (offer.response === 1 && runtime.status().workspace?.state !== 'ready') {
            try { await runtime.selectWorkspace(chosen.filePaths[0], runtime.workspaceScope()) } catch { /* optional offer; the chooser stays authoritative */ }
          }
        }
        return bound
      }
      return runtime.projects(command)
    })
    // Issue 102: 表格数据集导入. The renderer names the action and the
    // project association only; the file is located by the native dialog
    // here and the import/delete are confirmed in this trusted process.
    // The device parses XLSX/CSV into a real registry row (multi-sheet,
    // inferred column types, content fingerprints) and dedups identical
    // content into an explicit duplicate outcome; the original file stays
    // on this machine and a delete removes the registry row only.
    ipcMain.handle('desktop:datasets', async (event, command: DatasetCommand): Promise<DatasetOperationView> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' || !['import', 'delete'].includes(command.action)) throw new Error('DATASETS_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('DATASETS_UNAUTHENTICATED')
      if (command.action === 'import') {
        if (typeof command.projectId !== 'string' || command.projectId.length > 128 ||
            (command.projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(command.projectId))) throw new Error('DATASETS_COMMAND_INVALID')
        // Issue 101: the optional knowledge revision binding passes through
        // exactly as the renderer named it; kb and revision stand or fall
        // together and the Runtime re-validates every field.
        const binding = command.revision
        if (binding !== undefined && (typeof binding !== 'object' || binding === null ||
            typeof binding.kbId !== 'string' || !binding.kbId || binding.kbId.length > 128 ||
            typeof binding.revisionId !== 'string' || !binding.revisionId || binding.revisionId.length > 128 ||
            !Number.isSafeInteger(binding.revisionNo) || binding.revisionNo < 0 || binding.revisionNo > 1000000)) {
          throw new Error('DATASETS_COMMAND_INVALID')
        }
        const chosen = await dialog.showOpenDialog(mainWindow!, {
          title: '选择要导入的表格数据文件',
          filters: [{ name: '表格数据 (XLSX/CSV)', extensions: ['xlsx', 'csv'] }], properties: ['openFile'] })
        if (chosen.canceled || chosen.filePaths.length !== 1) throw new Error('DATASETS_CANCELED')
        const association = command.projectId ? `平台项目 ${command.projectId}` : '未关联平台项目'
        const bindingNote = binding ? `\n\n知识版本绑定：R${binding.revisionNo}（${binding.revisionId.slice(0, 8)}…）` : ''
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认表格数据集导入',
          message: '解析所选表格文件并在本机登记为数据集？',
          detail: `设备侧将真实解析 XLSX 的全部工作表与 CSV，逐列识别类型（数字/布尔/日期时间/文本），并按文件内容指纹去重：重复导入相同内容只会得到一条“内容重复”提示，不会产生第二条记录。\n\n数据集登记关联：${association}。原文件留在本机不会上传，登记内容仅含文件名、位置、内容指纹、表结构与行数等元数据。${bindingNote}\n\n来源：${chosen.filePaths[0]}`,
          buttons: ['取消', '确认导入'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('DATASETS_CANCELED')
        return binding
          ? runtime.datasets({ action: 'import', path: chosen.filePaths[0], projectId: command.projectId,
              kbId: binding.kbId, revisionId: binding.revisionId, revisionNo: binding.revisionNo })
          : runtime.datasets({ action: 'import', path: chosen.filePaths[0], projectId: command.projectId })
      }
      if (typeof command.datasetId !== 'string' || !/^[0-9a-f]{64}$/.test(command.datasetId)) throw new Error('DATASETS_COMMAND_INVALID')
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '确认删除数据集登记',
        message: '删除这条数据集登记记录？',
        detail: '仅删除本机的登记记录（表结构、指纹等元数据）；原文件不会被删除或修改，平台侧也没有任何数据集记录需要移除。',
        buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('DATASETS_CANCELED')
      return runtime.datasets({ action: 'delete', datasetId: command.datasetId })
    })
    // Issue 85: the platform scheduled-tasks management surface. The renderer
    // names the action and the task fields only; the platform owns timing,
    // cron previews and execution records through the Runtime's pinned
    // contract client. A delete is confirmed here in the trusted main
    // process; 补跑/跳过 facts are device-local display truth keyed by the
    // planned point.
    ipcMain.handle('desktop:schedules', async (event, command: ScheduleCommand): Promise<SchedulesOutcome> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' ||
          !['list', 'get', 'create', 'update', 'pause', 'resume', 'trigger', 'delete', 'runs', 'set-skip', 'preview'].includes(command.action)) throw new Error('SCHEDULES_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('SCHEDULES_UNAUTHENTICATED')
      if (command.action === 'delete') {
        if (typeof command.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.taskId)) throw new Error('SCHEDULES_COMMAND_INVALID')
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认删除定时任务',
          message: `删除定时任务「${command.taskId}」？`,
          detail: '删除会同时移除平台上的任务计划与排队中的执行，操作不可恢复。已有的执行记录仍可在平台查询。',
          buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('SCHEDULES_CANCELED')
      }
      return runtime.schedules(command)
    })
    // Issue 84: the prompt-template plaza. The renderer names the CRUD/use
    // actions only; the rows, their visibility and their usage counts live on
    // the Server's own endpoints. A template click never rides this channel
    // as a send — `use` only records the prefill (+1 usage) after the
    // renderer has placed the text in the composer as a draft. A delete is
    // confirmed here in the trusted main process and never silently drops a
    // shared row: the Server's own ownership check stays authoritative.
    // Issue 106: `official-list` joins as the welcome page's one read —
    // same family, same authentication gate, no mutation of any kind.
    ipcMain.handle('desktop:templates', async (event, command: TemplateCommand | OfficialTemplateCommand): Promise<TemplateView | OfficialTemplatesView> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' ||
          !['list', 'official-list', 'create', 'update', 'delete', 'use'].includes(command.action)) throw new Error('TEMPLATE_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('TEMPLATE_UNAUTHENTICATED')
      if (command.action === 'delete') {
        if (typeof command.templateId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.templateId)) throw new Error('TEMPLATE_COMMAND_INVALID')
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认删除提示词模板',
          message: '删除这条提示词模板？',
          detail: '删除后模板与它的使用计数一并消失，操作不可恢复；他人共享给你的模板不受本次操作影响。',
          buttons: ['取消', '确认删除'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('TEMPLATE_CANCELED')
      }
      if (command.action === 'official-list') return runtime.officialTemplates(command)
      return runtime.templates(command)
    })
    // Issue 123: the optional local connector install. The renderer only
    // names the action; the candidate directory is located and both the
    // install and the removal are confirmed in the trusted main process.
    // The preview is read-only and writes nothing; a confirmed install
    // registers the platform-canonical identity first (identity fields
    // only), then commits the managed copy on this device. The runnable
    // binding — command, entry, environment, data directory — never leaves
    // the device, and nothing is published, shared or synced.
    ipcMain.handle('desktop:connectors', async (event, command: ConnectorCommand): Promise<ConnectorOutcome> => {
      requireMainFrame(event)
      if (!command || typeof command !== 'object' ||
          !['install', 'remove', 'list'].includes(command.action)) throw new Error('CONNECTOR_COMMAND_INVALID')
      const status = runtime.status()
      if (status.login?.state !== 'authenticated') throw new Error('CONNECTOR_UNAUTHENTICATED')
      if (status.workspace?.state !== 'ready') throw new Error('CONNECTOR_WORKSPACE_UNAVAILABLE')
      if (command.action === 'list') return runtime.connectors({ action: 'list' })
      if (command.action === 'remove') {
        if (typeof command.slug !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(command.slug)) throw new Error('CONNECTOR_COMMAND_INVALID')
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'question', title: '确认移除本地连接器',
          message: `移除本设备上的连接器「${command.slug}」？`,
          detail: '移除会停止该组件、删除受管副本与受控配置，并同步移除平台上的身份登记。组件数据目录内的既有文件保持在本机，不会上传或同步。该连接器从未发布或共享给其他账号、其他设备。',
          buttons: ['取消', '确认移除'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (confirmation.response !== 1) throw new Error('CONNECTOR_CANCELED')
        return runtime.connectors({ action: 'remove', slug: command.slug })
      }
      // Install: locate the candidate package directory here; the path
      // never reaches the renderer.
      const chosen = await dialog.showOpenDialog(mainWindow!, {
        title: '选择连接器组件目录', properties: ['openDirectory'] })
      if (chosen.canceled || chosen.filePaths.length !== 1) throw new Error('CONNECTOR_CANCELED')
      // Step 1: the read-only device-side validation. Nothing registers on
      // the platform and nothing is written on the device yet.
      const preview: ConnectorInternalOutcome = await runtime.connectors({ action: 'preview', path: chosen.filePaths[0] })
      if (preview.action !== 'preview') throw new Error('CONNECTOR_FAILED')
      const summary = `版本 ${preview.version} · ${preview.fileCount} 个文件 · 入口 ${preview.entry}\n清单指纹 ${preview.manifestHash.slice(0, 16)}… · 包指纹 ${preview.packageHash.slice(0, 16)}…`
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '确认安装本地连接器',
        message: `安装「${preview.displayName}」（${preview.slug}）到本设备？`,
        detail: `${summary}\n\n安装会在本设备完成版本与依赖校验，并向平台登记仅属你的连接器身份（名称/版本/指纹）；随后生成受控配置：入口固定为受管副本，文件访问限定在该组件自己的数据目录。命令行、入口路径与环境配置不会离开本设备，也不会同步为其他设备可运行的配置。`,
        buttons: ['取消', '确认安装'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) throw new Error('CONNECTOR_CANCELED')
      // Step 2: the confirmed install re-validates the exact bytes and
      // registers the canonical identity before the local commit.
      const outcome = await runtime.connectors({ action: 'install', path: chosen.filePaths[0] })
      if (outcome.action !== 'install') throw new Error('CONNECTOR_FAILED')
      return outcome
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
      // Let invoke resolve before the exit flow touches its renderer.
      // Issue 86: the renderer's 退出应用 is a true exit and rides the same
      // drain coordinator as the tray and menu exits.
      setImmediate(() => requestExit())
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

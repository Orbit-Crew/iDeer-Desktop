import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserCommand, BrowserPaneEvent, CadCommand, ChatCommand, ConnectorCommand, DatasetCommand, DesktopBridge, FilesCommand, KnowledgeGraphCommand, ModelCommand, NotificationCenterView, NotificationCommand, OfficialTemplateCommand, OfficialTemplatesView, ProjectCommand, RemoteBrowserCommand, RemoteBrowserEvent, ScheduleCommand, SkillCommand, SkillPreferenceCommand, SkillScriptCommand, TemplateCommand, TemplateView, TerminalBridge, TerminalDataEvent, TerminalExitEvent, ThreadCommand, WikiCommand } from '../shared/desktop'

// Issue 106: the official selection rides the templates family's one pinned
// channel, so the channel inventory stays one entry per channel.
const invokeTemplates = (command: TemplateCommand | OfficialTemplateCommand): Promise<unknown> =>
  ipcRenderer.invoke('desktop:templates', command)
const invokeTemplatesAs = <T,>(command: TemplateCommand | OfficialTemplateCommand): Promise<T> =>
  invokeTemplates(command) as Promise<T>

const bridge: DesktopBridge = Object.freeze({
  manage: (action: 'logout' | 'switch-account' | 'revoke', grantId = '') => ipcRenderer.invoke('desktop:manage', action, grantId),
  chooseWorkspace: () => ipcRenderer.invoke('desktop:workspace:choose'),
  getStatus: () => ipcRenderer.invoke('desktop:status'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  startRuntime: () => ipcRenderer.invoke('desktop:runtime:start'),
  stopRuntime: () => ipcRenderer.invoke('desktop:runtime:stop'),
  beginLogin: (server: string, deviceName: string) => ipcRenderer.invoke('desktop:login:begin', server, deviceName),
  chat: (command: ChatCommand) => ipcRenderer.invoke('desktop:chat', command),
  receipts: (action: 'history' | 'clear-confirmed', offset = 0) => ipcRenderer.invoke('desktop:receipts', action, offset),
  importKnowledge: (kbId: string) => ipcRenderer.invoke('desktop:knowledge:import', kbId),
  publishKnowledge: (kbId: string, revisionId: string) => ipcRenderer.invoke('desktop:knowledge:publish', kbId, revisionId),
  knowledgeGraph: (command: KnowledgeGraphCommand) => ipcRenderer.invoke('desktop:knowledge:graph', command),
  knowledgeWiki: (command: WikiCommand) => ipcRenderer.invoke('desktop:knowledge:wiki', command),
  skills: (command: SkillCommand) => ipcRenderer.invoke('desktop:skills', command),
  skillPreferences: (command: SkillPreferenceCommand) => ipcRenderer.invoke('desktop:skill-preferences', command),
  skillScripts: (command: SkillScriptCommand) => ipcRenderer.invoke('desktop:skill-scripts', command),
  models: (command: ModelCommand) => ipcRenderer.invoke('desktop:models', command),
  threads: (command: ThreadCommand) => ipcRenderer.invoke('desktop:threads', command),
  // Issue 91: platform project management; every action rides the Server's
  // own Project API and the reply is its post-action list.
  projects: (command: ProjectCommand) => ipcRenderer.invoke('desktop:projects', command),
  // Issue 102: 表格数据集导入. The renderer names the action and the project
  // association only; the file is located by the trusted main process's
  // native dialog, both actions are confirmed there, and the original file
  // never leaves the machine.
  datasets: (command: DatasetCommand) => ipcRenderer.invoke('desktop:datasets', command),
  // Issue 85: the platform scheduled-tasks management surface; deletes are
  // confirmed in the trusted main process before they reach the wire.
  schedules: (command: ScheduleCommand) => ipcRenderer.invoke('desktop:schedules', command),
  // Issue 84: the prompt-template plaza. The renderer names CRUD/use actions
  // only; the Server's own endpoints hold the rows, and a delete is
  // confirmed in the trusted main process before it reaches the wire.
  templates: (command: TemplateCommand) => invokeTemplatesAs<TemplateView>(command),
  // Issue 106: the welcome page's read-only official selection; it rides the
  // same channel family with its own typed door and never mutates anything.
  officialTemplates: (command: OfficialTemplateCommand) => invokeTemplatesAs<OfficialTemplatesView>(command),
  connectors: (command: ConnectorCommand) => ipcRenderer.invoke('desktop:connectors', command),
  checkUpdates: (mode?: 'staged') => ipcRenderer.invoke('desktop:updates:check', ...(mode === undefined ? [] : [mode])),
  importUpdate: () => ipcRenderer.invoke('desktop:updates:import'),
  installUpdate: () => ipcRenderer.invoke('desktop:updates:install'),
  recoveryState: () => ipcRenderer.invoke('desktop:updates:recovery'),
  refreshCompatibility: () => ipcRenderer.invoke('desktop:compatibility:refresh'),
  // Issue 77: the notification center rides one invoke entry plus the two
  // push channels; every push replaces the renderer's whole view.
  notifications: (command: NotificationCommand) => ipcRenderer.invoke('desktop:notifications', command),
  // Issue 94: the human file-browsing seam — logical workspace paths only;
  // open/reveal resolve to physical paths inside the trusted main process.
  files: (command: FilesCommand) => ipcRenderer.invoke('desktop:files', command),
  // Issue 115: the CAD viewer's one invoke entry — the renderer names a
  // workspace-logical model file; containment rides the Runtime's own locate
  // gate and the conversion (plus its honest caps) happens in the trusted
  // main process, which returns one bounded mesh payload and never a
  // physical path or raw file bytes.
  cad: (command: CadCommand) => ipcRenderer.invoke('desktop:cad', command),
  // Issue 109: the remote browser entry — stream lifecycle, input forwarding
  // and the explicit remote-file retrieval; the screen itself arrives on the
  // one push channel below as pixels and can never send anything back.
  remoteBrowser: (command: RemoteBrowserCommand) => ipcRenderer.invoke('desktop:remote-browser', command),
  // Issue 107: the browser pane's clear entry; the confirmation stays in the
  // trusted main process.
  browser: (command: BrowserCommand) => ipcRenderer.invoke('desktop:browser', command),
  onNotifications: (listener: (view: NotificationCenterView) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, view: NotificationCenterView): void => listener(view)
    ipcRenderer.on('desktop:notifications', wrapped)
    return () => { ipcRenderer.removeListener('desktop:notifications', wrapped) }
  },
  onNotificationActivate: (listener: (payload: { id: string; threadId: string }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { id: string; threadId: string }): void => listener(payload)
    ipcRenderer.on('desktop:notification:activate', wrapped)
    return () => { ipcRenderer.removeListener('desktop:notification:activate', wrapped) }
  },
  // Issue 109: the remote browser's one push channel — bounded main-owned
  // display facts (frames, url/tabs, honest errors); no renderer reply exists.
  onRemoteBrowserEvents: (listener: (event: RemoteBrowserEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, event: RemoteBrowserEvent): void => listener(event)
    ipcRenderer.on('desktop:remote-browser:events', wrapped)
    return () => { ipcRenderer.removeListener('desktop:remote-browser:events', wrapped) }
  },
  // Issue 107: the one push channel for the browser pane's bounded facts.
  onBrowserEvents: (listener: (event: BrowserPaneEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: BrowserPaneEvent): void => listener(payload)
    ipcRenderer.on('desktop:browser:events', wrapped)
    return () => { ipcRenderer.removeListener('desktop:browser:events', wrapped) }
  }
})

// Issue 110: the human terminal's separate minimal bridge (decision #59.6).
// Terminal output is content, not trusted UI: it never rides the trusted
// desktop:* bridge above, and this seam exposes exactly spawn/write/resize/
// kill plus the two fixed main-owned push channels — no filesystem, no shell
// wrapper, nothing else.
const terminalBridge: TerminalBridge = Object.freeze({
  spawn: () => ipcRenderer.invoke('terminal:spawn'),
  write: (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', sessionId, data),
  resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
  kill: (sessionId: string) => ipcRenderer.invoke('terminal:kill', sessionId),
  onData: (listener: (event: TerminalDataEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => listener(payload)
    ipcRenderer.on('terminal:data', wrapped)
    return () => { ipcRenderer.removeListener('terminal:data', wrapped) }
  },
  onExit: (listener: (event: TerminalExitEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent): void => listener(payload)
    ipcRenderer.on('terminal:exit', wrapped)
    return () => { ipcRenderer.removeListener('terminal:exit', wrapped) }
  }
})

contextBridge.exposeInMainWorld('ideer', bridge)
contextBridge.exposeInMainWorld('ideerTerminal', terminalBridge)

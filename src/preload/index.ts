import { contextBridge, ipcRenderer } from 'electron'
import type { ChatCommand, ConnectorCommand, DesktopBridge, FilesCommand, KnowledgeGraphCommand, ModelCommand, NotificationCommand, NotificationCenterView, SkillCommand, SkillPreferenceCommand, SkillScriptCommand, TemplateCommand, ThreadCommand, WikiCommand } from '../shared/desktop'

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
  // Issue 84: the prompt-template plaza. The renderer names CRUD/use actions
  // only; the Server's own endpoints hold the rows, and a delete is
  // confirmed in the trusted main process before it reaches the wire.
  templates: (command: TemplateCommand) => ipcRenderer.invoke('desktop:templates', command),
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
  onNotifications: (listener: (view: NotificationCenterView) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, view: NotificationCenterView): void => listener(view)
    ipcRenderer.on('desktop:notifications', wrapped)
    return () => { ipcRenderer.removeListener('desktop:notifications', wrapped) }
  },
  onNotificationActivate: (listener: (payload: { id: string; threadId: string }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { id: string; threadId: string }): void => listener(payload)
    ipcRenderer.on('desktop:notification:activate', wrapped)
    return () => { ipcRenderer.removeListener('desktop:notification:activate', wrapped) }
  }
})

contextBridge.exposeInMainWorld('ideer', bridge)

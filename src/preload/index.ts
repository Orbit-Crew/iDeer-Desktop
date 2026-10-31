import { contextBridge, ipcRenderer } from 'electron'
import type { ChatCommand, ConnectorCommand, DesktopBridge, KnowledgeGraphCommand, ModelCommand, SkillCommand, SkillPreferenceCommand, SkillScriptCommand, WikiCommand } from '../shared/desktop'

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
  connectors: (command: ConnectorCommand) => ipcRenderer.invoke('desktop:connectors', command),
  checkUpdates: (mode?: 'staged') => ipcRenderer.invoke('desktop:updates:check', ...(mode === undefined ? [] : [mode])),
  importUpdate: () => ipcRenderer.invoke('desktop:updates:import'),
  installUpdate: () => ipcRenderer.invoke('desktop:updates:install'),
  recoveryState: () => ipcRenderer.invoke('desktop:updates:recovery'),
  refreshCompatibility: () => ipcRenderer.invoke('desktop:compatibility:refresh')
})

contextBridge.exposeInMainWorld('ideer', bridge)

import { contextBridge, ipcRenderer } from 'electron'
import type { ChatCommand, DesktopBridge } from '../shared/desktop'

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
  checkUpdates: (mode?: 'staged') => ipcRenderer.invoke('desktop:updates:check', ...(mode === undefined ? [] : [mode])),
  importUpdate: () => ipcRenderer.invoke('desktop:updates:import'),
  installUpdate: () => ipcRenderer.invoke('desktop:updates:install'),
  recoveryState: () => ipcRenderer.invoke('desktop:updates:recovery'),
  refreshCompatibility: () => ipcRenderer.invoke('desktop:compatibility:refresh')
})

contextBridge.exposeInMainWorld('ideer', bridge)

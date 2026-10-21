import { contextBridge, ipcRenderer } from 'electron'
import type { ChatCommand, DesktopBridge } from '../shared/desktop'

const bridge: DesktopBridge = Object.freeze({
  chooseWorkspace: () => ipcRenderer.invoke('desktop:workspace:choose'),
  getStatus: () => ipcRenderer.invoke('desktop:status'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  startRuntime: () => ipcRenderer.invoke('desktop:runtime:start'),
  stopRuntime: () => ipcRenderer.invoke('desktop:runtime:stop'),
  beginLogin: (server: string, deviceName: string) => ipcRenderer.invoke('desktop:login:begin', server, deviceName),
  chat: (command: ChatCommand) => ipcRenderer.invoke('desktop:chat', command),
  receipts: (action: 'history' | 'clear-confirmed', offset = 0) => ipcRenderer.invoke('desktop:receipts', action, offset)
})

contextBridge.exposeInMainWorld('ideer', bridge)

import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '../shared/desktop'

const bridge: DesktopBridge = Object.freeze({
  getStatus: () => ipcRenderer.invoke('desktop:status'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  startRuntime: () => ipcRenderer.invoke('desktop:runtime:start'),
  stopRuntime: () => ipcRenderer.invoke('desktop:runtime:stop')
})

contextBridge.exposeInMainWorld('ideer', bridge)

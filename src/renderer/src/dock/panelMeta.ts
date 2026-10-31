// Panel vocabulary and column positions follow the pinned linz dock (issue 71).
// Unwired capabilities stay listed so their entry position shows an honest
// status instead of disappearing; `runtime` is the Desktop-specific device
// pane that carries the existing Runtime/Update/Compatibility surfaces.
import type { PanelRuntime, PanelTypeId } from './types'

export interface PanelMeta {
  id: PanelTypeId
  title: string
  multiInstance: boolean
  closable: boolean
  anchorOnly?: boolean
  runtime: PanelRuntime
}

export const PANEL_META: Record<PanelTypeId, PanelMeta> = {
  chat: { id: 'chat', title: '对话', multiInstance: false, closable: false, anchorOnly: true, runtime: 'native' },
  runtime: { id: 'runtime', title: '本机 Runtime', multiInstance: false, closable: true, runtime: 'native' },
  browser: { id: 'browser', title: '浏览器', multiInstance: true, closable: true, runtime: 'webview' },
  terminal: { id: 'terminal', title: '终端', multiInstance: true, closable: true, runtime: 'pty' },
  files: { id: 'files', title: '文件', multiInstance: false, closable: true, runtime: 'native' },
  kb: { id: 'kb', title: '知识库', multiInstance: false, closable: true, runtime: 'native' },
  viewer3d: { id: 'viewer3d', title: '三维模型', multiInstance: false, closable: true, runtime: 'webgl' },
  field: { id: 'field', title: '仿真结果', multiInstance: false, closable: true, runtime: 'webgl' },
  sql: { id: 'sql', title: '数据', multiInstance: false, closable: true, runtime: 'native' },
  synapse: { id: 'synapse', title: '会话地图', multiInstance: false, closable: true, runtime: 'webview' }
}

export function getPanelMeta(id: PanelTypeId): PanelMeta {
  return PANEL_META[id]
}

export function defaultTitle(id: PanelTypeId, index: number): string {
  if (id === 'browser') return `浏览器 ${index}`
  if (id === 'terminal') return `终端 ${index}`
  return PANEL_META[id].title
}

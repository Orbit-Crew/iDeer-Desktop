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
  // Issue 110: the human terminal is native-hosted — a desktop-local PTY in
  // main with xterm.js rendering and its own minimal bridge; its output is
  // content, not embedded external content (decision #59), so it leaves the
  // external-content seam. The 'pty' runtime value stays reserved: #111's
  // Agent-controlled terminal never hosts a live PTY — it is a read-only
  // projection of the Runtime's own recorded history and in-flight tails
  // (escaped text, honest end states), so it is native-hosted like the
  // office pane, and the trusted desktop:* family carries its data.
  terminal: { id: 'terminal', title: '终端', multiInstance: true, closable: true, runtime: 'native' },
  // Issue 111: the Agent-controlled terminal — read-only observation of the
  // Runtime-carried command history; the platform Agent addresses it, the
  // human watches and may stop a Run.
  agentTerminal: { id: 'agentTerminal', title: '受控终端', multiInstance: false, closable: true, runtime: 'native' },
  files: { id: 'files', title: '文件', multiInstance: false, closable: true, runtime: 'native' },
  kb: { id: 'kb', title: '知识库', multiInstance: false, closable: true, runtime: 'native' },
  // Issue 115: the CAD viewer is native-hosted like the terminal — it renders
  // the device's own converted geometry (three.js WebGL, or its software 2D
  // engine) over the Runtime-guarded workspace read. No external content is
  // ever embedded, so it leaves the external-content seam.
  viewer3d: { id: 'viewer3d', title: '三维模型', multiInstance: false, closable: true, runtime: 'native' },
  // Issue 116: the field pane returns as a native-hosted pane — desktop-local
  // simulation results, not external content (decision #59 family). It reads
  // over the #94 guarded desktop:files seam and renders on a software 2D
  // canvas, the same reclassification the terminal got.
  field: { id: 'field', title: '仿真结果', multiInstance: false, closable: true, runtime: 'native' },
  sql: { id: 'sql', title: '数据', multiInstance: false, closable: true, runtime: 'native' },
  // Issue 113: the session map is a native pane — a read-only projection of
  // the platform's own Thread rows plus this device's observed branch edges.
  // It never hosts external content, so it leaves the webview seam.
  synapse: { id: 'synapse', title: '会话地图', multiInstance: false, closable: true, runtime: 'native' },
  // Issue 77: the reusable notification center — one native pane over the
  // main-process ledger; later tickets (tray badge, installs, updates) record
  // into the same surface instead of rebuilding it.
  notifications: { id: 'notifications', title: '通知中心', multiInstance: false, closable: true, runtime: 'native' },
  // Issue 84: the prompt-template plaza — account-scoped CRUD and the
  // prefill-only click, over the Server's own template rows.
  templates: { id: 'templates', title: '模板广场', multiInstance: false, closable: true, runtime: 'native' },
  // Issue 112: the office returns as a read-only visualization of the
  // platform's Run/subagent events — the #95 office exclusion narrows to
  // exactly this surface: figures render only what the platform pushed,
  // with no control operations and no local orchestration channel.
  office: { id: 'office', title: '办公室', multiInstance: false, closable: true, runtime: 'native' }
}

export function getPanelMeta(id: PanelTypeId): PanelMeta {
  return PANEL_META[id]
}

export function defaultTitle(id: PanelTypeId, index: number): string {
  if (id === 'browser') return `浏览器 ${index}`
  if (id === 'terminal') return `终端 ${index}`
  return PANEL_META[id].title
}

// Issue 117: task result kind → pane mapping for the auto-open trigger. The
// table is the single extension point: add a lowercase-extension row naming a
// single-instance panel and the trigger picks it up; a result whose extension
// is unlisted is never auto-opened. Entries mirror the surfaces that can
// actually render the kind (CAD extensions match the trusted cadPane
// whitelist; Tecplot ASCII rides the field pane's structured-IJK subset).
export const RESULT_PANE_TYPES: Record<string, PanelTypeId> = {
  '.stl': 'viewer3d',
  '.obj': 'viewer3d',
  '.stp': 'viewer3d',
  '.step': 'viewer3d',
  '.plt': 'field',
  '.dat': 'field'
}


// Issue 110: the pane close guard (decision #59.4). Closing a human terminal
// pane explicitly asks whether to end the programs inside — "保留程序" keeps
// the pane and its programs untouched, "结束程序并关闭" kills the PTY
// sessions and closes. Every path that removes a terminal instance routes
// through here: the pane close button, the tab close button, and layout-
// preset replacement (which rebuilds the layout and would otherwise end
// programs silently). A terminal whose process already exited never blocks a
// close. Move/drag paths only re-home instances and never ask.
import { create } from 'zustand'
import { isPane, useDockStore } from './dockStore'
import { applyPreset } from './layoutPresets'
import { useTerminalSessionStore } from '../stores/terminalSessions'
import type { DockLayout } from './types'

export type CloseTarget =
  | { kind: 'pane'; paneId: string }
  | { kind: 'tab'; paneId: string; tabId: string }
  | { kind: 'preset'; presetId: string }

export interface PendingClose {
  target: CloseTarget
  sessions: { instanceId: string; sessionId: string }[]
}

interface CloseGuardState {
  pending: PendingClose | null
  request: (target: CloseTarget) => void
  confirm: () => void
  cancel: () => void
}

/** Pure lookup: which of the given instances still run a live PTY session. */
export function liveTerminalSessions(instanceIds: string[]): { instanceId: string; sessionId: string }[] {
  const live = useTerminalSessionStore.getState().byInstance
  const result: { instanceId: string; sessionId: string }[] = []
  for (const instanceId of instanceIds) {
    const session = live[instanceId]
    if (session && !session.exited) result.push({ instanceId, sessionId: session.sessionId })
  }
  return result
}

function terminalInstanceIds(layout: DockLayout, target: CloseTarget): string[] {
  if (target.kind === 'preset') {
    return Object.values(layout.instances).filter((inst) => inst.panelType === 'terminal').map((inst) => inst.id)
  }
  const pane = layout.byId[target.paneId]
  if (!pane || !isPane(pane)) return []
  if (target.kind === 'pane') {
    return pane.tabs.filter((tab) => tab.panelType === 'terminal' && tab.instanceId).map((tab) => tab.instanceId!)
  }
  const tab = pane.tabs.find((t) => t.id === target.tabId)
  return tab?.instanceId ? [tab.instanceId] : []
}

function performClose(target: CloseTarget): void {
  const dock = useDockStore.getState()
  if (target.kind === 'pane') dock.closePane(target.paneId)
  else if (target.kind === 'tab') dock.closeTab(target.paneId, target.tabId)
  else applyPreset(target.presetId)
}

export const useCloseGuardStore = create<CloseGuardState>((set, get) => ({
  pending: null,
  request: (target) => {
    const layout = useDockStore.getState().layout
    const sessions = liveTerminalSessions(terminalInstanceIds(layout, target))
    if (sessions.length === 0) {
      performClose(target)
      return
    }
    set({ pending: { target, sessions } })
  },
  confirm: () => {
    const pending = get().pending
    if (!pending) return
    set({ pending: null })
    for (const { instanceId, sessionId } of pending.sessions) {
      try { void window.ideerTerminal.kill(sessionId).catch(() => {}) } catch { /* unmount cleanup kills as a fallback */ }
      useTerminalSessionStore.getState().unregister(instanceId)
    }
    performClose(pending.target)
  },
  cancel: () => set({ pending: null })
}))

/** PaneFrame's pane close button entry. */
export function requestPaneClose(paneId: string): void {
  useCloseGuardStore.getState().request({ kind: 'pane', paneId })
}

/** PaneFrame's tab close button entry. */
export function requestTabClose(paneId: string, tabId: string): void {
  useCloseGuardStore.getState().request({ kind: 'tab', paneId, tabId })
}

/** LayoutPresetDropdown's preset application entry. */
export function requestPresetApply(presetId: string): void {
  useCloseGuardStore.getState().request({ kind: 'preset', presetId })
}

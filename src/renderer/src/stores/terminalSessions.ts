// Issue 110: renderer-side registry of the dock's live human-terminal
// sessions. The pane component registers its session once the desktop-local
// PTY spawn resolves; the close-ask guard reads it to decide whether closing
// a pane would end running programs (decision #59.4). Session ids are
// volatile by contract — persistence.ts already strips them on save, so a
// restart always opens new sessions.
import { create } from 'zustand'

export interface TerminalInstanceSession {
  sessionId: string
  /** Set when the main process reported the PTY exited; a dead session
   * never blocks a pane close. */
  exited: boolean
}

interface TerminalSessionState {
  byInstance: Record<string, TerminalInstanceSession>
  register: (instanceId: string, sessionId: string) => void
  markExited: (instanceId: string) => void
  unregister: (instanceId: string) => void
}

export const useTerminalSessionStore = create<TerminalSessionState>((set) => ({
  byInstance: {},
  register: (instanceId, sessionId) =>
    set((s) => ({ byInstance: { ...s.byInstance, [instanceId]: { sessionId, exited: false } } })),
  markExited: (instanceId) =>
    set((s) => {
      const current = s.byInstance[instanceId]
      if (!current || current.exited) return {}
      return { byInstance: { ...s.byInstance, [instanceId]: { ...current, exited: true } } }
    }),
  unregister: (instanceId) =>
    set((s) => {
      if (!(instanceId in s.byInstance)) return {}
      const byInstance = { ...s.byInstance }
      delete byInstance[instanceId]
      return { byInstance }
    })
}))

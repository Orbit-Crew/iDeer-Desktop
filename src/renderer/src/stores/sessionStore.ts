// Issue 72: the session sidebar never owns chat state — it signals the chat
// panel, which keeps the single serialized command path and its snapshot.
import { create } from 'zustand'

/** Issue 91: the sidebar's project view. `all` shows every session grouped by
 * the Server's own membership, `loose` only the unassigned ones, and a
 * project narrows the list to its members while new sessions created in the
 * chat panel join that project on the Server. The selection is this device's
 * view state only — the project list itself always comes from the platform. */
export type ProjectSelection = { kind: 'all' } | { kind: 'loose' } | { kind: 'project'; projectId: string }

interface SessionState {
  /** The thread the sidebar asked to open, re-keyed by nonce so repeating the
   * same thread always produces a fresh signal. */
  pendingOpen: { threadId: string; nonce: number } | null
  /** The thread id the chat panel currently has open, for the sidebar's highlight. */
  activeThreadId: string
  /** Issue 78: bumped after a successful branch — the Server's session set
   * changed underneath the sidebar (a new Thread exists), so the sidebar
   * re-reads the platform's own list instead of waiting for a manual refresh. */
  sessionsVersion: number
  /** Issue 91: the sidebar's project view plus the chat panel's create home.
   * The selection is device-local view state; the project list itself always
   * comes from the platform. */
  projectSelection: ProjectSelection
  requestOpen(threadId: string): void
  clearPendingOpen(): void
  setActiveThreadId(threadId: string): void
  bumpSessionsVersion(): void
  setProjectSelection(selection: ProjectSelection): void
}

let nonce = 0

export const useSessionStore = create<SessionState>((set) => ({
  pendingOpen: null,
  activeThreadId: '',
  sessionsVersion: 0,
  projectSelection: { kind: 'all' },
  requestOpen: (threadId) => set({ pendingOpen: { threadId, nonce: ++nonce } }),
  clearPendingOpen: () => set({ pendingOpen: null }),
  setActiveThreadId: (threadId) => set((state) => state.activeThreadId === threadId ? state : { activeThreadId: threadId }),
  bumpSessionsVersion: () => set((state) => ({ sessionsVersion: state.sessionsVersion + 1 })),
  setProjectSelection: (projectSelection) => set({ projectSelection })
}))

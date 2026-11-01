// Issue 72: the session sidebar never owns chat state — it signals the chat
// panel, which keeps the single serialized command path and its snapshot.
import { create } from 'zustand'

interface SessionState {
  /** The thread the sidebar asked to open, re-keyed by nonce so repeating the
   * same thread always produces a fresh signal. */
  pendingOpen: { threadId: string; nonce: number } | null
  /** The thread id the chat panel currently has open, for the sidebar's highlight. */
  activeThreadId: string
  requestOpen(threadId: string): void
  clearPendingOpen(): void
  setActiveThreadId(threadId: string): void
}

let nonce = 0

export const useSessionStore = create<SessionState>((set) => ({
  pendingOpen: null,
  activeThreadId: '',
  requestOpen: (threadId) => set({ pendingOpen: { threadId, nonce: ++nonce } }),
  clearPendingOpen: () => set({ pendingOpen: null }),
  setActiveThreadId: (threadId) => set((state) => state.activeThreadId === threadId ? state : { activeThreadId: threadId })
}))

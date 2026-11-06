// Issue 72: the session sidebar never owns chat state — it signals the chat
// panel, which keeps the single serialized command path and its snapshot.
import { create } from 'zustand'

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
  /** Issue 84: one template click asks the composer to prefill its draft.
   * Prefill only — the composer never sends on a template click; the
   * placeholders stay visible until the user fills or edits them away. */
  pendingPrefill: { nonce: number; content: string } | null
  requestOpen(threadId: string): void
  clearPendingOpen(): void
  setActiveThreadId(threadId: string): void
  bumpSessionsVersion(): void
  requestPrefill(content: string): void
  clearPendingPrefill(): void
}

let nonce = 0

export const useSessionStore = create<SessionState>((set) => ({
  pendingOpen: null,
  activeThreadId: '',
  sessionsVersion: 0,
  pendingPrefill: null,
  requestOpen: (threadId) => set({ pendingOpen: { threadId, nonce: ++nonce } }),
  clearPendingOpen: () => set({ pendingOpen: null }),
  setActiveThreadId: (threadId) => set((state) => state.activeThreadId === threadId ? state : { activeThreadId: threadId }),
  bumpSessionsVersion: () => set((state) => ({ sessionsVersion: state.sessionsVersion + 1 })),
  requestPrefill: (content) => set({ pendingPrefill: { content, nonce: ++nonce } }),
  clearPendingPrefill: () => set({ pendingPrefill: null })
}))

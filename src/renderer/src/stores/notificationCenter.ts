// Issue 77: the notification center store. The trusted main process owns the
// ledger; every push replaces the whole view, so the renderer never merges
// local notification state. Activation — from an OS toast or a center row —
// asks the chat panel to open the event's session through the same handshake
// the sidebar uses, and marks the record read in the same round.
import { create } from 'zustand'
import type { DesktopBridge, NotificationCenterView } from '../../../shared/desktop'
import { useSessionStore } from './sessionStore'

interface NotificationState {
  view: NotificationCenterView
  /** AppLayout mounts the app-lifetime controller once; panes act through it. */
  controller: NotificationCenterController | null
  attach(controller: NotificationCenterController | null): void
  applyView(view: NotificationCenterView): void
}

export const useNotificationCenter = create<NotificationState>((set) => ({
  view: { notifications: [], unread: 0 },
  controller: null,
  attach: (controller) => set({ controller }),
  applyView: (view) => set({ view })
}))

export class NotificationCenterController {
  private stopped = false
  private unsubscribers: (() => void)[] = []
  constructor(private readonly api: Pick<DesktopBridge, 'notifications' | 'onNotifications' | 'onNotificationActivate'>) {}

  start(): void {
    if (this.stopped) return
    this.unsubscribers.push(this.api.onNotifications((view) => useNotificationCenter.getState().applyView(view)))
    this.unsubscribers.push(this.api.onNotificationActivate(({ id, threadId }) => { void this.open(id, threadId) }))
    void this.api.notifications({ action: 'list' }).then((view) => {
      if (!this.stopped) useNotificationCenter.getState().applyView(view)
    }).catch(() => {})
  }

  stop(): void {
    this.stopped = true
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
  }

  async open(id: string, threadId: string): Promise<void> {
    useSessionStore.getState().requestOpen(threadId)
    try {
      useNotificationCenter.getState().applyView(await this.api.notifications({ action: 'read', id }))
    } catch { /* 主进程已关闭或通道失效：跳回本身已经发生 */ }
  }

  async markAllRead(): Promise<void> {
    try {
      useNotificationCenter.getState().applyView(await this.api.notifications({ action: 'read-all' }))
    } catch { /* 下一次推送会带回真实视图 */ }
  }

  async clear(): Promise<void> {
    try {
      useNotificationCenter.getState().applyView(await this.api.notifications({ action: 'clear' }))
    } catch { /* 下一次推送会带回真实视图 */ }
  }
}

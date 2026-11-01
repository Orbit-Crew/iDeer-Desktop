import { randomUUID } from 'node:crypto'
import type { NotificationRecordView, NotificationCenterView, RuntimeNotifyEvent } from '../shared/desktop'
import { NOTIFICATION_APPROVAL_LABELS, NOTIFICATION_STATUS_LABELS } from '../shared/desktop'

/**
 * Issue 77: the Desktop's own notification ledger. The owned Runtime reports
 * background-session facts (a run that finished while its session was
 * switched away, an approval ask on a session the user cannot see) as bounded
 * events on the status stdout; this module is the single place that parses
 * them strictly and keeps them for the notification center. Later tickets
 * (tray badge, installs, updates) record their own events here instead of
 * rebuilding the surface.
 *
 * Everything here stays free of Electron imports so the wire shape and the
 * ledger rules are unit-testable without a running app.
 */

const idPattern = /^[A-Za-z0-9_-]{1,128}$/

const text = (value: unknown, limit: number): string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit ? value : ''

/** The OS toast copy; the label wording itself lives in shared/desktop.ts so
 * the renderer's center pane reads the exact same facts. */
export function describeNotification(event: RuntimeNotifyEvent): { title: string; body: string } {
  const subject = event.title || `会话 ${event.threadId.slice(0, 12)}`
  if (event.kind === 'run-finished') {
    const outcome = NOTIFICATION_STATUS_LABELS[event.status] || event.status
    return { title: '后台会话已完成', body: `${subject} · ${outcome}` }
  }
  const outcome = NOTIFICATION_APPROVAL_LABELS[event.approval] || event.approval
  return { title: '后台会话等待审批', body: `${subject} · ${outcome}${event.summary ? `\n${event.summary}` : ''}` }
}

/** Strictly one notify event; anything else is a protocol failure the caller
 * treats like a malformed status line. */
export function parseNotifyEvent(value: unknown): RuntimeNotifyEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'run-finished') {
    if (Object.keys(value).length !== 5) return null
    const row = value as Record<string, unknown>
    if (!idPattern.test(text(row.threadId, 128)) || !idPattern.test(text(row.runId, 128)) ||
        !text(row.status, 32) || typeof row.title !== 'string' || row.title.length > 256) return null
    return { kind, threadId: row.threadId as string, runId: row.runId as string,
      status: row.status as string, title: row.title as string }
  }
  if (kind === 'approval-required') {
    if (Object.keys(value).length !== 7) return null
    const row = value as Record<string, unknown>
    if (!idPattern.test(text(row.threadId, 128)) || !idPattern.test(text(row.runId, 128)) ||
        !idPattern.test(text(row.taskId, 128)) || !text(row.approval, 32) ||
        typeof row.summary !== 'string' || row.summary.length > 200 ||
        typeof row.title !== 'string' || row.title.length > 256) return null
    return { kind, threadId: row.threadId as string, runId: row.runId as string,
      taskId: row.taskId as string, approval: row.approval as string,
      summary: row.summary as string, title: row.title as string }
  }
  return null
}

/** The bounded display ledger: newest first, 100 records, one row per fact.
 * A finished run is unique by its thread and run; an approval ask is unique
 * by its task, so a resolved ask that reappears is asked again. */
export class NotificationRegistry {
  private rows: NotificationRecordView[] = []

  record(event: RuntimeNotifyEvent): NotificationRecordView | null {
    if (event.kind === 'run-finished' &&
        this.rows.some((row) => row.kind === 'run-finished' && row.threadId === event.threadId && row.runId === event.runId)) {
      return null
    }
    if (event.kind === 'approval-required' &&
        this.rows.some((row) => row.kind === 'approval-required' && row.taskId === event.taskId)) {
      return null
    }
    const record: NotificationRecordView = {
      id: randomUUID(),
      kind: event.kind,
      threadId: event.threadId,
      runId: event.runId,
      ...(event.kind === 'approval-required' ? { taskId: event.taskId, approval: event.approval } : {}),
      title: event.title,
      summary: event.kind === 'run-finished' ? event.status : event.summary,
      createdAt: new Date().toISOString(),
      read: false
    }
    this.rows = [record, ...this.rows].slice(0, 100)
    return record
  }

  list(): NotificationCenterView {
    return {
      notifications: this.rows.map((row) => ({ ...row })),
      unread: this.rows.filter((row) => !row.read).length
    }
  }

  markRead(id: string): boolean {
    const row = this.rows.find((item) => item.id === id)
    if (!row) return false
    row.read = true
    return true
  }

  markAllRead(): void {
    for (const row of this.rows) row.read = true
  }

  clear(): void {
    this.rows = []
  }
}

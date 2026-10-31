import { describe, expect, it } from 'vitest'
import { NotificationRegistry, parseNotifyEvent } from '../src/main/notifications'
import type { RuntimeNotifyEvent } from '../src/shared/desktop'

const finished: RuntimeNotifyEvent = {
  kind: 'run-finished', threadId: 'thread-A', runId: 'run-1', status: 'success', title: '会话标题'
}
const approval: RuntimeNotifyEvent = {
  kind: 'approval-required', threadId: 'thread-A', runId: 'run-1', taskId: 'task-1',
  approval: 'file-write', summary: '/workspace/a/target.txt', title: '会话标题'
}

describe('parseNotifyEvent', () => {
  it('accepts exactly the two bounded event shapes', () => {
    expect(parseNotifyEvent(finished)).toEqual(finished)
    expect(parseNotifyEvent(approval)).toEqual(approval)
  })
  it('rejects anything outside the fixed shapes', () => {
    const bad: unknown[] = [
      null, 'x', 42, [], {},
      { ...finished, kind: 'celebration' },
      { ...approval, kind: 'celebration' },
      { ...finished, threadId: '' },
      { ...finished, threadId: 'bad id!' },
      { ...finished, runId: '' },
      { ...finished, runId: 'x'.repeat(129) },
      { ...finished, status: '' },
      { ...finished, status: 'x'.repeat(33) },
      { ...finished, title: 7 },
      { ...approval, taskId: '' },
      { ...approval, approval: '' },
      { ...approval, approval: 'x'.repeat(33) },
      { ...approval, summary: 'x'.repeat(201) },
      { ...approval, title: undefined },
      { ...approval, extra: true }
    ]
    for (const value of bad) expect(parseNotifyEvent(value)).toBeNull()
  })
})

describe('NotificationRegistry', () => {
  it('records newest first and counts unread', () => {
    const registry = new NotificationRegistry()
    const first = registry.record(finished)
    const second = registry.record(approval)
    expect(registry.list().notifications.map((row) => row.id)).toEqual([second.id, first.id])
    expect(registry.list().unread).toBe(2)
    expect(second.kind).toBe('approval-required')
    expect(second.summary).toBe('/workspace/a/target.txt')
    expect(first.status).toBe('success')
  })
  it('never duplicates the same finished run or the same ask', () => {
    const registry = new NotificationRegistry()
    const once = registry.record(finished)
    expect(registry.record(finished)).toBeNull()
    const asked = registry.record(approval)
    expect(asked).not.toBeNull()
    expect(registry.record(approval)).toBeNull()
    expect(registry.list().notifications.map((row) => row.id)).toEqual([asked!.id, once!.id])
    expect(registry.list().unread).toBe(2)
  })
  it('a different run of the same thread is its own row', () => {
    const registry = new NotificationRegistry()
    registry.record(finished)
    const next = registry.record({ ...finished, runId: 'run-2' })
    expect(next).not.toBeNull()
    expect(registry.list().notifications).toHaveLength(2)
  })
  it('marks one, all, and clears', () => {
    const registry = new NotificationRegistry()
    const first = registry.record(finished)!
    const second = registry.record(approval)!
    expect(registry.markRead('missing')).toBe(false)
    expect(registry.markRead(first.id)).toBe(true)
    expect(registry.list().unread).toBe(1)
    expect(registry.list().notifications.find((row) => row.id === first.id)?.read).toBe(true)
    registry.markAllRead()
    expect(registry.list().unread).toBe(0)
    registry.clear()
    expect(registry.list()).toEqual({ notifications: [], unread: 0 })
    expect(second.id).toBeTruthy()
  })
  it('keeps only the newest 100 records', () => {
    const registry = new NotificationRegistry()
    for (let index = 0; index < 120; index++) {
      registry.record({ ...finished, runId: `run-${index}` })
    }
    const view = registry.list()
    expect(view.notifications).toHaveLength(100)
    expect(view.unread).toBe(100)
    expect(view.notifications[0].runId).toBe('run-119')
    expect(view.notifications.at(-1)?.runId).toBe('run-20')
  })
})

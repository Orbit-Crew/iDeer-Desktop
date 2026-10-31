import { describe, expect, it, vi } from 'vitest'
import { explainThreadError, SessionSidebarController, type SessionSidebarView } from '../src/renderer/src/stores/sessionSidebar'
import type { DesktopBridge, ThreadView } from '../src/shared/desktop'

type ThreadsApi = Pick<DesktopBridge, 'threads'>

const threadView = (overrides: Partial<ThreadView> = {}): ThreadView => ({
  threads: [
    { id: 'thread-A', title: 'Alpha 会话', status: 'idle', updatedAt: '2026-10-31T07:00:00+00:00' },
    { id: 'thread-B', title: 'Beta 会话', status: 'busy', updatedAt: '2026-10-30T09:00:00+00:00' }
  ],
  permissions: { canRename: true, canDelete: true },
  ...overrides
})

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('session sidebar controller (#72)', () => {
  it('publishes the Server list and permissions after one load round', async () => {
    const pending = deferred<ThreadView>()
    const views: SessionSidebarView[] = []
    const api: ThreadsApi = { threads: vi.fn(() => pending.promise) }
    const controller = new SessionSidebarController(api, (view) => views.push(view))
    const done = controller.load()
    expect(controller.snapshot().busy).toBe(true)
    pending.resolve(threadView())
    await done
    const final = controller.snapshot()
    expect(final.busy).toBe(false)
    expect(final.failed).toBe(false)
    expect(final.threads.map((row) => row.id)).toEqual(['thread-A', 'thread-B'])
    expect(final.permissions).toEqual({ canRename: true, canDelete: true })
  })

  it('refuses rename and delete locally when the account lacks the permission', async () => {
    const calls: unknown[] = []
    const api: ThreadsApi = { threads: vi.fn((command) => { calls.push(command); return Promise.resolve(threadView({ permissions: { canRename: false, canDelete: false } })) }) }
    const controller = new SessionSidebarController(api, () => {})
    await controller.rename('thread-A', '新名字')
    await controller.remove('thread-A')
    expect(calls).toEqual([])
  })

  it('trims the rename title and rides the confirmed rename round', async () => {
    const pending = deferred<ThreadView>()
    const calls: unknown[] = []
    const api: ThreadsApi = { threads: vi.fn((command) => { calls.push(command); return pending.promise }) }
    const controller = new SessionSidebarController(api, () => {})
    // A load round establishes the account's permissions before any write.
    const listed = controller.load()
    pending.resolve(threadView())
    await listed
    const next = deferred<ThreadView>()
    ;(api.threads as ReturnType<typeof vi.fn>).mockImplementation((command) => {
      calls.push(command)
      return next.promise
    })
    const done = controller.rename('thread-A', '  新名字  ')
    next.resolve(threadView({ renamed: true }))
    await done
    expect(calls).toEqual([
      { action: 'list' },
      { action: 'rename', threadId: 'thread-A', title: '新名字' }
    ])
    expect(controller.snapshot().failed).toBe(false)
  })

  it('explains the fixed platform rejection categories', async () => {
    const responses: ThreadView[] = [threadView()]
    const api: ThreadsApi = { threads: vi.fn(() => responses.length
      ? Promise.resolve(responses.shift()!)
      : Promise.reject(new Error('CHAT_CONFLICT'))) }
    const controller = new SessionSidebarController(api, () => {})
    await controller.load()
    await controller.remove('thread-A')
    const final = controller.snapshot()
    expect(final.failed).toBe(true)
    expect(final.error).toBe('CHAT_CONFLICT')
    expect(explainThreadError('CHAT_CONFLICT')).toContain('任务在执行')
  })

  it('keeps a canceled confirmation dialog silent', async () => {
    const api: ThreadsApi = { threads: vi.fn(() => Promise.reject(new Error('THREADS_CANCELED'))) }
    const controller = new SessionSidebarController(api, () => {})
    await controller.load()
    await controller.remove('thread-A')
    const final = controller.snapshot()
    expect(final.failed).toBe(false)
    expect(final.error).toBe('')
    expect(final.busy).toBe(false)
  })

  it('retries a wire-busy round a bounded number of times instead of failing', async () => {
    vi.useFakeTimers()
    try {
      const calls: unknown[] = []
      // The load round succeeds first; only the delete hits the busy wire.
      const responses: (ThreadView | Error)[] = [threadView(), new Error('THREADS_BUSY'), new Error('THREADS_BUSY'), threadView({ deleted: true })]
      const api: ThreadsApi = { threads: vi.fn((command) => {
        calls.push(command)
        const next = responses.shift()
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next!)
      }) }
      const controller = new SessionSidebarController(api, () => {})
      await controller.load()
      const done = controller.remove('thread-B')
      await vi.advanceTimersByTimeAsync(400)
      await vi.advanceTimersByTimeAsync(400)
      await done
      const final = controller.snapshot()
      expect(final.failed).toBe(false)
      expect(final.threads.map((row) => row.id)).toEqual(['thread-A', 'thread-B'])
      expect(calls.filter((command) => (command as { action: string }).action === 'delete')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the stale reply of a superseded round', async () => {
    const first = deferred<ThreadView>()
    const second = deferred<ThreadView>()
    const calls: unknown[] = []
    const api: ThreadsApi = { threads: vi.fn((command) => { calls.push(command); return calls.length === 1 ? first.promise : second.promise }) }
    const controller = new SessionSidebarController(api, () => {})
    const stale = controller.load()
    const fresh = controller.search('beta')
    first.resolve(threadView())
    await stale
    second.resolve(threadView({ threads: [{ id: 'thread-B', title: 'Beta 会话', status: 'busy', updatedAt: '2026-10-30T09:00:00+00:00' }] }))
    await fresh
    const final = controller.snapshot()
    expect(final.threads.map((row) => row.id)).toEqual(['thread-B'])
    expect(final.query).toBe('beta')
    expect(final.failed).toBe(false)
  })
})

// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NotificationsPane from '../src/renderer/src/dock/panels/notificationsPane'
import { NotificationCenterController, useNotificationCenter } from '../src/renderer/src/stores/notificationCenter'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { DesktopBridge, NotificationCenterView, NotificationRecordView, RuntimeNotifyEvent } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

beforeEach(() => {
  useNotificationCenter.setState({ view: { notifications: [], unread: 0 }, controller: null })
  useSessionStore.setState({ pendingOpen: null, activeThreadId: '' })
})

const finishedRow: NotificationRecordView = {
  id: 'n-1', kind: 'run-finished', threadId: 'thread-A', runId: 'run-1',
  title: '后台会话 A', summary: 'success', createdAt: '2026-11-01T09:00:00.000Z', read: false
}
const approvalRow: NotificationRecordView = {
  id: 'n-2', kind: 'approval-required', threadId: 'thread-B', runId: 'run-2', taskId: 'task-9',
  approval: 'file-write', title: '后台会话 B', summary: '/workspace/b/target.txt',
  createdAt: '2026-11-01T09:05:00.000Z', read: false
}

interface Harness {
  api: Pick<DesktopBridge, 'notifications' | 'onNotifications' | 'onNotificationActivate'>
  pushes: NotificationCenterView[]
  activations: { id: string; threadId: string }[]
  commands: unknown[]
  emitPush(view: NotificationCenterView): void
  emitActivate(id: string, threadId: string): void
}

const harness = (): Harness => {
  const listeners: ((view: NotificationCenterView) => void)[] = []
  const activateListeners: ((payload: { id: string; threadId: string }) => void)[] = []
  const record: Harness = {
    pushes: [], activations: [], commands: [],
    emitPush: (view) => { record.pushes.push(view); for (const listener of listeners) listener(view) },
    emitActivate: (id, threadId) => { for (const listener of activateListeners) listener({ id, threadId }) },
    api: {
      notifications: vi.fn((command: unknown) => {
        record.commands.push(command)
        return Promise.resolve({ notifications: [], unread: 0 })
      }),
      onNotifications: vi.fn((listener: (view: NotificationCenterView) => void) => {
        listeners.push(listener)
        return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1) }
      }),
      onNotificationActivate: vi.fn((listener: (payload: { id: string; threadId: string }) => void) => {
        activateListeners.push(listener)
        return () => { const index = activateListeners.indexOf(listener); if (index >= 0) activateListeners.splice(index, 1) }
      })
    }
  }
  return record
}

describe('notification center controller (#77)', () => {
  it('loads the initial view and replaces it on every push', async () => {
    const record = harness()
    const initial: NotificationCenterView = { notifications: [finishedRow], unread: 1 }
    record.api.notifications = vi.fn(() => Promise.resolve(initial))
    const controller = new NotificationCenterController(record.api)
    controller.start()
    await waitFor(() => expect(useNotificationCenter.getState().view.notifications).toHaveLength(1))
    record.emitPush({ notifications: [finishedRow, approvalRow], unread: 2 })
    expect(useNotificationCenter.getState().view).toEqual({ notifications: [finishedRow, approvalRow], unread: 2 })
    controller.stop()
    record.emitPush({ notifications: [], unread: 0 })
    // 停止后不再接收推送替换视图。
    expect(useNotificationCenter.getState().view.notifications).toHaveLength(2)
  })
  it('activation and row opens jump to the session and mark the record read', async () => {
    const record = harness()
    const controller = new NotificationCenterController(record.api)
    controller.start()
    record.emitActivate('n-2', 'thread-B')
    await waitFor(() => expect(useSessionStore.getState().pendingOpen?.threadId).toBe('thread-B'))
    expect(record.api.notifications).toHaveBeenCalledWith({ action: 'read', id: 'n-2' })
    const pendingNonce = useSessionStore.getState().pendingOpen?.nonce
    await controller.open('n-1', 'thread-A')
    expect(useSessionStore.getState().pendingOpen?.threadId).toBe('thread-A')
    expect(useSessionStore.getState().pendingOpen?.nonce).not.toBe(pendingNonce)
    expect(record.commands).toContainEqual({ action: 'read', id: 'n-1' })
    controller.stop()
  })
  it('mark-all-read and clear settle on the bridge and apply the reply', async () => {
    const record = harness()
    const readAllReply: NotificationCenterView = { notifications: [{ ...finishedRow, read: true }], unread: 0 }
    record.api.notifications = vi.fn((command: { action: string }) =>
      Promise.resolve(command.action === 'read-all' ? readAllReply : { notifications: [], unread: 0 }))
    const controller = new NotificationCenterController(record.api)
    controller.start()
    await controller.markAllRead()
    expect(useNotificationCenter.getState().view.unread).toBe(0)
    await controller.clear()
    expect(useNotificationCenter.getState().view.notifications).toHaveLength(0)
  })
})

describe('notification center pane (#77)', () => {
  it('renders rows with kind facts and jumps on click only through the controller', () => {
    useNotificationCenter.setState({ view: { notifications: [finishedRow, approvalRow], unread: 2 } })
    const { container } = render(<NotificationsPane />)
    expect(container.textContent).toContain('后台会话 A')
    expect(container.textContent).toContain('会话完成 · 成功')
    expect(container.textContent).toContain('后台会话 B')
    expect(container.textContent).toContain('等待审批 · 文件写入 · /workspace/b/target.txt')
    expect(screen.getAllByLabelText('未读')).toHaveLength(2)
    // 无控制器（静态启动）：跳回按钮不可点，但视图仍然如实。
    fireEvent.click(screen.getByLabelText(/后台会话 A/))
    expect(useSessionStore.getState().pendingOpen).toBeNull()
    expect(screen.getByLabelText('全部标为已读').hasAttribute('disabled')).toBe(true)
  })
  it('a controller-mounted pane opens the session and settles the row', async () => {
    const record = harness()
    // 读取回执回显当前视图（清空除外），与真实主进程行为一致。
    record.api.notifications = vi.fn((command: unknown) => {
      record.commands.push(command)
      const action = (command as { action: string }).action
      if (action === 'clear') return Promise.resolve({ notifications: [], unread: 0 })
      return Promise.resolve(useNotificationCenter.getState().view)
    })
    const controller = new NotificationCenterController(record.api)
    useNotificationCenter.setState({
      view: { notifications: [approvalRow], unread: 1 },
      controller
    })
    render(<NotificationsPane />)
    fireEvent.click(screen.getByLabelText(/后台会话 B/))
    await waitFor(() => expect(useSessionStore.getState().pendingOpen?.threadId).toBe('thread-B'))
    expect(record.commands).toContainEqual({ action: 'read', id: 'n-2' })
    fireEvent.click(screen.getByLabelText('全部标为已读'))
    await waitFor(() => expect(record.commands).toContainEqual({ action: 'read-all' }))
    fireEvent.click(screen.getByLabelText('清空通知'))
    await waitFor(() => expect(record.commands).toContainEqual({ action: 'clear' }))
  })
})

describe('notification event facts ride the shared wire type (#77)', () => {
  it('keeps the two kinds distinguishable for future reuse', () => {
    const finished: RuntimeNotifyEvent = {
      kind: 'run-finished', threadId: 'thread-A', runId: 'run-1', status: 'success', title: 'A'
    }
    const approval: RuntimeNotifyEvent = {
      kind: 'approval-required', threadId: 'thread-A', runId: 'run-1', taskId: 'task-1',
      approval: 'file-write', summary: '/workspace/a/t.txt', title: 'A'
    }
    expect(finished.kind).not.toBe(approval.kind)
    expect(approval.taskId).toBe('task-1')
  })
})

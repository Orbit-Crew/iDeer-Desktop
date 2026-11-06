// @vitest-environment jsdom
// Issue 95: switching the project view is this device's view state only —
// an in-flight Run keeps running and a pending approval stays reachable from
// its original session AND through the notification center jump-back, no
// matter which project the sidebar is narrowed to.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChatPanel from '../src/renderer/src/components/ChatPanel'
import NotificationsPane from '../src/renderer/src/dock/panels/notificationsPane'
import { NotificationCenterController, useNotificationCenter } from '../src/renderer/src/stores/notificationCenter'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { ChatCommand, ChatSnapshot, DesktopBridge, NotificationRecordView } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

beforeEach(() => {
  useSessionStore.setState({ pendingOpen: null, activeThreadId: '', sessionsVersion: 0,
    projectSelection: { kind: 'all' }, pendingPrefill: null })
  useNotificationCenter.setState({ view: { notifications: [], unread: 0 }, controller: null })
})

const approvalSnapshot = (threadId: string, runId = 'run-1'): ChatSnapshot => ({
  scope: 'identity',
  resources: [{ id: 'agent-main', type: 'agent', name: 'Main', visibility: 'private', version: 1, available: true, reason: '' }],
  threads: [], messages: [], events: [], subagents: [],
  thread: threadId ? { id: threadId, status: 'busy', agentId: 'agent-main', skillId: '' } : null,
  run: threadId ? { id: runId, status: 'running', selection: {} } : null,
  stream: 'streaming', error: '', lastEventId: '',
  localConsents: threadId ? [{ taskId: 'task-9', runId, threadId, requestHash: 'a'.repeat(64),
    path: '/workspace/p1/result.txt', content: 'AFTER' }] : []
})

describe('project switch keeps the original session and its approval reachable (#95)', () => {
  it('switching the project view never tears down a pending approval in the open session', async () => {
    const commands: ChatCommand[] = []
    ;(window as { ideer?: unknown }).ideer = {
      chat: vi.fn((command: unknown) => {
        commands.push(command as ChatCommand)
        return Promise.resolve(approvalSnapshot('thread-A'))
      })
    }
    render(<ChatPanel />)
    await screen.findByText('本机文件写入审批')
    // 切到另一个项目：纯视图状态，会话与待审批卡片原地不动。
    useSessionStore.getState().setProjectSelection({ kind: 'project', projectId: 'proj-2' })
    expect(screen.getByText('本机文件写入审批')).toBeTruthy()
    expect(screen.getByText(/\/workspace\/p1\/result\.txt/)).toBeTruthy()
    // The poll keeps observing the original Run while the view is narrowed.
    await waitFor(() => expect(commands.filter((command) => command.action === 'state').length).toBeGreaterThanOrEqual(2))
    expect(useSessionStore.getState().activeThreadId).toBe('thread-A')
    // 切回全部会话：同一张审批卡仍在，仍可从原会话批准。
    useSessionStore.getState().setProjectSelection({ kind: 'all' })
    fireEvent.click(screen.getByRole('button', { name: '仅允许这一次' }))
    await waitFor(() => expect(commands.some((command) => command.action === 'consent')).toBe(true))
    expect(commands.find((command) => command.action === 'consent')).toMatchObject({
      action: 'consent', scope: 'identity', threadId: 'thread-A', runId: 'run-1',
      taskId: 'task-9', decision: 'allow', requestHash: 'a'.repeat(64)
    })
    // 15 s: the poll loop at 500 ms cadence plus the antd card render
    // legitimately outrun the 5 s default when a live-bridge test shares the
    // runner (same per-test extension as session-sidebar).
  }, 15000)

  it('opens the approval-holding session through the sidebar handshake while another project is selected', async () => {
    let open = ''
    const commands: ChatCommand[] = []
    ;(window as { ideer?: unknown }).ideer = {
      chat: vi.fn((command: unknown) => {
        commands.push(command as ChatCommand)
        if ((command as { action: string }).action === 'open') open = 'thread-A'
        return Promise.resolve(approvalSnapshot(open))
      })
    }
    // The user has narrowed the view to another project; the original
    // session's row is not in the visible list, but the open must not care.
    useSessionStore.getState().setProjectSelection({ kind: 'project', projectId: 'proj-2' })
    render(<ChatPanel />)
    await waitFor(() => expect(useSessionStore.getState().activeThreadId).toBe(''))
    useSessionStore.getState().requestOpen('thread-A')
    await waitFor(() => expect(commands.some((command) => command.action === 'open')).toBe(true))
    expect(commands.find((command) => command.action === 'open'))
      .toEqual({ action: 'open', scope: 'identity', threadId: 'thread-A' })
    expect(screen.getByText('本机文件写入审批')).toBeTruthy()
    expect(screen.getByRole('button', { name: '仅允许这一次' })).toBeTruthy()
  }, 15000)
})

describe('notification jump-back reaches the original session under any project view (#95)', () => {
  const approvalRow: NotificationRecordView = {
    id: 'n-95', kind: 'approval-required', threadId: 'thread-A', runId: 'run-1', taskId: 'task-9',
    approval: 'file-write', title: '后台会话 A', summary: '/workspace/p1/result.txt',
    createdAt: '2026-11-01T09:05:00.000Z', read: false
  }

  const harness = (): Pick<DesktopBridge, 'notifications' | 'onNotifications' | 'onNotificationActivate'> => ({
    notifications: vi.fn((command: unknown) => {
      const action = (command as { action: string }).action
      return Promise.resolve(action === 'read'
        ? { notifications: [{ ...approvalRow, read: true }], unread: 0 }
        : { notifications: [approvalRow], unread: 1 })
    }),
    onNotifications: vi.fn(() => () => {}),
    onNotificationActivate: vi.fn(() => () => {})
  })

  it('the controller opens the approval session while another project view is active', async () => {
    useSessionStore.getState().setProjectSelection({ kind: 'project', projectId: 'proj-2' })
    const controller = new NotificationCenterController(harness())
    controller.start()
    await controller.open('n-95', 'thread-A')
    expect(useSessionStore.getState().pendingOpen?.threadId).toBe('thread-A')
    controller.stop()
  })

  it('the pane row click jumps back through the attached controller', async () => {
    const controller = new NotificationCenterController(harness())
    useNotificationCenter.setState({ view: { notifications: [approvalRow], unread: 1 }, controller })
    render(<NotificationsPane />)
    fireEvent.click(screen.getByLabelText(/后台会话 A/))
    await waitFor(() => expect(useSessionStore.getState().pendingOpen?.threadId).toBe('thread-A'))
    // The jump-back itself never touches the project view state.
    expect(useSessionStore.getState().projectSelection).toEqual({ kind: 'all' })
  })
})

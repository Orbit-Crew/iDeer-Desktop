// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import ChatPanel, { ChatView } from '../src/renderer/src/components/ChatPanel'
import Sidebar from '../src/renderer/src/components/Layout/Sidebar'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { ChatCommand, ChatSnapshot } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

beforeEach(() => {
  useSessionStore.setState({ pendingOpen: null, activeThreadId: '', sessionsVersion: 0 })
})

const snapshotWith = (messages: ChatSnapshot['messages'], extra: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages, events: [], subagents: [],
  thread: { id: 'thread-A', status: 'idle', agentId: 'agent', skillId: '' },
  stream: 'idle', error: '', lastEventId: '', ...extra
})

const transcript = (): ChatSnapshot['messages'] => [
  { id: 'h1', role: 'human', name: '', text: '第一个问题' },
  { id: 'a1', role: 'ai', name: '', text: '第一段回答' },
  { id: 'a2', role: 'ai', name: '', text: '第二段回答' },
  { id: 'h2', role: 'human', name: '', text: '第二个问题' },
  { id: 'a3', role: 'ai', name: '', text: '最终回答' }
]

describe('branch action on completed assistant turns (#78)', () => {
  it('branches a turn with its whole assistant group from the named message', () => {
    const commands: ChatCommand[] = []
    const html = render(<ChatView state={snapshotWith(transcript())} busy={false}
      onCommand={async (command) => { commands.push(command) }} />)
    const buttons = html.getAllByLabelText('从此回复分支')
    expect(buttons).toHaveLength(3)
    // The turn's first segment still names the whole turn: the platform
    // branches from one completed assistant turn, not one chunk.
    fireEvent.click(buttons[0])
    expect(commands).toEqual([{ action: 'branch', scope: 'identity', threadId: 'thread-A',
      messageId: 'a1', messageIds: ['a1', 'a2'] }])
    // The last turn carries a single assistant id, so the wire stays minimal.
    commands.length = 0
    fireEvent.click(buttons[2])
    expect(commands).toEqual([{ action: 'branch', scope: 'identity', threadId: 'thread-A', messageId: 'a3' }])
  })

  it('holds the branch action back while the turn is not settled', () => {
    const base = { ...snapshotWith(transcript()) }
    for (const extra of [
      { stream: 'streaming' as const },
      { run: { id: 'run-1', status: 'running', selection: {} } },
      { messages: [...transcript(), { id: 't1', role: 'tool' as const, name: 'ask', text: '',
        request: { version: 1 as const, kind: 'human_input_request' as const, source: 'ask', request_id: 'r1',
          question: '继续吗', input_mode: 'single_choice' as const, options: [] } }] }
    ]) {
      const settled = render(<ChatView state={{ ...base, ...extra }} busy={false} onCommand={async () => {}} />)
      for (const button of settled.getAllByLabelText('从此回复分支')) {
        expect((button as HTMLButtonElement).disabled).toBe(true)
      }
      settled.unmount()
    }
    // Human and tool messages never offer the action.
    const plain = render(<ChatView state={snapshotWith([
      { id: 'h1', role: 'human', name: '', text: '问题' },
      { id: 'a1', role: 'ai', name: '', text: '回答' },
      { id: 't1', role: 'tool', name: 'tool', text: '工具' }
    ])} busy={false} onCommand={async () => {}} />)
    expect(plain.getAllByLabelText('从此回复分支')).toHaveLength(1)
    plain.unmount()
  })

  it('lets the panel serial path carry the branch and signals the sidebar', async () => {
    const calls: unknown[] = []
    let failBranch = true
    let current = 'thread-A'
    const reply = (): ChatSnapshot => snapshotWith(transcript(),
      { thread: { id: current, status: 'idle', agentId: 'agent', skillId: '' } })
    ;(window as { ideer?: unknown }).ideer = {
      chat: vi.fn((command: unknown) => {
        calls.push(command)
        if ((command as { action: string }).action === 'branch' && failBranch) {
          return Promise.reject(new Error('CHAT_CONFLICT'))
        }
        if ((command as { action: string }).action === 'branch') current = 'branch-9'
        return Promise.resolve(reply())
      })
    }
    render(<ChatPanel />)
    await waitFor(() => expect(useSessionStore.getState().activeThreadId).toBe('thread-A'))
    expect(useSessionStore.getState().sessionsVersion).toBe(0)
    // The branch rides the panel's single serialized command path. A platform
    // refusal never signals the sidebar; the poll restores the transcript.
    const buttons = () => document.querySelectorAll('[aria-label="从此回复分支"]')
    await waitFor(() => expect(buttons().length).toBeGreaterThan(0))
    fireEvent.click(buttons()[0])
    await waitFor(() => expect(calls.some((c) => (c as { action: string }).action === 'branch')).toBe(true))
    expect(useSessionStore.getState().sessionsVersion).toBe(0)
    await waitFor(() => expect(buttons().length).toBeGreaterThan(0))
    // On the Server's own reply the new Thread replaces the transcript, the
    // poll moves the sidebar highlight, and the sidebar is told the Server's
    // session set changed underneath it.
    failBranch = false
    fireEvent.click(buttons()[0])
    await waitFor(() => expect(useSessionStore.getState().sessionsVersion).toBe(1))
    await waitFor(() => expect(useSessionStore.getState().activeThreadId).toBe('branch-9'))
  })
})

describe('sidebar list reload after a branch (#78)', () => {
  it('re-reads the Server list when the session set changes', async () => {
    const threads = vi.fn(() => Promise.resolve({ threads: [
      { id: 'thread-A', title: '原会话', status: 'idle', updatedAt: '2026-11-01T00:00:00Z' }],
      permissions: { canRename: true, canDelete: true } }))
    ;(window as { ideer?: unknown }).ideer = { threads }
    render(<Sidebar />)
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(1))
    useSessionStore.getState().bumpSessionsVersion()
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(2))
  })
})
// @vitest-environment jsdom
// Issue 113: the Synapse session map pane. Every node is one of the
// account's own platform threads; every edge is a branch fact the device
// itself observed — a row whose parent is missing from the page renders
// unconnected, never as a guessed node. Opening and branching ride the
// session store's signals (the conversation's own serialized command path),
// so the map never sends a session mutation over the bridge itself.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import SynapsePane, { SynapseView } from '../src/renderer/src/dock/panels/synapsePane'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { ChatSnapshot, ThreadRowView, ThreadView } from '../src/shared/desktop'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

beforeEach(() => {
  useSessionStore.setState({ pendingOpen: null, pendingBranch: null, activeThreadId: '', sessionsVersion: 0 })
})

const rows = (): ThreadRowView[] => [
  { id: 'thread-root', title: '根会话', status: 'idle', updatedAt: '2026-11-07T03:00:00Z', projectId: '' },
  { id: 'branch-1', title: '支线一', status: 'idle', updatedAt: '2026-11-07T02:00:00Z', projectId: '',
    branchedFrom: { threadId: 'thread-root', messageId: 'a1' } },
  { id: 'orphan', title: '失联支线', status: 'idle', updatedAt: '2026-11-07T01:00:00Z', projectId: '',
    branchedFrom: { threadId: 'gone-parent', messageId: 'a9' } }
]

const view = (over: Partial<ThreadView> = {}): ThreadView =>
  ({ threads: rows(), permissions: { canRename: true, canDelete: true }, ...over })

const snapshot = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages: [], events: [], subagents: [],
  thread: { id: 'thread-root', status: 'idle', agentId: 'agent', skillId: '' },
  stream: 'idle', error: '', lastEventId: '', ...over
})

const handlers = (over: { onOpen?: (id: string) => void; onBranch?: () => void } = {}) => ({
  failed: false,
  view: view(),
  snapshot: snapshot(),
  activeThreadId: '',
  onOpen: over.onOpen ?? (() => {}),
  onBranch: over.onBranch ?? (() => {}),
  onRefresh: () => {}
})

describe('synapse map view (#113)', () => {
  it('renders one node per platform row and edges only between present endpoints', () => {
    const html = render(<SynapseView {...handlers()} />)
    // Three platform rows, three nodes — including the row whose recorded
    // parent sits outside the page.
    expect(html.getAllByLabelText(/^会话节点/)).toHaveLength(3)
    // Only the edge with both endpoints on the page is drawn; the orphan
    // never gains a fabricated parent node.
    expect(html.getAllByLabelText(/^分支连线/)).toHaveLength(1)
    expect(html.getByLabelText('分支连线：根会话 → 支线一')).toBeTruthy()
  })

  it('clicking a node asks the store to open the session and nothing else', () => {
    const opened: string[] = []
    const html = render(<SynapseView {...handlers({ onOpen: (id) => opened.push(id) })} />)
    fireEvent.click(html.getByLabelText('会话节点：根会话'))
    expect(opened).toEqual(['thread-root'])
  })

  it('offers 从此分支 on the open session only under the conversation gate', () => {
    const html = render(<SynapseView {...handlers({ onBranch: () => {} })} activeThreadId="thread-root" />)
    const link = html.getByLabelText('从此分支：根会话')
    fireEvent.click(link)
    html.unmount()
    // A blocked gate hides the affordance instead of pretending.
    for (const blocked of [
      snapshot({ stream: 'streaming' as const }),
      snapshot({ run: { id: 'run-1', status: 'running', selection: {} } }),
      snapshot({ platform: { reachable: false, detail: '' } }),
      snapshot({ messages: [{ id: 't1', role: 'tool' as const, name: 'ask', text: '',
        request: { version: 1 as const, kind: 'human_input_request' as const, source: 'ask', request_id: 'r1',
          question: '继续吗', input_mode: 'single_choice' as const, options: [] } }] })
    ]) {
      const blockedView = render(<SynapseView {...handlers()} snapshot={blocked} activeThreadId="thread-root" />)
      expect(blockedView.queryByLabelText(/从此分支/)).toBeNull()
      blockedView.unmount()
    }
  })

  it('hides the branch affordance without the list write permission or on other nodes', () => {
    const noRename = render(<SynapseView {...handlers()} view={view({ permissions: { canRename: false, canDelete: false } })}
      activeThreadId="thread-root" />)
    expect(noRename.queryByLabelText(/从此分支/)).toBeNull()
    noRename.unmount()
    // The affordance follows the open session: 支线一 active means its own
    // node offers it and no other node does.
    const otherActive = render(<SynapseView {...handlers()} activeThreadId="branch-1" />)
    expect(otherActive.getByLabelText('从此分支：支线一')).toBeTruthy()
    expect(otherActive.queryByLabelText('从此分支：根会话')).toBeNull()
  })

  it('shows the unavailable and empty states instead of inventing content', () => {
    const failed = render(<SynapseView {...handlers()} failed view={null} />)
    expect(failed.getByText('平台未连接，会话地图不可用')).toBeTruthy()
    failed.unmount()
    const empty = render(<SynapseView {...handlers()} view={view({ threads: [] })} />)
    expect(empty.getByText('暂无会话')).toBeTruthy()
  })

  it('offers no session management controls', () => {
    const html = render(<SynapseView {...handlers()} activeThreadId="thread-root" />)
    expect(html.queryByText('重命名')).toBeNull()
    expect(html.queryByText('删除')).toBeNull()
  })
})

describe('synapse pane wiring (#113)', () => {
  const fakeBridge = (threads: ReturnType<typeof vi.fn>, chat: ReturnType<typeof vi.fn>): void => {
    ;(window as unknown as { ideer: unknown }).ideer = { threads, chat }
  }

  it('loads the platform list on mount and again when the sessions signal bumps', async () => {
    const threads = vi.fn(async () => view())
    const chat = vi.fn(async () => snapshot())
    fakeBridge(threads, chat)
    render(<SynapsePane />)
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(1))
    expect(threads.mock.calls[0][0]).toEqual({ action: 'list' })
    useSessionStore.getState().bumpSessionsVersion()
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(2))
    // The pane's own chat use stays the read-only state read.
    expect(chat.mock.calls.every(([command]) => command.action === 'state')).toBe(true)
  })

  it('asks the store to branch instead of sending a branch over the bridge', async () => {
    const threads = vi.fn(async () => view())
    const chat = vi.fn(async () => snapshot())
    fakeBridge(threads, chat)
    useSessionStore.setState({ activeThreadId: 'thread-root' })
    const html = render(<SynapsePane />)
    await waitFor(() => expect(html.getByLabelText(/从此分支/)).toBeTruthy())
    fireEvent.click(html.getByLabelText(/从此分支/))
    await waitFor(() => expect(useSessionStore.getState().pendingBranch).not.toBeNull())
    expect(chat.mock.calls.every(([command]) => command.action === 'state')).toBe(true)
  })

  it('clicking a node asks the store to open and never touches the bridge with an open', async () => {
    const threads = vi.fn(async () => view())
    const chat = vi.fn(async () => snapshot())
    fakeBridge(threads, chat)
    const html = render(<SynapsePane />)
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(1))
    fireEvent.click(html.getByLabelText('会话节点：根会话'))
    expect(useSessionStore.getState().pendingOpen?.threadId).toBe('thread-root')
  })
})

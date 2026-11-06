// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Sidebar from '../src/renderer/src/components/Layout/Sidebar'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import { emptyProjectDirectoryView, type ProjectDirectoryView } from '../src/renderer/src/stores/projectDirectory'
import type { ProjectOperationView, ThreadView } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

beforeEach(() => {
  useSessionStore.setState({ pendingOpen: null, activeThreadId: '', projectSelection: { kind: 'all' } })
})

const threadView = (overrides: Partial<ThreadView> = {}): ThreadView => ({
  threads: [
    { id: 'thread-A', title: 'Alpha 会话', status: 'idle', updatedAt: '2026-10-31T07:00:00+00:00', projectId: 'proj-1' },
    { id: 'thread-B', title: 'Beta 会话', status: 'busy', updatedAt: '2026-10-30T09:00:00+00:00', projectId: '' }
  ],
  permissions: { canRename: true, canDelete: true },
  ...overrides
})

const projectView = (overrides: Partial<ProjectOperationView> = {}): ProjectOperationView => ({
  projects: [
    { id: 'proj-1', name: '工程项目', status: 'active', createdAt: '2026-10-30T08:00:00+00:00', updatedAt: '2026-10-31T07:00:00+00:00' }
  ],
  permissions: { canWrite: true, canDelete: true },
  ...overrides
})

const projectDirectory = (overrides: Partial<ProjectDirectoryView> = {}): ProjectDirectoryView => ({
  ...emptyProjectDirectoryView(),
  projects: projectView().projects,
  permissions: { canWrite: true, canDelete: true },
  ...overrides
})

const stubIdeer = (impl: (command: unknown) => Promise<ThreadView>, projects: ProjectDirectoryView = projectDirectory()):
  { calls: unknown[]; projectCalls: unknown[] } => {
  const calls: unknown[] = []
  const projectCalls: unknown[] = []
  ;(window as { ideer?: unknown }).ideer = {
    threads: vi.fn((command: unknown) => { calls.push(command); return impl(command) }),
    projects: vi.fn((command: unknown) => { projectCalls.push(command); return Promise.resolve(projects) }),
    quit: vi.fn(() => Promise.resolve())
  }
  return { calls, projectCalls }
}

describe('session sidebar management (#72)', () => {
  it('renders the platform list recency-ordered and opens the clicked thread', async () => {
    stubIdeer(() => Promise.resolve(threadView()))
    render(<Sidebar />)
    const list = await screen.findByRole('list', { name: '平台会话列表' })
    const opens = [...list.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
      .filter((label) => label?.startsWith('打开会话'))
    expect(opens).toEqual(['打开会话 Alpha 会话', '打开会话 Beta 会话'])
    fireEvent.click(screen.getByRole('button', { name: '打开会话 Beta 会话' }))
    expect(useSessionStore.getState().pendingOpen?.threadId).toBe('thread-B')
  })

  it('searches the platform after the debounce instead of building a local roster', async () => {
    vi.useFakeTimers()
    try {
      const { calls } = stubIdeer((command) =>
        Promise.resolve((command as { action: string }).action === 'search'
          ? threadView({ threads: [{ id: 'thread-B', title: 'Beta 会话', status: 'busy', updatedAt: '2026-10-30T09:00:00+00:00' }] })
          : threadView()))
      render(<Sidebar />)
      await vi.advanceTimersByTimeAsync(0)
      expect((calls[0] as { action: string }).action).toBe('list')
      fireEvent.change(screen.getByRole('textbox', { name: '搜索平台会话' }), { target: { value: 'beta' } })
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(400)
      expect(calls[1]).toEqual({ action: 'search', query: 'beta' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('renames through the inline editor and rides the platform round', async () => {
    const { calls } = stubIdeer(() => Promise.resolve(threadView()))
    render(<Sidebar />)
    fireEvent.click(await screen.findByRole('button', { name: '重命名会话 Alpha 会话' }))
    const input = screen.getByRole('textbox', { name: '重命名会话 Alpha 会话' })
    fireEvent.change(input, { target: { value: '  改名后的会话  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认重命名' }))
    await waitFor(() => expect(calls.some((command) => (command as { action: string }).action === 'rename')).toBe(true))
    expect(calls.find((command) => (command as { action: string }).action === 'rename'))
      .toEqual({ action: 'rename', threadId: 'thread-A', title: '改名后的会话' })
  })

  it('deletes after the inline confirm and re-reads the platform list', async () => {
    const { calls } = stubIdeer(() => Promise.resolve(threadView()))
    render(<Sidebar />)
    fireEvent.click(await screen.findByRole('button', { name: '删除会话 Beta 会话' }))
    fireEvent.click(await screen.findByRole('button', { name: /^删\s*除$/ }))
    await waitFor(() => expect(calls.some((command) => (command as { action: string }).action === 'delete')).toBe(true))
    expect(calls.find((command) => (command as { action: string }).action === 'delete'))
      .toEqual({ action: 'delete', threadId: 'thread-B' })
  })

  it('grays out and explains every operation the account cannot perform', async () => {
    stubIdeer(() => Promise.resolve(threadView({ permissions: { canRename: false, canDelete: false } })))
    render(<Sidebar />)
    const rename = await screen.findByRole('button', { name: /重命名会话 Alpha 会话（不可用/ })
    const remove = await screen.findByRole('button', { name: /删除会话 Beta 会话（不可用/ })
    expect(rename.hasAttribute('disabled')).toBe(true)
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('当前账号为只读，重命名与删除不可用。')).toBeTruthy()
    expect(rename.getAttribute('aria-label')).toContain('threads:write')
    expect(remove.getAttribute('aria-label')).toContain('threads:delete')
  })

  it('shows the fixed platform rejection instead of a raw failure', async () => {
    const calls: unknown[] = []
    ;(window as { ideer?: unknown }).ideer = {
      threads: vi.fn((command: unknown) => {
        calls.push(command)
        return (command as { action: string }).action === 'list'
          ? Promise.resolve(threadView())
          : Promise.reject(new Error('CHAT_CONFLICT'))
      }),
      projects: vi.fn(() => Promise.resolve(projectView())),
      quit: vi.fn(() => Promise.resolve())
    }
    render(<Sidebar />)
    await screen.findByRole('button', { name: '打开会话 Alpha 会话' })
    fireEvent.click(screen.getByRole('button', { name: '删除会话 Beta 会话' }))
    fireEvent.click(await screen.findByRole('button', { name: /^删\s*除$/ }))
    await waitFor(() => expect(screen.getByText(/任务在执行/)).toBeTruthy())
    // 15 s: the delete round-trip renders the full sidebar twice and outruns
    // the 5 s default on slow CI runners (same extension as the archive
    // fallback test below).
  }, 15000)
})

describe('session sidebar project grouping (#91)', () => {
  const openLabels = (): string[] =>
    [...(screen.getByRole('list', { name: '平台会话列表' }).querySelectorAll('button'))]
      .map((button) => button.getAttribute('aria-label')).filter((label) => label?.startsWith('打开会话'))
  const groupHeaders = (): string[] =>
    [...(screen.getByRole('list', { name: '平台会话列表' }).querySelectorAll('div'))]
      .map((div) => div.textContent).filter((text) => text === '散会话' || text === '工程项目')

  it('groups sessions by the Server membership stamp with 散会话 last', async () => {
    stubIdeer(() => Promise.resolve(threadView({ threads: [
      { id: 'thread-A', title: 'Alpha 会话', status: 'idle', updatedAt: '2026-10-31T07:00:00+00:00', projectId: 'proj-1' },
      { id: 'thread-B', title: 'Beta 会话', status: 'busy', updatedAt: '2026-10-30T09:00:00+00:00', projectId: '' }
    ] })))
    render(<Sidebar />)
    await screen.findByRole('button', { name: '打开会话 Alpha 会话' })
    // One header per group inside the list: the project's members first, the
    // loose bucket last, per the reply's own recency order.
    expect(groupHeaders()).toEqual(['工程项目', '散会话'])
    expect(openLabels()).toEqual(['打开会话 Alpha 会话', '打开会话 Beta 会话'])
  })

  it('falls back to the loose bucket for an unknown project id instead of inventing a group', async () => {
    stubIdeer(() => Promise.resolve(threadView({ threads: [
      { id: 'thread-A', title: 'Alpha 会话', status: 'idle', updatedAt: '2026-10-31T07:00:00+00:00', projectId: 'proj-gone' },
      { id: 'thread-B', title: 'Beta 会话', status: 'busy', updatedAt: '2026-10-30T09:00:00+00:00', projectId: '' }
    ] })))
    render(<Sidebar />)
    await screen.findByRole('button', { name: '打开会话 Alpha 会话' })
    // One 散会话 group carries both sessions; no phantom project group.
    expect(groupHeaders()).toEqual(['散会话'])
    expect(openLabels()).toEqual(['打开会话 Alpha 会话', '打开会话 Beta 会话'])
  })

  it('narrows the list to the selected project and restores the full view after', async () => {
    stubIdeer(() => Promise.resolve(threadView()))
    render(<Sidebar />)
    await screen.findByRole('button', { name: '打开会话 Beta 会话' })
    fireEvent.click(screen.getByRole('button', { name: '切换到项目 工程项目' }))
    expect(useSessionStore.getState().projectSelection).toEqual({ kind: 'project', projectId: 'proj-1' })
    await waitFor(() => expect(openLabels()).toEqual(['打开会话 Alpha 会话']))
    // Switching back restores the full grouped list.
    fireEvent.click(screen.getByRole('button', { name: '查看全部会话' }))
    await waitFor(() => expect(openLabels()).toEqual(['打开会话 Alpha 会话', '打开会话 Beta 会话']))
  })

  it('moves a loose session into a project through the Server round', async () => {
    const { calls } = stubIdeer(() => Promise.resolve(threadView()))
    render(<Sidebar />)
    fireEvent.click(await screen.findByRole('button', { name: '移入项目 Beta 会话' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '工程项目' }))
    await waitFor(() => expect(calls.some((command) => (command as { action: string }).action === 'move')).toBe(true))
    expect(calls.find((command) => (command as { action: string }).action === 'move'))
      .toEqual({ action: 'move', threadId: 'thread-B', projectId: 'proj-1' })
  })

  it('gates move and shows the reason without threads:write', async () => {
    stubIdeer(() => Promise.resolve(threadView({ permissions: { canRename: false, canDelete: true } })))
    render(<Sidebar />)
    const move = await screen.findByRole('button', { name: '移入项目 Beta 会话（不可用）' })
    expect(move.hasAttribute('disabled')).toBe(true)
  })

  // 15 s: three sequential antd-modal round-trips (mount → manage modal →
  // archive confirm) legitimately outrun the 5 s default on slow CI runners;
  // the same per-test extension as chat-attachments/recovery applies.
  it('falls back to the full view when the selected project is archived or deleted elsewhere', async () => {
    // Mount load and the manage modal's load both see the active project; the
    // archive round's post-action list no longer carries it as active.
    const projectCalls: unknown[] = []
    ;(window as { ideer?: unknown }).ideer = {
      threads: vi.fn(() => Promise.resolve(threadView())),
      projects: vi.fn((command: unknown) => {
        projectCalls.push(command)
        return Promise.resolve(projectCalls.length < 3
          ? projectView()
          : projectView({ archived: true, projects: [] }))
      }),
      quit: vi.fn(() => Promise.resolve())
    }
    render(<Sidebar />)
    fireEvent.click(await screen.findByRole('button', { name: '切换到项目 工程项目' }))
    expect(useSessionStore.getState().projectSelection).toEqual({ kind: 'project', projectId: 'proj-1' })
    fireEvent.click(screen.getByRole('button', { name: /项目管理/ }))
    fireEvent.click(await screen.findByRole('button', { name: '归档项目 工程项目' }))
    // The post-action list no longer offers the project as active; the
    // selection must not keep pointing new chats at a refused project.
    await waitFor(() => expect(useSessionStore.getState().projectSelection).toEqual({ kind: 'all' }))
  }, 15000)
})

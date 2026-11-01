// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Sidebar from '../src/renderer/src/components/Layout/Sidebar'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { ThreadView } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

beforeEach(() => {
  useSessionStore.setState({ pendingOpen: null, activeThreadId: '' })
})

const threadView = (overrides: Partial<ThreadView> = {}): ThreadView => ({
  threads: [
    { id: 'thread-A', title: 'Alpha 会话', status: 'idle', updatedAt: '2026-10-31T07:00:00+00:00' },
    { id: 'thread-B', title: 'Beta 会话', status: 'busy', updatedAt: '2026-10-30T09:00:00+00:00' }
  ],
  permissions: { canRename: true, canDelete: true },
  ...overrides
})

const stubIdeer = (impl: (command: unknown) => Promise<ThreadView>): { calls: unknown[] } => {
  const calls: unknown[] = []
  ;(window as { ideer?: unknown }).ideer = {
    threads: vi.fn((command: unknown) => { calls.push(command); return impl(command) })
  }
  return { calls }
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
      })
    }
    render(<Sidebar />)
    await screen.findByRole('button', { name: '打开会话 Alpha 会话' })
    fireEvent.click(screen.getByRole('button', { name: '删除会话 Beta 会话' }))
    fireEvent.click(await screen.findByRole('button', { name: /^删\s*除$/ }))
    await waitFor(() => expect(screen.getByText(/任务在执行/)).toBeTruthy())
  })
})

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatSnapshot } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const snapshotWith = (localTier?: ChatSnapshot['localTier']): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages: [], events: [],
  thread: { id: 'thread-A', status: 'idle', agentId: 'agent', skillId: '' },
  run: null, stream: 'idle', error: '', lastEventId: '', localTier
})

describe('session permission tiers are visible and switchable in the chat (#74)', () => {
  it('shows the lowest tier for a session without a tier choice', () => {
    render(<ChatView state={snapshotWith()} busy={false} onCommand={vi.fn()} />)
    expect(screen.getByRole('group', { name: '会话权限档位' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '变更前询问（默认）', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: '自主模式', pressed: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: '完全模式', pressed: false })).toBeTruthy()
    expect(screen.queryByText(/自主模式：/)).toBeNull()
    expect(screen.queryByText(/完全模式：/)).toBeNull()
  })

  it('keeps showing the lowest tier when the snapshot predates the field', () => {
    const state = snapshotWith()
    delete (state as { localTier?: unknown }).localTier
    render(<ChatView state={state} busy={false} onCommand={vi.fn()} />)
    expect(screen.getByRole('button', { name: '变更前询问（默认）', pressed: true })).toBeTruthy()
  })

  it('switches to the autonomous tier and states what it changes', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    render(<ChatView state={snapshotWith()} busy={false} onCommand={onCommand} />)
    fireEvent.click(screen.getByRole('button', { name: '自主模式' }))
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledWith({
      action: 'tier', scope: 'identity', threadId: 'thread-A', tier: 'autonomous'
    }))
  })

  it('sends the full-tier switch without ever signing the confirm flag itself', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    render(<ChatView state={snapshotWith()} busy={false} onCommand={onCommand} />)
    fireEvent.click(screen.getByRole('button', { name: '完全模式' }))
    await vi.waitFor(() => {
      const command = onCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>
      expect(command).toMatchObject({ action: 'tier', threadId: 'thread-A', tier: 'full' })
      expect(command.confirm).toBeUndefined()
    })
  })

  it('marks the active tier and explains its scope once upgraded', () => {
    render(<ChatView state={snapshotWith('autonomous')} busy={false} onCommand={vi.fn()} />)
    expect(screen.getByRole('button', { name: '自主模式', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: '自主模式' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/自主模式：授权文件夹内的写入不再逐次询问/)).toBeTruthy()
    expect(screen.queryByText(/完全模式：/)).toBeNull()
  })

  it('does not switch tiers while a command is in flight', () => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    render(<ChatView state={snapshotWith()} busy={true} onCommand={onCommand} />)
    expect(screen.getByRole('button', { name: '自主模式' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '完全模式' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '自主模式' }))
    expect(onCommand).not.toHaveBeenCalled()
  })
})

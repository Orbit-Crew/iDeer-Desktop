// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import ChatPanel from '../src/renderer/src/components/ChatPanel'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { ChatSnapshot } from '../src/shared/desktop'

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

const snapshotWith = (threadId: string): ChatSnapshot => ({
  scope: 'identity', resources: [], threads: [], messages: [], events: [],
  thread: threadId ? { id: threadId, status: 'idle', agentId: 'agent', skillId: '' } : null,
  stream: 'idle', error: '', lastEventId: ''
})

describe('sidebar-to-chat open handoff (#72)', () => {
  it('rides the chat panel serial path and never races the poll', async () => {
    const calls: unknown[] = []
    let open = 'thread-A'
    ;(window as { ideer?: unknown }).ideer = {
      chat: vi.fn((command: unknown) => {
        calls.push(command)
        if ((command as { action: string }).action === 'open') open = 'thread-B'
        return Promise.resolve(snapshotWith(open))
      })
    }
    render(<ChatPanel />)
    // The first poll reports the currently open thread to the sidebar.
    await waitFor(() => expect(useSessionStore.getState().activeThreadId).toBe('thread-A'))
    useSessionStore.getState().requestOpen('thread-B')
    await waitFor(() => expect(calls.some((command) => (command as { action: string }).action === 'open')).toBe(true))
    expect(calls.find((command) => (command as { action: string }).action === 'open'))
      .toEqual({ action: 'open', scope: 'identity', threadId: 'thread-B' })
    // The poll picked up the new snapshot and moved the sidebar highlight.
    await waitFor(() => expect(useSessionStore.getState().activeThreadId).toBe('thread-B'))
    // A fresh signal for the same thread issues exactly one more open —
    // re-clicking a session row is an explicit re-open of that thread.
    useSessionStore.getState().requestOpen('thread-B')
    await waitFor(() => expect(calls.filter((command) => (command as { action: string }).action === 'open')).toHaveLength(2))
  })

  it('waits for a scope before opening, then proceeds once the session exists', async () => {
    let authenticated = false
    const calls: unknown[] = []
    ;(window as { ideer?: unknown }).ideer = {
      chat: vi.fn((command: unknown) => {
        calls.push(command)
        const snapshot = snapshotWith(authenticated ? 'thread-A' : '')
        // An unauthenticated runtime reports an empty scope, exactly as the
        // real one does; the open must wait for a real session.
        if (!authenticated) snapshot.scope = ''
        return Promise.resolve(snapshot)
      })
    }
    render(<ChatPanel />)
    useSessionStore.getState().requestOpen('thread-B')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.some((command) => (command as { action: string }).action === 'open')).toBe(false)
    authenticated = true
    await waitFor(() => expect(calls.some((command) => (command as { action: string }).action === 'open')).toBe(true))
    expect(useSessionStore.getState().pendingOpen).toBeNull()
  })
})

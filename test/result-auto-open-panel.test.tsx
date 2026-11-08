// @vitest-environment jsdom
// Issue 117: the auto-open trigger's wiring contract on the panel that owns
// the chat poll. The polled snapshot is the only input ChatPanel forwards to
// consumeResultAutoOpen: an inside mapped result opens its pane through the
// dock store with its pending path; deleting the panel's forwarding call
// breaks this test. The authorization stays the Runtime's own verdict — the
// panel adds none, and an outside verdict in the very same snapshot field
// never opens anything.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from '../src/renderer/src/components/ChatPanel'
import { buildDefaultLayout } from '../src/renderer/src/dock/defaultLayout'
import { collectPanes, useDockStore } from '../src/renderer/src/dock/dockStore'
import { resetResultAutoOpenForTests } from '../src/renderer/src/dock/resultAutoOpen'
import type { ChatSnapshot, LocalResultView } from '../src/shared/desktop'

function resultRow(over: Partial<LocalResultView>): LocalResultView {
  return { task_id: 'task-117', run_id: 'run-117', thread_id: 'thread-A',
    capability: 'local.files.write', logical_root: '/workspace/ws',
    logical_path: '/workspace/ws/parts/bracket.stl', name: 'bracket.stl',
    sha256: 'a'.repeat(64), bytes: 12, artifact_ref: '', uploaded_at: '',
    workspace_state: 'inside', ...over }
}

function snapshot(localTasks: ChatSnapshot['localTasks']): ChatSnapshot {
  return { scope: 'scope-117', stream: 'idle', error: '', lastEventId: '',
    resources: [], threads: [], thread: null, messages: [], run: null, events: [], subagents: [],
    localTasks }
}

function hasTab(panelType: string): boolean {
  return collectPanes(useDockStore.getState().layout).some((p) =>
    p.tabs.some((t) => t.panelType === panelType))
}

beforeEach(() => {
  resetResultAutoOpenForTests()
  useDockStore.getState().hydrate(buildDefaultLayout())
  useDockStore.getState().clearAutoLoad('viewer3d')
  useDockStore.getState().clearAutoLoad('field')
})

afterEach(() => {
  cleanup()
  useDockStore.getState().clearAutoLoad('viewer3d')
  useDockStore.getState().clearAutoLoad('field')
  delete (window as unknown as { ideer?: unknown }).ideer
})

describe('ChatPanel auto-open wiring contract (#117)', () => {
  it('forwards the polled snapshot so an inside CAD result opens its pane', async () => {
    const chat = vi.fn(() => Promise.resolve(snapshot([
      { task_id: 'task-117', run_id: 'run-117', capability: 'local.files.write',
        logical_target: '/workspace/ws/parts/bracket.stl', status: 'completed',
        localResult: resultRow({}) }
    ])))
    ;(window as unknown as { ideer: unknown }).ideer = { chat }
    render(<ChatPanel />)
    await waitFor(() => expect(useDockStore.getState().autoLoad.viewer3d)
      .toBe('/workspace/ws/parts/bracket.stl'), { timeout: 3000 })
    expect(hasTab('viewer3d')).toBe(true)
  })

  it('forwards the same field honestly: an outside verdict never opens', async () => {
    const chat = vi.fn(() => Promise.resolve(snapshot([
      { task_id: 'task-118', run_id: 'run-118', capability: 'local.files.write',
        logical_target: '/workspace/ws/parts/bracket.stl', status: 'completed',
        localResult: resultRow({ task_id: 'task-118', run_id: 'run-118', workspace_state: 'outside' }) }
    ])))
    ;(window as unknown as { ideer: unknown }).ideer = { chat }
    render(<ChatPanel />)
    // Two poll rounds are enough to prove no trigger fired.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(useDockStore.getState().autoLoad.viewer3d).toBeUndefined()
    expect(hasTab('viewer3d')).toBe(false)
  })
})

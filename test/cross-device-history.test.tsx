// @vitest-environment jsdom
// Issue 95: cross-device history honestly marks what stays on the original
// device. A record whose device differs from the current device identity —
// or a Server task row with no local artifact on this device — is marked
// 仅原设备 with the same idiom the local-result card already uses.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import RuntimePanel from '../src/renderer/src/components/RuntimePanel'
import { ChatView } from '../src/renderer/src/components/ChatPanel'
import type { ChatSnapshot, DesktopStatus, ReceiptHistory } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const statusWith = (deviceId: string | undefined): DesktopStatus => ({
  version: '0.2.0', server: 'connected',
  runtime: {
    process: 'running', connection: 'connected', tasks: [], receiptScope: 'a'.repeat(64),
    login: { state: 'authenticated', account: 'A@test.invalid', device: '设备甲', error: '',
      ...(deviceId ? { deviceId } : {}) }
  }
})

const historyWith = (): ReceiptHistory => ({
  total: 2, pending: 1, confirmed: 1, uncertain: 0, cleaned: 0, storageError: '',
  rows: [
    { task_id: 'task-own', run_id: 'run-own', tool_call_id: 'call-own', capability: 'local.files.write',
      status: 'completed', user_id: 'A', device_id: 'device-current', delivery_state: 'confirmed',
      receipt_id: 'r-1', receipt_hash: null, logical_target: '/workspace/w/own.txt', error_code: '' },
    { task_id: 'task-far', run_id: 'run-far', tool_call_id: 'call-far', capability: 'local.python',
      status: 'completed', user_id: 'A', device_id: 'device-other', delivery_state: 'pending',
      receipt_id: 'r-2', receipt_hash: null, logical_target: '/workspace/w/far.txt', error_code: '' }
  ]
})

const stubIdeer = (deviceId: string | undefined): void => {
  ;(window as { ideer?: unknown }).ideer = {
    getStatus: vi.fn(() => Promise.resolve(statusWith(deviceId))),
    receipts: vi.fn(() => Promise.resolve(historyWith()))
  }
}

describe('receipt history cross-device marking (#95)', () => {
  it('marks receipt rows whose device differs from the current device identity', async () => {
    stubIdeer('device-current')
    render(<RuntimePanel />)
    // The rows ride a getStatus → receipts → getStatus refresh chain; give the
    // render its full budget instead of the 1 s default on slow CI runners.
    await screen.findByText(/task-far/, {}, { timeout: 10000 })
    expect(screen.getByText(/task-far/).textContent).toContain('仅原设备')
    expect(screen.getByText(/task-own/).textContent).not.toContain('仅原设备')
  })

  it('stays silent about device identity facts it does not know', async () => {
    // Without the current device identity (older Runtime, unauthenticated),
    // no row is marked; the raw device_id display remains the only fact.
    stubIdeer(undefined)
    render(<RuntimePanel />)
    await screen.findByText(/task-far/, {}, { timeout: 10000 })
    expect(screen.getByText(/task-far/).textContent).not.toContain('仅原设备')
    expect(screen.getByText(/task-far/).textContent).toContain('device-other')
  })
})

describe('chat history cross-device marking (#95)', () => {
  const baseState: ChatSnapshot = {
    scope: 'identity-A', resources: [], threads: [], messages: [], events: [], subagents: [],
    thread: { id: 'thread-95', status: 'idle', agentId: 'agent', skillId: '' },
    run: { id: 'run-95', status: 'interrupted', selection: {} }, stream: 'idle', error: '', lastEventId: ''
  }

  it('marks merged Server task rows without a local artifact as original-device-only', () => {
    const state: ChatSnapshot = { ...baseState, localTasks: [
      { task_id: 'task-far', run_id: 'run-far', capability: 'local.files.write',
        logical_target: '/workspace/w/far.txt', status: 'completed' },
      { task_id: 'task-own', run_id: 'run-own', capability: 'local.files.write',
        logical_target: '/workspace/w/own.txt', status: 'completed',
        local: { status: 'completed', delivery_state: 'pending' } }
    ] }
    const html = renderToStaticMarkup(<ChatView state={state} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('本机无可核实回执 · 本地结果仅原设备可用')
    expect(html).toContain('本机回执：已完成')
  })

  it('keeps the existing local-result idiom for this device\'s registered results', () => {
    const state: ChatSnapshot = { ...baseState, localTasks: [
      { task_id: 'task-own', run_id: 'run-own', capability: 'local.files.write',
        logical_target: '/workspace/w/own.txt', status: 'completed',
        local: { status: 'completed', delivery_state: 'pending' },
        localResult: { task_id: 'task-own', run_id: 'run-own', thread_id: 'thread-95',
          capability: 'local.files.write', logical_root: '/workspace/w', logical_path: '/workspace/w/own.txt',
          name: 'own.txt', sha256: 'a'.repeat(64), bytes: 5, artifact_ref: '', uploaded_at: '' } }
    ] }
    const html = renderToStaticMarkup(<ChatView state={state} busy={false} onCommand={async () => {}} />)
    expect(html).toContain('本地生成结果（仅原设备可用）')
    expect(html).not.toContain('本机无可核实回执')
  })
})

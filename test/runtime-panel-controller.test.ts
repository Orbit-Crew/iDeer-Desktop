import { describe, expect, it, vi } from 'vitest'
import { RuntimePanelController } from '../src/renderer/src/stores/runtimePanel'
import type { DesktopBridge, DesktopStatus, ReceiptHistory } from '../src/shared/desktop'

const owned = (scope: string): DesktopStatus => ({ version: 'fixture', server: 'connected', runtime: {
  process: 'running', connection: 'connected', receiptScope: scope,
  tasks: [{ taskId: 'task-' + scope, runId: 'run-' + scope, capability: 'local.files.read', state: 'completed' }]
} })
const records: ReceiptHistory = { total: 1, pending: 1, confirmed: 0, uncertain: 0, cleaned: 0, storageError: '', rows: [] }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Runtime panel asynchronous ownership boundary', () => {
  it('ignores a running status request that completes after Stop', async () => {
    const getStatus = vi.fn(async () => owned('A'))
    const receipts = vi.fn(async () => records)
    const api: Pick<DesktopBridge, 'getStatus' | 'receipts' | 'stopRuntime'> = { getStatus, receipts, stopRuntime: vi.fn(async () => {}) }
    const controller = new RuntimePanelController(api, () => {})
    await controller.refresh(0)
    expect(controller.snapshot().status?.runtime.tasks[0].taskId).toBe('task-A')
    const late = deferred<DesktopStatus>()
    getStatus.mockImplementationOnce(() => late.promise)
    const refreshing = controller.refresh(0)
    await controller.stop()
    const receiptRequests = receipts.mock.calls.length
    late.resolve(owned('A'))
    await refreshing
    expect(controller.snapshot().status?.runtime.process).toBe('stopped')
    expect(controller.snapshot().status?.runtime.tasks).toEqual([])
    expect(controller.snapshot().history).toBeNull()
    expect(receipts.mock.calls.length).toBe(receiptRequests)
  })
  it('ignores a cleanup completion after Stop', async () => {
    const cleanup = deferred<ReceiptHistory>()
    const api: Pick<DesktopBridge, 'getStatus' | 'receipts' | 'stopRuntime'> = {
      getStatus: vi.fn(async () => owned('A')),
      receipts: vi.fn(action => action === 'clear-confirmed' ? cleanup.promise : Promise.resolve(records)),
      stopRuntime: vi.fn(async () => {})
    }
    const controller = new RuntimePanelController(api, () => {})
    await controller.refresh(0)
    const clearing = controller.clearConfirmed(0)
    await controller.stop()
    cleanup.resolve(records)
    await clearing
    expect(controller.snapshot().status?.runtime.process).toBe('stopped')
    expect(controller.snapshot().status?.runtime.tasks).toEqual([])
    expect(controller.snapshot().history).toBeNull()
  })
  it('does not apply A cleanup history after a B status transition', async () => {
    const cleanup = deferred<ReceiptHistory>()
    let account = 'A'
    const api: Pick<DesktopBridge, 'getStatus' | 'receipts' | 'stopRuntime'> = {
      getStatus: async () => owned(account), receipts: action => action === 'clear-confirmed' ? cleanup.promise : Promise.resolve({ ...records, total: account === 'B' ? 2 : 1 }),
      stopRuntime: async () => {}
    }
    const controller = new RuntimePanelController(api, () => {})
    await controller.refresh(0)
    const clearing = controller.clearConfirmed(0)
    account = 'B'
    await controller.refresh(0)
    cleanup.resolve(records)
    await clearing
    expect(controller.snapshot().status?.runtime.tasks[0].taskId).toBe('task-B')
    expect(controller.snapshot().history?.total).toBe(2)
  })
})

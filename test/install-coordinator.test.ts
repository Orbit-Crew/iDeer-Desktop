import { expect, it } from 'vitest'
import { requestInstall, type InstallDeps, type DrainView } from '../src/main/installer'
import type { PendingUpdate } from '../src/main/updates'

const pending = { kind: 'patch', source: 'offline' } as PendingUpdate
function boundary(options: { status?: Partial<DrainView>; confirmed?: boolean; stopFailure?: boolean } = {}) {
  let replaced = false, stopped = false, drain = false, quit = false
  const status = (): DrainView => ({ process: stopped ? 'stopped' : 'running', activeTasks: 0, unknownWriteEffects: 0,
    installDrain: drain, ...options.status })
  const deps: InstallDeps = {
    status, confirm: async () => options.confirmed !== false, drain: async action => { drain = action === 'begin' },
    stop: async () => { if (options.stopFailure) throw new Error('RUNTIME_STOP_UNCONFIRMED'); stopped = true },
    handoff: async () => { if (!stopped) throw new Error('FILES_LOCKED'); replaced = true }, quit: async () => { quit = true }
  }
  return { deps, state: () => ({ replaced, stopped, drain, quit }) }
}
it.each(['online', 'offline'] as const)('requires explicit confirmation for %s installation', async source => {
  const b = boundary({ confirmed: false })
  expect(await requestInstall({ ...pending, source }, b.deps)).toMatchObject({ installed: false, stage: 'canceled' })
  expect(b.state()).toEqual({ replaced: false, stopped: false, drain: false, quit: false })
})
it.each([
  { unknownWriteEffects: 1 }, { receiptStorageError: 'RECEIPT_STORAGE_UNAVAILABLE' }
])('blocks unsafe task records without changing program files: %j', async status => {
  const b = boundary({ status })
  expect(await requestInstall(pending, b.deps)).toMatchObject({ installed: false, stage: 'blocked' })
  expect(b.state().replaced).toBe(false)
})
it('does not interpret a running task timeout as drained', async () => {
  const b = boundary({ status: { activeTasks: 1 } })
  expect(await requestInstall(pending, b.deps, { deadlineMs: 10 })).toMatchObject({ installed: false, stage: 'blocked' })
  expect(b.state()).toEqual({ replaced: false, stopped: false, drain: false, quit: false })
})
it('blocks replacement when a graceful process exit cannot be confirmed', async () => {
  const b = boundary({ stopFailure: true })
  expect(await requestInstall(pending, b.deps)).toMatchObject({ installed: false, stage: 'blocked' })
  expect(b.state().replaced).toBe(false)
})
it('stops Runtime before maintenance and waits for startup verification before claiming success', async () => {
  const b = boundary()
  expect(await requestInstall(pending, b.deps)).toMatchObject({ installed: false, stage: 'launched' })
  expect(b.state()).toEqual({ replaced: true, stopped: true, drain: true, quit: true })
})
it('requires a fresh valid drain status instead of trusting a drain acknowledgment alone', async () => {
  const b = boundary({ status: { process: 'unresponsive' } })
  expect(await requestInstall(pending, b.deps, { deadlineMs: 10 })).toMatchObject({ installed: false, stage: 'blocked' })
  expect(b.state().replaced).toBe(false)
})
it('waits for an admitted in-flight write to become terminal before classifying its effects as unknown', async () => {
  const status = { activeTasks: 1, unknownWriteEffects: 1 }
  const b = boundary({ status })
  const installation = requestInstall(pending, b.deps, { deadlineMs: 2000 })
  await new Promise(resolve => setTimeout(resolve, 30))
  status.activeTasks = 0; status.unknownWriteEffects = 0
  expect(await installation).toMatchObject({ stage: 'launched' })
})

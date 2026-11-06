import { describe, expect, it } from 'vitest'
import { EXIT_DRAIN_DEADLINE_MS, drainForExit, shouldExitOnClose, shouldInterceptClose,
  type ExitDrainDeps } from '../src/main/lifecycle'
import type { DrainView } from '../src/main/installer'

/** Issue 86: the exit lifecycle's pure decision layer. The window close
 * decision and the drain-before-quit coordinator are both Electron-free so
 * both exit paths are testable without spawning the app. */

const baseStatus = (overrides: Partial<DrainView> = {}): DrainView => ({
  process: 'running', installDrain: true, activeTasks: 0, unknownWriteEffects: 0, ...overrides
})

interface HarnessOptions {
  status?: Partial<DrainView>
  /** Replaces the whole status after N reads (crash / drain progression). */
  statuses?: DrainView[]
  beginFailure?: Error
}

function harness(options: HarnessOptions = {}) {
  let reads = 0
  const calls: { drain: ('begin' | 'abort')[]; sleeps: number[] } = { drain: [], sleeps: [] }
  let clock = 0
  const deps: ExitDrainDeps = {
    status: () => {
      const state = options.statuses
        ? options.statuses[Math.min(reads, options.statuses.length - 1)]
        : baseStatus(options.status)
      reads += 1
      return state
    },
    drain: async (action) => {
      if (action === 'begin' && options.beginFailure) throw options.beginFailure
      calls.drain.push(action)
    },
    sleep: async (ms) => { clock += ms; calls.sleeps.push(ms) },
    now: () => clock
  }
  return { deps, calls }
}

describe('window close decision (#86)', () => {
  it('keeps the resident default: a plain close never exits', () => {
    expect(shouldExitOnClose(true, false)).toBe(false)
  })
  it('starts the true exit when 关窗即退出 is set', () => {
    expect(shouldExitOnClose(false, false)).toBe(true)
  })
  it('never re-enters the exit for a close that belongs to the teardown or an in-flight exit', () => {
    expect(shouldExitOnClose(true, true)).toBe(false)
    expect(shouldExitOnClose(false, true)).toBe(false)
  })
})

describe('maintenance-instance close decision (#86 review)', () => {
  it('never hides the tray-less update-maintenance helper: its close takes the natural quit path', () => {
    // Natural path = the window really destroys, `window-all-closed` fires
    // and the app quits through the existing teardown — the pre-#86 behavior
    // the helper's health-accept flow relies on.
    expect(shouldInterceptClose(true, false)).toBe(false)
  })
  it('keeps intercepting closes on the normal instance unless the teardown is closing', () => {
    expect(shouldInterceptClose(false, false)).toBe(true)
    expect(shouldInterceptClose(false, true)).toBe(false)
    expect(shouldInterceptClose(true, true)).toBe(false)
  })
})

describe('drain before true exit (#86)', () => {
  it('drains in-flight tasks and reports success without aborting', async () => {
    // First read is the pre-check, second the post-begin poll: the run ends
    // between them, so the safe-stop predicate holds and nothing aborts.
    const h = harness({ statuses: [baseStatus({ activeTasks: 1 }), baseStatus()] })
    expect(await drainForExit(h.deps)).toBe('drained')
    expect(h.calls.drain).toEqual(['begin'])
  })

  it('treats a drain deadline as never-drained, aborts and reports honestly', async () => {
    const h = harness({ status: { activeTasks: 1 } })
    expect(await drainForExit(h.deps, { deadlineMs: 10, pollMs: 5 })).toBe('timeout')
    expect(h.calls.drain).toEqual(['begin', 'abort'])
  })

  it('aborts and reports blocked when write effects stay unknown', async () => {
    const h = harness({ status: { unknownWriteEffects: 3 } })
    expect(await drainForExit(h.deps, { deadlineMs: 10, pollMs: 5 })).toBe('blocked')
    expect(h.calls.drain).toEqual(['begin', 'abort'])
  })

  it('aborts and reports blocked when durable receipt saving fails', async () => {
    const h = harness({ status: { receiptStorageError: 'RECEIPT_STORAGE_UNAVAILABLE' } })
    expect(await drainForExit(h.deps, { deadlineMs: 10, pollMs: 5 })).toBe('blocked')
    expect(h.calls.drain).toEqual(['begin', 'abort'])
  })

  it('skips the drain entirely when the Runtime is not running', async () => {
    const h = harness({ status: baseStatus({ process: 'stopped' }) })
    expect(await drainForExit(h.deps)).toBe('drained')
    expect(h.calls.drain).toEqual([])
  })

  it('reports an unusable Runtime when the drain cannot even begin', async () => {
    const h = harness({ beginFailure: new Error('RUNTIME_UNAVAILABLE') })
    expect(await drainForExit(h.deps)).toBe('unavailable')
    expect(h.calls.drain).toEqual([])
  })

  it('stops waiting when the Runtime process dies mid-drain', async () => {
    const h = harness({ statuses: [baseStatus({ activeTasks: 2 }), baseStatus({ process: 'crashed', activeTasks: 2 })] })
    expect(await drainForExit(h.deps, { deadlineMs: 60000, pollMs: 5 })).toBe('unavailable')
    expect(h.calls.drain).toEqual(['begin'])
  })

  it('bounds the wait like the installer drain by default', () => {
    expect(EXIT_DRAIN_DEADLINE_MS).toBe(90000)
  })
})

// Issue 110: the human terminal's desktop-local PTY session manager (decision
// #59: real PTY semantics, desktop-local process in Electron main, no Runtime,
// no approvals, no per-step audit). These pin the session lifecycle, the
// project-bound start dir with its user-home fallback, the bounded
// write/resize/kill surface, and the negative audit invariant: a full human
// terminal lifecycle produces no receipts and no approvals.
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { TerminalSessions, terminalShell } from '../src/main/terminal'
import { MAX_TERMINAL_SESSIONS, MAX_TERMINAL_WRITE } from '../src/shared/desktop'

class FakePty {
  pid = 4242
  cols = 80
  rows = 24
  process = 'fake-shell'
  handleFlowControl = false
  written: string[] = []
  resized: [number, number][] = []
  killed = false
  private dataListeners: ((e: string) => unknown)[] = []
  private exitListeners: ((e: { exitCode: number }) => unknown)[] = []
  onData = (listener: (e: string) => unknown): { dispose(): void } => {
    this.dataListeners.push(listener)
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== listener) } }
  }
  onExit = (listener: (e: { exitCode: number }) => unknown): { dispose(): void } => {
    this.exitListeners.push(listener)
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== listener) } }
  }
  write = (data: string | Buffer): void => { this.written.push(String(data)) }
  resize = (columns: number, rows: number): void => { this.cols = columns; this.rows = rows; this.resized.push([columns, rows]) }
  clear = (): void => {}
  kill = (): void => { this.killed = true }
  pause = (): void => {}
  resume = (): void => {}
  emitData(data: string): void { for (const listener of [...this.dataListeners]) listener(data) }
  emitExit(exitCode: number): void { for (const listener of [...this.exitListeners]) listener({ exitCode }) }
}

interface RuntimeSeam {
  files: ReturnType<typeof vi.fn>
  receipts: ReturnType<typeof vi.fn>
}

interface Harness {
  ptys: FakePty[]
  spawns: { cwd: string; cols: number; rows: number }[]
  events: { data: { sessionId: string; data: string }[]; exit: { sessionId: string; exitCode: number }[] }
  runtime: RuntimeSeam
  manager: TerminalSessions
  lastPty: () => FakePty
}

// The Runtime stub mirrors the device's audit surfaces (issue 94's guarded
// file locate plus the receipt ledger). The human terminal may consult the
// workspace binding for its convenience start dir and nothing else.
function harness(startDir: string | null, failStartDir = false): Harness {
  const ptys: FakePty[] = []
  const spawns: { cwd: string; cols: number; rows: number }[] = []
  const events = { data: [] as { sessionId: string; data: string }[], exit: [] as { sessionId: string; exitCode: number }[] }
  const runtime: RuntimeSeam = {
    files: vi.fn(async (action: string, path: string) => {
      if (action !== 'locate' || typeof path !== 'string') throw new Error('FILES_ACTION_INVALID')
      if (failStartDir) throw new Error('WORKSPACE_UNAVAILABLE')
      return { physical: startDir }
    }),
    receipts: vi.fn()
  }
  const manager = new TerminalSessions(
    {
      onData: (event) => events.data.push(event),
      onExit: (event) => events.exit.push(event)
    },
    async () => {
      const located = (await runtime.files('locate', '/')) as { physical: string }
      if (typeof located.physical !== 'string' || !located.physical) throw new Error('TERMINAL_START_DIR_UNAVAILABLE')
      return located.physical
    },
    (options) => {
      spawns.push({ cwd: options.cwd, cols: options.cols, rows: options.rows })
      const pty = new FakePty()
      ptys.push(pty)
      return pty as unknown as IPty
    }
  )
  return {
    ptys, spawns, events, runtime, manager,
    lastPty: () => ptys[ptys.length - 1]
  }
}

describe('terminal session lifecycle (issue 110)', () => {
  let h: Harness
  beforeEach(() => { h = harness('D:\\project-bound-folder') })

  it('spawns a desktop-local PTY in the project-bound start dir with real PTY defaults', async () => {
    const view = await h.manager.spawn(7)
    expect(view.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(h.spawns).toEqual([{ cwd: 'D:\\project-bound-folder', cols: 80, rows: 24 }])
    expect(h.manager.size()).toBe(1)
  })

  it('never hands the renderer a start dir: spawn returns the session id only', async () => {
    // Issue 94's invariant holds across this ticket: a physical path never
    // reaches the renderer, even the workspace's own bound folder.
    const view = await h.manager.spawn(7)
    expect(Object.keys(view).sort()).toEqual(['sessionId'])
  })

  it('falls back to the user home without a bound project and never supplies a cwd from the renderer', async () => {
    // spawn() takes no path argument at all: the start dir is resolved in the
    // trusted main process only.
    expect(h.manager.spawn.length).toBe(1)
    const fallback = harness(null, true)
    await fallback.manager.spawn(1)
    expect(fallback.spawns[0].cwd).toBe(homedir())
  })

  it('treats an unusable start dir answer as no binding and uses the user home', async () => {
    const broken = harness('')
    await broken.manager.spawn(1)
    expect(broken.spawns[0].cwd).toBe(homedir())
  })

  it('routes pty output and exit facts to the session sinks', async () => {
    const view = await h.manager.spawn(7)
    h.lastPty().emitData('hello\r\n')
    expect(h.events.data).toEqual([{ sessionId: view.sessionId, data: 'hello\r\n' }])
    h.lastPty().emitExit(0)
    expect(h.events.exit).toEqual([{ sessionId: view.sessionId, exitCode: 0 }])
    // The exited session is gone: a new spawn is allowed and nothing lingers.
    expect(h.manager.size()).toBe(0)
    const next = await h.manager.spawn(7)
    expect(next.sessionId).not.toBe(view.sessionId)
  })

  it('delivers exactly one exit fact to the sink when the manager itself killed the session', async () => {
    // Ordering pin: kill() removes the session before the pty's own exit
    // event lands; the renderer must still learn that the program ended
    // (decision #59: real PTY semantics — kill is observable).
    const view = await h.manager.spawn(7)
    h.lastPty().emitData('tail before kill\r\n')
    h.manager.kill(7, view.sessionId)
    h.lastPty().emitExit(1)
    h.lastPty().emitExit(1) // defensive: node-pty exits once; a double emit stays single-delivery
    expect(h.events.exit).toEqual([{ sessionId: view.sessionId, exitCode: 1 }])
    // Late output after the exit fact is not forwarded either.
    h.lastPty().emitData('late tail')
    expect(h.events.data).toEqual([{ sessionId: view.sessionId, data: 'tail before kill\r\n' }])
    expect(h.manager.size()).toBe(0)
  })

  it('stops forwarding output once the session exited', async () => {
    await h.manager.spawn(7)
    h.lastPty().emitExit(0)
    h.lastPty().emitData('late tail')
    expect(h.events.data).toEqual([])
  })

  it('writes keystrokes into the owning session only', async () => {
    const view = await h.manager.spawn(7)
    h.manager.write(7, view.sessionId, 'dir\r')
    expect(h.lastPty().written).toEqual(['dir\r'])
    // A different sender may not drive someone else's session; an unknown
    // session id is a silent no-op so a close/exit race never throws.
    h.manager.write(99, view.sessionId, 'evil\r')
    h.manager.write(7, '00000000-0000-4004-8000-000000000000', 'ghost\r')
    expect(h.lastPty().written).toEqual(['dir\r'])
  })

  it('rejects malformed writes before they reach the pty', async () => {
    const view = await h.manager.spawn(7)
    for (const bad of ['', 'x'.repeat(MAX_TERMINAL_WRITE + 1), 42, null]) {
      expect(() => h.manager.write(7, view.sessionId, bad)).toThrow('TERMINAL_WRITE_INVALID')
    }
    expect(h.lastPty().written).toEqual([])
    expect(() => h.manager.write(7, view.sessionId, 'ok')).not.toThrow()
  })

  it('resizes the pty within bounded dimensions', async () => {
    const view = await h.manager.spawn(7)
    h.manager.resize(7, view.sessionId, 120, 40)
    expect(h.lastPty().resized).toEqual([[120, 40]])
    for (const [cols, rows] of [[0, 24], [1001, 24], [80, 1], [80, 1002], [80.5, 24], [NaN, 24]]) {
      expect(() => h.manager.resize(7, view.sessionId, cols, rows)).toThrow('TERMINAL_SIZE_INVALID')
    }
    expect(h.lastPty().resized).toEqual([[120, 40]])
  })

  it('kills the owning session and ignores foreign or unknown kill targets', async () => {
    const view = await h.manager.spawn(7)
    h.manager.kill(99, view.sessionId)
    expect(h.lastPty().killed).toBe(false)
    expect(h.manager.size()).toBe(1)
    h.manager.kill(7, view.sessionId)
    expect(h.lastPty().killed).toBe(true)
    expect(h.manager.size()).toBe(0)
    expect(() => h.manager.kill(7, view.sessionId)).not.toThrow()
  })

  it('kills every remaining session on killAll (window destroyed, renderer crash, quit)', async () => {
    await h.manager.spawn(1)
    await h.manager.spawn(2)
    h.manager.killAll()
    expect(h.ptys.every((p) => p.killed)).toBe(true)
    expect(h.manager.size()).toBe(0)
    expect(() => h.manager.killAll()).not.toThrow()
  })

  it('bounds the number of concurrent human terminal sessions', async () => {
    for (let index = 0; index < MAX_TERMINAL_SESSIONS; index += 1) await h.manager.spawn(index)
    await expect(h.manager.spawn(99)).rejects.toThrow('TERMINAL_LIMIT')
    expect(h.manager.size()).toBe(MAX_TERMINAL_SESSIONS)
  })

  it('picks the platform shell without any renderer-supplied command', () => {
    const shell = terminalShell()
    expect(typeof shell).toBe('string')
    expect(shell.length).toBeGreaterThan(0)
    if (process.platform === 'win32') {
      expect(shell === process.env.COMSPEC || shell === 'cmd.exe').toBe(true)
    }
  })
})

// Decision #59.5: 人工终端不逐条审计、不产生审批卡. The negative fact is
// pinned twice — behaviorally over a full lifecycle against a Runtime stub
// that exposes the receipt ledger, and structurally over the module source.
describe('human terminal negative audit invariant', () => {
  it('runs a full lifecycle without ever touching the receipt ledger', async () => {
    const h = harness('D:\\project-bound-folder')
    h.runtime.receipts.mockName = 'runtime.receipts'
    const view = await h.manager.spawn(3)
    h.manager.write(3, view.sessionId, 'echo human-input\r')
    h.manager.resize(3, view.sessionId, 100, 30)
    h.lastPty().emitData('some output\r\n')
    h.lastPty().emitExit(0)
    h.manager.kill(3, view.sessionId)
    expect(h.runtime.receipts).not.toHaveBeenCalled()
    // The only Runtime interaction is the read-only binding lookup for the
    // convenience start dir: one locate, no consent, no grant, no receipt.
    expect(h.runtime.files).toHaveBeenCalledTimes(1)
    expect(h.runtime.files).toHaveBeenCalledWith('locate', '/')
  })

  it('keeps working with no runtime at all (start dir falls back to the user home)', async () => {
    const manager = new TerminalSessions(
      { onData: () => {}, onExit: () => {} },
      async () => { throw new Error('RUNTIME_UNAVAILABLE') },
      () => new FakePty() as unknown as IPty
    )
    await manager.spawn(1)
    // cwd fact asserted via the factory above would need the harness; the
    // homedir fallback is covered in the lifecycle block — here we pin that a
    // dead Runtime never blocks a human terminal from starting.
    expect(manager.size()).toBe(1)
  })

  it('keeps the terminal module structurally free of audit and approval surfaces', () => {
    const source = readFileSync('src/main/terminal.ts', 'utf8')
    // No Runtime, ledger or notification import reaches the session manager:
    // its only inputs are the event sinks, the start-dir resolver and a pty
    // factory, so it cannot produce receipts or approval cards by construction.
    expect(source).not.toMatch(/from '\.\/(runtime|notifications)'/)
    expect(source).not.toMatch(/\.receipts|desktop:receipts|desktop:chat|recordApproval|consent/i)
  })

  it('pins the exit-path cleanup so a restart always opens fresh sessions', () => {
    // Sessions live in main memory only; every exit path (quit, window
    // destroyed) must kill them, and nothing persists a session id.
    const wiring = readFileSync('src/main/index.ts', 'utf8')
    expect(wiring).toMatch(/before-quit'/)
    expect(wiring).toMatch(/terminalSessions\?\.killAll\(\)/)
    expect(wiring).toMatch(/destroyed', \(\) => terminalSessions\?\.killAll\(\)/)
    const persistence = readFileSync('src/renderer/src/dock/persistence.ts', 'utf8')
    expect(persistence).toContain('delete clone.instances[key].sessionId')
  })
})

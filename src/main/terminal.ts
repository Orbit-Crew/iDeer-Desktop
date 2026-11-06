// Issue 110: the human terminal's desktop-local PTY sessions (decision #59:
// the human terminal is the Desktop's own process — Electron main, real PTY
// semantics via node-pty/ConPTY, never the Runtime). This module stays free of
// Electron imports so the session contract is testable like the other main
// modules; index.ts wires the ipcMain seam and the main-frame sender fence.
//
// The surface is exactly the decision's minimal bridge: spawn/write/resize/
// kill plus the data/exit event facts. There is no filesystem or shell-wrapper
// capability here, nothing renderer-supplied can pick a command, cwd or env,
// and nothing in this module touches receipts, approvals or notifications:
// a human driving their own terminal is free (no per-step audit).
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { MAX_TERMINAL_SESSIONS, MAX_TERMINAL_WRITE, type TerminalDataEvent, type TerminalExitEvent } from '../shared/desktop'

export type { TerminalDataEvent, TerminalExitEvent }

export interface TerminalSpawnView { sessionId: string }

export interface TerminalSessionSinks {
  onData(event: TerminalDataEvent): void
  onExit(event: TerminalExitEvent): void
}

/** The fixed platform shell; never renderer-supplied (reference: linz behavior). */
export function terminalShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  if (process.platform === 'darwin') return process.env.SHELL || 'zsh'
  return process.env.SHELL || 'bash'
}

export type TerminalPtyFactory = (options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => IPty

const defaultPtyFactory: TerminalPtyFactory = (options) => ptySpawn(terminalShell(), [], {
  name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env
})

interface TerminalSession {
  pty: IPty
  owner: number
  exitDelivered: boolean
}

const MIN_COLS = 2, MAX_COLS = 1000, MIN_ROWS = 2, MAX_ROWS = 1000

export class TerminalSessions {
  private sessions = new Map<string, TerminalSession>()

  constructor(private readonly sinks: TerminalSessionSinks,
    private readonly resolveStartDir: () => Promise<string>,
    private readonly createPty: TerminalPtyFactory = defaultPtyFactory) {}

  size(): number { return this.sessions.size }

  /**
   * Spawns one human terminal PTY. The start dir is resolved here in the
   * trusted process from the existing workspace state (the platform Project's
   * bound folder via the Runtime's guarded locate, decision #59.2); any
   * failure — no login, no ready workspace, Runtime down — falls back to the
   * user home. Pure convenience, never a boundary: the shell itself is not
   * confined by it. The answer goes nowhere but into the pty: the renderer
   * receives the session id only, never a physical path (issue 94's
   * "renderer never receives a physical path" invariant holds).
   */
  async spawn(owner: number): Promise<TerminalSpawnView> {
    if (this.sessions.size >= MAX_TERMINAL_SESSIONS) throw new Error('TERMINAL_LIMIT')
    const cwd = await this.startDir()
    const pty = this.createPty({ cwd, cols: 80, rows: 24, env: { ...process.env } })
    const sessionId = randomUUID()
    const session: TerminalSession = { pty, owner, exitDelivered: false }
    this.sessions.set(sessionId, session)
    pty.onData((data) => {
      if (!this.sessions.has(sessionId)) return
      try { this.sinks.onData({ sessionId, data }) } catch { /* window gone; killAll owns cleanup */ }
    })
    // The exit fact always reaches the sink exactly once — including after a
    // manager-initiated kill(), which removes the session before the pty's
    // own exit event lands (a human closing the pane still gets the exit
    // notice; a natural exit just also cleans the map entry here).
    pty.onExit(({ exitCode }) => {
      if (session.exitDelivered) return
      session.exitDelivered = true
      this.sessions.delete(sessionId)
      try { this.sinks.onExit({ sessionId, exitCode }) } catch { /* window gone */ }
    })
    return { sessionId }
  }

  write(owner: number, sessionId: string, data: unknown): void {
    if (typeof data !== 'string' || data.length < 1 || data.length > MAX_TERMINAL_WRITE) throw new Error('TERMINAL_WRITE_INVALID')
    const session = this.owned(owner, sessionId)
    if (session) session.pty.write(data)
  }

  resize(owner: number, sessionId: string, cols: unknown, rows: unknown): void {
    if (typeof cols !== 'number' || !Number.isSafeInteger(cols) || cols < MIN_COLS || cols > MAX_COLS ||
        typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) throw new Error('TERMINAL_SIZE_INVALID')
    const session = this.owned(owner, sessionId)
    if (session) session.pty.resize(cols, rows)
  }

  /** Idempotent by design: an exit race or a repeated close never throws. */
  kill(owner: number, sessionId: string): void {
    const session = this.owned(owner, sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    try { session.pty.kill() } catch { /* already gone */ }
  }

  /** App shutdown, window destruction and renderer-crash cleanup. */
  killAll(): void {
    for (const [sessionId, session] of [...this.sessions]) {
      this.sessions.delete(sessionId)
      try { session.pty.kill() } catch { /* already gone */ }
    }
  }

  private owned(owner: number, sessionId: string): TerminalSession | null {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const session = this.sessions.get(sessionId)
    // Silence on a foreign or unknown session: no cross-session control, and
    // a close/exit race stays a no-op instead of an error surface.
    if (!session || session.owner !== owner) return null
    return session
  }

  private async startDir(): Promise<string> {
    try {
      const dir = await this.resolveStartDir()
      if (typeof dir === 'string' && dir) return dir
    } catch { /* no binding available */ }
    return homedir()
  }
}

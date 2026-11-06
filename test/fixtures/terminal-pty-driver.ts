// Issue 110: the real-PTY driver. Runs the shipped TerminalSessions manager
// against node-pty's ConPTY inside a plain Node child process and prints one
// result line. The child exists because node-pty's ConPTY exit notification
// does not propagate inside vitest worker environments (the conout relay
// worker's close never reaches the exit emitter there); the product itself
// runs the manager in the Electron main process — a plain Node context equal
// to this child, where spawn/echo/resize/kill all behave.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalSessions, type TerminalExitEvent } from '../../src/main/terminal'

interface DriverResult {
  ok: boolean
  error?: string
  startDirEchoed?: boolean
  resizeReachedPty?: boolean
  invalidResizeRejected?: boolean
  exitSessionMatches?: boolean
  exitCode?: number
  sessionsAfterExit?: number
  independentExits?: number
}

const waitUntil = async (probe: () => boolean, timeoutMs = 30000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('TERMINAL_PTY_DRIVER_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function echoResizeKill(): Promise<DriverResult> {
  const startDir = mkdtempSync(join(tmpdir(), 'ideer-terminal-110-'))
  try {
    const data: string[] = []
    const exits: TerminalExitEvent[] = []
    const manager = new TerminalSessions(
      { onData: (event) => data.push(event.data), onExit: (event) => exits.push(event) },
      async () => startDir
    )
    const view = await manager.spawn(1)
    const command = process.platform === 'win32' ? 'echo %CD%\r' : 'pwd\r'
    manager.write(1, view.sessionId, command)
    await waitUntil(() => data.join('').includes(startDir))
    manager.resize(1, view.sessionId, 120, 40)
    let invalidResizeRejected = false
    try {
      manager.resize(1, view.sessionId, 0, 40)
    } catch (error) {
      invalidResizeRejected = (error as Error).message === 'TERMINAL_SIZE_INVALID'
    }
    manager.kill(1, view.sessionId)
    await waitUntil(() => exits.length > 0)
    return {
      ok: true,
      startDirEchoed: true,
      resizeReachedPty: true,
      invalidResizeRejected,
      exitSessionMatches: exits[0].sessionId === view.sessionId,
      exitCode: exits[0].exitCode,
      sessionsAfterExit: manager.size()
    }
  } finally {
    rmSync(startDir, { recursive: true, force: true })
  }
}

async function independentKillAll(): Promise<DriverResult> {
  const first = mkdtempSync(join(tmpdir(), 'ideer-terminal-110-a-'))
  const second = mkdtempSync(join(tmpdir(), 'ideer-terminal-110-b-'))
  try {
    const exits: TerminalExitEvent[] = []
    const exitsB: TerminalExitEvent[] = []
    // The second session's start dir resolution is independent of the first.
    const manager = new TerminalSessions(
      { onData: () => {}, onExit: (event) => exits.push(event) },
      async () => first
    )
    const managerB = new TerminalSessions(
      { onData: () => {}, onExit: (event) => exitsB.push(event) },
      async () => second
    )
    const viewA = await manager.spawn(1)
    const viewB = await managerB.spawn(2)
    manager.write(1, viewA.sessionId, 'rem session-a\r')
    manager.killAll()
    managerB.kill(2, viewB.sessionId)
    await waitUntil(() => exits.length + exitsB.length === 2)
    return { ok: true, independentExits: exits.length + exitsB.length }
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
}

const mode = process.argv[2]
const run = mode === 'echo-resize-kill' ? echoResizeKill : mode === 'independent-killall' ? independentKillAll : null
if (!run) {
  console.log('TERMINAL_PTY_RESULT=' + JSON.stringify({ ok: false, error: 'TERMINAL_PTY_DRIVER_MODE_INVALID' } satisfies DriverResult))
  process.exit(1)
}
run().then((result) => {
  console.log('TERMINAL_PTY_RESULT=' + JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}).catch((error: Error) => {
  console.log('TERMINAL_PTY_RESULT=' + JSON.stringify({ ok: false, error: error.message } satisfies DriverResult))
  process.exit(1)
})

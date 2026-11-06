// @vitest-environment node
// Issue 110: real PTY semantics through the shipped dependency (node-pty
// ConPTY on Windows), exercised through the production TerminalSessions
// factory. The assertions run in a plain Node child process
// (test/fixtures/terminal-pty-driver.ts, esbuild-bundled at test time):
// node-pty's ConPTY exit notification does not propagate inside vitest worker
// environments, while the product itself runs the manager in the Electron
// main process — the same plain Node context the child provides. Skips only
// where the native module cannot load in the current ABI.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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

const require = createRequire(import.meta.url)
let ptyAvailable = true
try { require('node-pty') } catch { ptyAvailable = false }

// The bundle lives inside the checkout's .cache (gitignored, per local-disk
// policy) so the external require('node-pty') resolves from node_modules.
const bundleDir = resolve('.cache/issue-110-terminal-pty')
const bundleFile = join(bundleDir, 'terminal-pty-driver.cjs')

let bundled = false
function ensureBundle(): void {
  if (bundled) return
  const esbuild = require('esbuild') as typeof import('esbuild')
  mkdirSync(bundleDir, { recursive: true })
  esbuild.buildSync({
    entryPoints: [resolve('test/fixtures/terminal-pty-driver.ts')],
    bundle: true,
    packages: 'external',
    platform: 'node',
    outfile: bundleFile,
    logLevel: 'silent'
  })
  bundled = true
}

function runDriver(mode: string): DriverResult {
  ensureBundle()
  const stdout = execFileSync(process.execPath, [bundleFile, mode], { encoding: 'utf8', windowsHide: true })
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('TERMINAL_PTY_RESULT='))
  if (!line) throw new Error('TERMINAL_PTY_DRIVER_NO_RESULT: ' + stdout.slice(-400))
  return JSON.parse(line.slice('TERMINAL_PTY_RESULT='.length)) as DriverResult
}

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true })
  bundled = false
})

describe.skipIf(!ptyAvailable)('human terminal over a real PTY (issue 110)', () => {
  it('starts the shell in the resolved start dir, echoes input, resizes and dies on kill', () => {
    const result = runDriver('echo-resize-kill')
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    expect(result.startDirEchoed).toBe(true)
    expect(result.resizeReachedPty).toBe(true)
    expect(result.invalidResizeRejected).toBe(true)
    expect(result.exitSessionMatches).toBe(true)
    expect(typeof result.exitCode).toBe('number')
    expect(result.sessionsAfterExit).toBe(0)
  }, 90000)

  it('keeps two sessions independent and ends both on killAll', () => {
    const result = runDriver('independent-killall')
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    expect(result.independentExits).toBe(2)
  }, 90000)
})

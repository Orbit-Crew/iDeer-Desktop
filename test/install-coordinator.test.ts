import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPatch, planDrain, requestInstall } from '../src/main/installer'
import type { DrainView, InstallDeps } from '../src/main/installer'
import type { PendingUpdate } from '../src/main/updates'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), 'ideer-install-')); dirs.push(d); return d }

function pending(kind: 'patch' | 'full' = 'patch'): PendingUpdate {
  return { kind, source: 'offline', verifiedAt: '2026-10-24T00:00:00.000Z', advice: '',
    manifest: { version: 1, kind, publishedAt: '2026-10-24T00:00:00.000Z',
      desktop: { version: '0.2.0', asarSHA256: 'a'.repeat(64) },
      runtime: { python: '3.12.10', lockSHA256: 'b'.repeat(64) },
      serverCompatibility: { minProtocol: 1, notes: '' },
      baseline: { desktopVersion: '0.1.0', runtimePython: '3.12.10' },
      deletions: ['resources/runtime/old.py'],
      files: [{ path: 'resources/runtime/core/new.py', sha256: '', bytes: 0 }] } }
}

function deps(overrides: Partial<InstallDeps> & { status?: () => DrainView } = {}): { deps: InstallDeps; calls: string[] } {
  const calls: string[] = []
  return { calls, deps: {
    status: overrides.status ?? (() => ({ installDrain: true, activeTasks: 0 })),
    drain: async (action) => { calls.push('drain-' + action) },
    confirm: overrides.confirm ?? (async () => { calls.push('confirm'); return true }),
    apply: overrides.apply ?? (async () => { calls.push('apply') }),
    launch: overrides.launch ?? (async () => { calls.push('launch') }),
    quit: overrides.quit ?? (async () => { calls.push('quit') })
  } }
}

describe('drain-and-install coordinator (issue 108)', () => {
  it('refuses to start without an explicit confirmation and drains only after one', async () => {
    const declined = deps({ confirm: async () => false })
    const outcome = await requestInstall(pending(), declined.deps, { deadlineMs: 500 })
    expect(outcome).toMatchObject({ installed: false, stage: 'canceled' })
    expect(declined.calls).toEqual([])

    const accepted = deps()
    const ok = await requestInstall(pending(), accepted.deps,
      { deadlineMs: 500, payloadRoot: fresh(), programRoot: fresh() })
    expect(ok.installed).toBe(true)
    // The settled stop happens after the patch is staged; drain-abort is never called.
    expect(accepted.calls).toEqual(['confirm', 'drain-begin', 'apply', 'quit'])
  })
  it('never treats a drain timeout as an empty queue and aborts instead', async () => {
    const { deps: d, calls } = deps({ status: () => ({ installDrain: true, activeTasks: 2 }) })
    const outcome = await requestInstall(pending(), d, { deadlineMs: 700 })
    expect(outcome).toMatchObject({ installed: false, stage: 'blocked' })
    expect(outcome.detail).toContain('did not reach a terminal state')
    expect(calls).toEqual(['confirm', 'drain-begin', 'drain-abort'])
    expect(calls).not.toContain('apply')
  })
  it('blocks on unreliable local records and keeps unconfirmed receipts intact', async () => {
    const { deps: d, calls } = deps({ status: () => ({ installDrain: true, activeTasks: 0, receiptStorageError: 'RECEIPT_STORAGE_UNAVAILABLE' }) })
    const outcome = await requestInstall(pending(), d, { deadlineMs: 500 })
    expect(outcome).toMatchObject({ installed: false, stage: 'blocked' })
    expect(outcome.detail).toContain('could not be saved durably')
    expect(calls).toEqual(['confirm', 'drain-begin', 'drain-abort'])
  })
  it('launches the full installer path only for kind=full and quits after staging', async () => {
    const full = deps()
    const outcome = await requestInstall(pending('full'), full.deps, { installerPath: 'C:/stage/setup.exe', deadlineMs: 500 })
    expect(outcome).toMatchObject({ installed: true, stage: 'launched' })
    expect(full.calls).toEqual(['confirm', 'drain-begin', 'launch', 'quit'])

    const patchWithoutRoots = deps()
    await expect(requestInstall(pending('patch'), patchWithoutRoots.deps, { deadlineMs: 500 }))
      .resolves.toMatchObject({ installed: false, stage: 'failed' })
  })
  it('drain readiness requires empty queue and durable storage', () => {
    expect(planDrain({ installDrain: true, activeTasks: 0 })).toBe('ready')
    expect(planDrain({ installDrain: true, activeTasks: 1 })).toBe('draining')
    expect(planDrain({ installDrain: true, activeTasks: 0, receiptStorageError: 'RECEIPT_STORAGE_UNAVAILABLE' })).toBe('blocked')
  })
  it('applies a verified patch payload with hash checks and bounded deletions', async () => {
    const payload = fresh(), program = fresh()
    const content = 'T108-PATCH-BYTES'
    mkdirSync(join(payload, 'resources', 'runtime', 'core'), { recursive: true })
    const digest = createHash('sha256').update(content).digest('hex')
    const manifest = pending('patch')
    manifest.manifest.files = [{ path: 'resources/runtime/core/new.py', sha256: digest, bytes: Buffer.byteLength(content) }]
    manifest.manifest.deletions = []
    writeFileSync(join(payload, 'resources', 'runtime', 'core', 'new.py'), content)
    await applyPatch(manifest, payload, program)
    expect(readFileSync(join(program, 'resources', 'runtime', 'core', 'new.py'), 'utf8')).toBe(content)

    // A tampered payload is refused before any copy.
    const tampered = fresh()
    mkdirSync(join(tampered, 'resources', 'runtime', 'core'), { recursive: true })
    writeFileSync(join(tampered, 'resources', 'runtime', 'core', 'new.py'), 'U108-PATCH-BYTES')
    await expect(applyPatch(manifest, tampered, fresh())).rejects.toThrow('UPDATE_PAYLOAD_HASH_MISMATCH')

    // A deletion outside the program directory is refused by construction.
    const escape = pending('patch')
    escape.manifest.files = []
    escape.manifest.deletions = ['../outside/keep.txt']
    await expect(applyPatch(escape, payload, program)).rejects.toThrow('UPDATE_TARGET_OUTSIDE_PROGRAM_DIRECTORY')
  })
})

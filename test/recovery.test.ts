import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { UpdateService } from '../src/main/update-stage'
import { prepareTransaction, runMaintenance, type MaintenanceHost } from '../src/main/maintenance'
import { readRecoveryState, readDataFormat } from '../src/main/recovery'
import type { UpdateManifest } from '../src/main/updates'

const roots: string[] = []
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'ideer transaction ')); roots.push(d); return d }
afterEach(() => { roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const current = { desktopVersion: '0.1.0', electronVersion: '22.3.27', runtimePython: '3.12.10', protocolVersion: 1, dataFormat: 1, readableFormats: [1] }
async function scenario(kind: 'patch' | 'full' = 'patch') {
  const program = fresh(), profile = fresh(), release = fresh()
  const keys = generateKeyPairSync('ed25519')
  const key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  for (const root of [program, join(release, 'files')]) mkdirSync(join(root, 'resources/runtime/core'), { recursive: true })
  writeFileSync(join(program, 'resources/app.asar'), 'OLD-APP')
  writeFileSync(join(program, 'resources/runtime/distribution.lock.json'), 'OLD-LOCK')
  writeFileSync(join(program, 'resources/runtime/core/service.py'), 'OLD-SERVICE')
  writeFileSync(join(program, 'ideer-desktop.exe'), 'OLD-EXE')
  writeFileSync(join(profile, 'credentials.json'), 'CURRENT-REVOKED-AUTH')
  writeFileSync(join(profile, 'receipts.db'), 'UNCONFIRMED-RECEIPT')
  const manifest: UpdateManifest = { version: 1, kind: 'patch', publishedAt: '2026-10-25T00:00:00Z',
    desktop: { version: '0.2.0', electron: '22.3.27', asarSHA256: hash('NEW-APP') },
    runtime: { python: '3.12.10', lockSHA256: hash('OLD-LOCK') }, baseline: { desktopVersion: '0.1.0', electronVersion: '22.3.27', runtimePython: '3.12.10', dataFormat: 1 },
    dataCompatibility: { targetFormat: 1, readableFormats: [1] }, serverCompatibility: { minProtocol: 1, notes: '' }, deletions: [],
    files: [{ path: 'resources/app.asar', sha256: hash('NEW-APP'), bytes: 7 }, { path: 'resources/runtime/core/service.py', sha256: hash('NEW-SERVICE'), bytes: 11 }] }
  if (kind === 'full') {
    manifest.kind = 'full'; manifest.files = []
    manifest.installer = { path: 'installer.exe', sha256: hash('SIGNED-INSTALLER'), bytes: 16 }
    writeFileSync(join(release, 'installer.exe'), 'SIGNED-INSTALLER')
  }
  const text = JSON.stringify(manifest)
  writeFileSync(join(release, 'manifest.json'), text)
  writeFileSync(join(release, 'manifest.sig'), sign(null, Buffer.from(text), keys.privateKey).toString('hex'))
  writeFileSync(join(release, 'files/resources/app.asar'), 'NEW-APP')
  writeFileSync(join(release, 'files/resources/runtime/core/service.py'), 'NEW-SERVICE')
  const service = new UpdateService({ directory: join(profile, 'Updates'), publicKeyPem: key, current: () => current })
  expect(await service.import(join(release, 'manifest.json'))).toEqual({ ok: true, error: '', pending: expect.any(Object) })
  const transaction = prepareTransaction({ stage: service.validateStaged(), programRoot: program, userData: profile,
    executable: join(program, 'ideer-desktop.exe'), current, publicKeyPem: key, parentPid: 0 })
  const host: MaintenanceHost = { waitStopped: async () => {}, install: async () => {},
    launchAndVerify: async () => {}, stopLaunched: async () => {} }
  return { transaction, program, profile, host }
}

it('restores the entire previous combination after a partial copy failure without replacing current user records', async () => {
  const s = await scenario()
  // A real destination obstruction causes the second copy to fail after app.asar changed.
  rmSync(join(s.program, 'resources/runtime/core/service.py'))
  mkdirSync(join(s.program, 'resources/runtime/core/service.py'))
  const result = await runMaintenance(s.transaction, s.host)
  expect(result.state).toBe('rolled-back')
  expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('OLD-APP')
  expect(readFileSync(join(s.program, 'resources/runtime/core/service.py'), 'utf8')).toBe('OLD-SERVICE')
  expect(readFileSync(join(s.profile, 'credentials.json'), 'utf8')).toBe('CURRENT-REVOKED-AUTH')
  expect(readFileSync(join(s.profile, 'receipts.db'), 'utf8')).toBe('UNCONFIRMED-RECEIPT')
  expect(readRecoveryState(s.profile)?.stamp).toBe(result.stamp)
})


it('locks manual repair when the running candidate changed data into a format the old program cannot read', async () => {
  const s = await scenario()
  s.host.launchAndVerify = async (_transaction, rollback) => {
    if (!rollback) { writeFileSync(join(s.profile, 'data-format.json'), '{"format":2}'); throw new Error('APPLICATION_START_FAILED') }
    throw new Error('OLD_PROGRAM_MUST_NOT_START')
  }
  const result = await runMaintenance(s.transaction, s.host)
  expect(result.state).toBe('recovery-failed')
  expect(result.detail).toContain('RECOVERY_DATA_FORMAT_UNREADABLE')
  expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('NEW-APP')
  expect(readDataFormat(s.profile)).toBe(2)
  expect(readFileSync(join(s.profile, 'receipts.db'), 'utf8')).toBe('UNCONFIRMED-RECEIPT')
})
it('stops an unhealthy recovery process and never retries a failed recovery on another launch', async () => {
  const s = await scenario()
  let running = false, starts = 0
  s.host.launchAndVerify = async () => { running = true; starts++; throw new Error('STARTUP_UNHEALTHY') }
  s.host.stopLaunched = async () => { running = false }
  const failed = await runMaintenance(s.transaction, s.host)
  expect(failed.state).toBe('recovery-failed')
  expect(running).toBe(false)
  expect(starts).toBe(2)
  expect((await runMaintenance(s.transaction, s.host)).state).toBe('recovery-failed')
  expect(starts).toBe(2)
})
it('rejects a program target hard-linked to a user file before replacing either file', async () => {
  const s = await scenario()
  const { linkSync } = await import('node:fs')
  const target = join(s.program, 'resources/app.asar'), userFile = join(s.profile, 'document.txt')
  writeFileSync(userFile, 'OLD-APP')
  rmSync(target)
  linkSync(userFile, target)
  const result = await runMaintenance(s.transaction, s.host)
  expect(result.state).toBe('recovery-failed')
  expect(readFileSync(userFile, 'utf8')).toBe('OLD-APP')
})
it('recovers an interrupted apply exactly once and verifies the old program before recording recovery success', async () => {
  const s = await scenario()
  const transaction = JSON.parse(readFileSync(s.transaction, 'utf8'))
  transaction.state = 'applying'
  writeFileSync(s.transaction, JSON.stringify(transaction))
  writeFileSync(join(s.program, 'resources/app.asar'), 'PARTIAL-APP')
  const modes: boolean[] = []
  s.host.launchAndVerify = async (_transaction, rollback) => { modes.push(rollback) }
  expect((await runMaintenance(s.transaction, s.host)).state).toBe('rolled-back')
  expect(modes).toEqual([true])
  expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('OLD-APP')
  await runMaintenance(s.transaction, s.host)
  expect(modes).toEqual([true])
})
it('requires a readable marker before rollback and preserves a malformed marker for repair', async () => {
  const s = await scenario()
  s.host.launchAndVerify = async () => { writeFileSync(join(s.profile, 'data-format.json'), '{broken'); throw new Error('BAD_START') }
  expect((await runMaintenance(s.transaction, s.host)).state).toBe('recovery-failed')
  expect(readFileSync(join(s.profile, 'data-format.json'), 'utf8')).toBe('{broken')
  expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('NEW-APP')
})
it('keeps the previous program untouched when process stop cannot be confirmed', async () => {
  const s = await scenario()
  s.host.waitStopped = async () => { throw new Error('PROCESS_STILL_RUNNING') }
  expect((await runMaintenance(s.transaction, s.host)).state).toBe('recovery-failed')
  expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('OLD-APP')
})
it('commits an update only after actual launch verification succeeds', async () => {
  const s = await scenario()
  s.host.launchAndVerify = async (_transaction, rollback) => {
    expect(rollback).toBe(false)
    expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('NEW-APP')
    expect(readRecoveryState(s.profile)?.state).toBe('applied-pending-verify')
  }
  expect((await runMaintenance(s.transaction, s.host)).state).toBe('updated')
  expect(readRecoveryState(s.profile)?.state).toBe('updated')
})
it.each(['prepared', 'applying'])('observes live owned subprocesses and refuses replacement or rollback in %s until every related process exits', async phase => {
  const { captureOwnedProcessTree } = await import('../src/main/maintenance')
  const { nativeMaintenanceHost } = await import('../src/main/update-helper')
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  try {
    const pids = captureOwnedProcessTree(process.pid)
    expect(pids).toContain(child.pid)
    const s = await scenario()
    const transaction = JSON.parse(readFileSync(s.transaction, 'utf8'))
    transaction.relatedPids = [child.pid]
    transaction.state = phase
    const untouched = phase === 'applying' ? 'PARTIAL-APP' : 'OLD-APP'
    writeFileSync(join(s.program, 'resources/app.asar'), untouched)
    writeFileSync(s.transaction, JSON.stringify(transaction))
    const result = await runMaintenance(s.transaction, nativeMaintenanceHost({ stopTimeoutMs: 100 }))
    expect(result.state).toBe('recovery-failed')
    expect(result.detail).toContain('UPDATE_PROCESS_STOP_UNCONFIRMED')
    expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe(untouched)
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  } finally { child.kill(); await new Promise<void>(resolve => child.once('close', () => resolve())) }
}, 10000)

it.each(['installer-bytes', 'signed-manifest', 'installer-path'])('never launches a full installer after transaction tampering: %s', async fault => {
  const s = await scenario('full')
  const transaction = JSON.parse(readFileSync(s.transaction, 'utf8'))
  if (fault === 'installer-bytes') writeFileSync(transaction.installerPath, 'UNSIGNED-PAYLOAD')
  if (fault === 'signed-manifest') transaction.manifest.desktop.version = '9.9.9'
  if (fault === 'installer-path') transaction.installerPath = join(s.profile, 'renderer-supplied.exe')
  writeFileSync(s.transaction, JSON.stringify(transaction))
  let launched = false
  s.host.install = async () => { launched = true }
  expect((await runMaintenance(s.transaction, s.host)).state).toBe('recovery-failed')
  expect(launched).toBe(false)
  expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('OLD-APP')
})
it('preserves an interrupted installation for repair when the durable transaction no longer matches its signed manifest', async () => {
  const s = await scenario()
  const transaction = JSON.parse(readFileSync(s.transaction, 'utf8'))
  transaction.state = 'applying'; transaction.manifest.desktop.version = '9.9.9'
  writeFileSync(s.transaction, JSON.stringify(transaction))
  writeFileSync(join(s.program, 'resources/app.asar'), 'PARTIAL-APP')
  const result = await runMaintenance(s.transaction, s.host)
  expect(result.state).toBe('recovery-failed')
  expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('PARTIAL-APP')
})
it.skipIf(process.platform !== 'win32')('enumerates owned processes through the actual Electron Node runner without a hidden-console deadlock', async () => {
  const { buildSync } = await import('esbuild')
  const { spawn } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const directory = fresh(), api = join(directory, 'inventory.cjs')
  buildSync({ entryPoints: ['src/main/maintenance.ts'], bundle: true, external: ['original-fs'], platform: 'node', format: 'cjs', outfile: api })
  const runner = spawn(resolve('node_modules/electron/dist/electron.exe'), ['-e',
    `try { console.log(JSON.stringify(require(process.argv[1]).captureOwnedProcessTree(${process.pid}))) } catch(error) { console.error(error.message); process.exitCode=1 }`, api],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  runner.stdout.on('data', chunk => { stdout += chunk.toString() }); runner.stderr.on('data', chunk => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve, reject) => { runner.once('error', reject); runner.once('close', resolve) })
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  expect(JSON.parse(stdout)).toContain(runner.pid)
}, 25000)
it.skipIf(process.platform !== 'win32')('restores an ASAR atomically after an external reader briefly retains its Windows sharing lock', async () => {
  const s = await scenario()
  const { spawn } = await import('node:child_process')
  const holder: { child?: import('node:child_process').ChildProcessWithoutNullStreams } = {}
  s.host.launchAndVerify = async (_transaction, rollback) => {
    if (rollback) return
    const target = join(s.program, 'resources/app.asar').replace(/'/g, "''")
    const locker = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${target}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('LOCKED');Start-Sleep -Milliseconds 400;$f.Dispose()`],
      { windowsHide: true, stdio: 'pipe' })
    holder.child = locker
    await new Promise<void>((resolve, reject) => { locker.once('error', reject); locker.stdout.once('data', () => resolve()) })
    throw new Error('UPDATE_DESKTOP_NOT_USABLE')
  }
  try {
    const result = await runMaintenance(s.transaction, s.host)
    expect(result.state).toBe('rolled-back')
    expect(readFileSync(join(s.program, 'resources/app.asar'), 'utf8')).toBe('OLD-APP')
  } finally {
    const child = holder.child
    if (child && child.exitCode === null) await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill() })
  }
}, 15000)
it.each(['same', 'newer'])('retires only the completed stage pending pointer after healthy commit (%s pointer)', async pointer => {
  const s = await scenario()
  const transaction = JSON.parse(readFileSync(s.transaction, 'utf8'))
  const pointerFile = join(s.profile, 'Updates/pending.json')
  if (pointer === 'newer') s.host.launchAndVerify = async () => writeFileSync(pointerFile, '{"id":"00000000-0000-4000-8000-000000000000","source":"offline"}')
  expect((await runMaintenance(s.transaction, s.host)).state).toBe('updated')
  const { existsSync } = await import('node:fs')
  expect(existsSync(pointerFile)).toBe(pointer === 'newer')
  if (pointer === 'newer') expect(readFileSync(pointerFile, 'utf8')).toContain('00000000-0000-4000-8000-000000000000')
  expect(existsSync(join(transaction.stageRoot, 'manifest.json'))).toBe(true)
  expect(existsSync(join(transaction.stageRoot, 'backup/resources/app.asar'))).toBe(true)
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupTargets, readRecoveryState, resolveRestart, restoreBackup, verifyCombination,
  writeRecoveryState, type RecoveryState } from '../src/main/recovery'
import type { PendingUpdate } from '../src/main/updates'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), 'ideer-recovery-')); dirs.push(d); return d }

function pending(): PendingUpdate {
  return { kind: 'patch', source: 'offline', verifiedAt: '2026-10-24T00:00:00.000Z', advice: '',
    manifest: { version: 1, kind: 'patch', publishedAt: '2026-10-24T00:00:00.000Z',
      desktop: { version: '0.2.0', asarSHA256: 'a'.repeat(64) },
      runtime: { python: '3.12.10', lockSHA256: 'b'.repeat(64) },
      serverCompatibility: { minProtocol: 1, notes: '' },
      baseline: { desktopVersion: '0.1.0', runtimePython: '3.12.10' },
      deletions: ['resources/runtime/old.py'],
      files: [{ path: 'resources/runtime/core/service.py', sha256: '', bytes: 0 }] } }
}

function staged(program: string, prior: string | null, incoming = 'NEW-BYTES'): void {
  const target = join(program, 'resources', 'runtime', 'core', 'service.py')
  if (prior !== null) {
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, prior)
  }
  const old = join(program, 'resources', 'runtime', 'old.py')
  if (prior !== null) writeFileSync(old, 'OLD')
}

const OLD = 'PRIOR-BYTES'
const { createHash } = await import('node:crypto')
const OLD_HASH = createHash('sha256').update(OLD).digest('hex')
const OLD_FILE_HASH = createHash('sha256').update('OLD').digest('hex')

describe('update failure recovery (issue 109)', () => {
  it('backs up overwritten and deleted facts and rolls back an unverified restart exactly', () => {
    const program = fresh()
    staged(program, OLD)
    const record = backupTargets(pending(), program, '1091')
    expect(record.overwritten.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'resources/runtime/core/service.py', sha256: OLD_HASH },
      { path: 'resources/runtime/old.py', sha256: OLD_FILE_HASH }
    ].map(row => ({ path: row.path, sha256: row.sha256 })))
    // Apply the patch manually: new bytes win, the deletion disappears.
    writeFileSync(join(program, 'resources', 'runtime', 'core', 'service.py'), 'NEW-BYTES')
    rmSync(join(program, 'resources', 'runtime', 'old.py'))
    restoreBackup(join(program, 'resources', 'updates', 'backup-1091'), program)
    expect(readFileSync(join(program, 'resources', 'runtime', 'core', 'service.py'), 'utf8')).toBe(OLD)
    expect(readFileSync(join(program, 'resources', 'runtime', 'old.py'), 'utf8')).toBe('OLD')

    // A file that was new under this stamp is removed, not resurrected.
    const freshProgram = fresh()
    staged(freshProgram, null)
    const newRecord = backupTargets(pending(), freshProgram, '1092')
    expect(newRecord.overwritten.every(row => row.sha256 === null)).toBe(true)
    mkdirSync(join(freshProgram, 'resources', 'runtime', 'core'), { recursive: true })
    writeFileSync(join(freshProgram, 'resources', 'runtime', 'core', 'service.py'), 'NEW-BYTES')
    restoreBackup(join(freshProgram, 'resources', 'updates', 'backup-1092'), freshProgram)
    expect(existsSync(join(freshProgram, 'resources', 'runtime', 'core', 'service.py'))).toBe(false)
  })
  it('verifies the combination after restart and keeps user data out of recovery', () => {
    const program = fresh(), profile = fresh()
    staged(program, OLD)
    backupTargets(pending(), program, '1093')
    writeFileSync(join(program, 'resources', 'runtime', 'core', 'service.py'), 'NEW-BYTES')
    writeFileSync(join(profile, 'receipts.db'), 'USER-DATA')
    expect(verifyCombination({ desktopVersion: '0.2.0', runtimePython: '3.12.10' }, pending())).toBe(true)
    const applied: RecoveryState = { state: 'applied-pending-verify', stamp: '1093', programRoot: program,
      desktopVersion: '0.2.0', runtimePython: '3.12.10', detail: '' }
    const updated = resolveRestart(applied, pending(), join(program, 'resources', 'updates', 'backup-1093'),
      profile, { desktopVersion: '0.2.0', runtimePython: '3.12.10' })
    expect(updated.state).toBe('updated')
    expect(readFileSync(join(profile, 'receipts.db'), 'utf8')).toBe('USER-DATA')
    expect(readRecoveryState(profile)?.state).toBe('updated')
  })
  it('rolls back a failed combination and then stops automatic updates', () => {
    const program = fresh(), profile = fresh()
    staged(program, OLD)
    backupTargets(pending(), program, '1094')
    writeFileSync(join(program, 'resources', 'runtime', 'core', 'service.py'), 'NEW-BYTES')
    rmSync(join(program, 'resources', 'runtime', 'old.py'))
    writeFileSync(join(profile, 'receipts.db'), 'USER-DATA')
    const applied: RecoveryState = { state: 'applied-pending-verify', stamp: '1094', programRoot: program,
      desktopVersion: '0.2.0', runtimePython: '3.12.10', detail: '' }
    const rolled = resolveRestart(applied, pending(), join(program, 'resources', 'updates', 'backup-1094'),
      profile, { desktopVersion: '0.1.0', runtimePython: '3.12.10' })
    expect(rolled.state).toBe('rolled-back')
    // The previous program bytes are back and the user data is intact.
    expect(readFileSync(join(program, 'resources', 'runtime', 'core', 'service.py'), 'utf8')).toBe(OLD)
    expect(readFileSync(join(program, 'resources', 'runtime', 'old.py'), 'utf8')).toBe('OLD')
    expect(readFileSync(join(profile, 'receipts.db'), 'utf8')).toBe('USER-DATA')
    // Revived or new credentials would live in the same untouched profile area.
    expect(readRecoveryState(profile)?.state).toBe('rolled-back')
    // A second failed cycle cannot happen: the lock refuses further automatic
    // installs, and a recovery failure preserves diagnostics for manual repair.
    const brokenBackup = fresh()
    const failed = resolveRestart(applied, pending(), brokenBackup, profile,
      { desktopVersion: '0.1.0', runtimePython: '3.12.10' })
    expect(failed.state).toBe('recovery-failed')
    expect(failed.detail).toContain('manual repair')
    expect(readRecoveryState(profile)?.state).toBe('recovery-failed')
  })
})

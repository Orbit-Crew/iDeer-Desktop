// Issue 109: failure recovery for the drain-and-install flow. The installer
// backs up every file it is about to overwrite or delete; a restart that does
// not verify against the pending combination restores that backup exactly
// once and then locks further automatic updates behind a manual-repair note.
// User data lives in the profile directory and is never a recovery input or
// output: only the program directory is read, written or rolled back.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { PendingUpdate } from './updates'

export interface BackupRecord {
  stamp: string
  programRoot: string
  /** Relative paths restored on rollback, with their pre-install SHA-256. */
  overwritten: { path: string; sha256: string | null }[]
}

export interface RecoveryState {
  state: 'applied-pending-verify' | 'updated' | 'rolled-back' | 'recovery-failed'
  stamp: string
  programRoot: string
  desktopVersion: string
  runtimePython: string
  detail: string
}

export const contained = (base: string, target: string): boolean => {
  const rel = relative(resolve(base), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Back up every existing file the patch would overwrite or delete. */
export function backupTargets(pending: PendingUpdate, programRoot: string, stamp: string): BackupRecord {
  const manifest = pending.manifest
  const backupDir = join(programRoot, 'resources', 'updates', `backup-${stamp}`)
  const overwritten: BackupRecord['overwritten'] = []
  for (const file of manifest.files) {
    const target = resolve(programRoot, file.path)
    if (!contained(programRoot, target)) throw new Error('UPDATE_TARGET_OUTSIDE_PROGRAM_DIRECTORY')
    if (existsSync(target)) {
      mkdirSync(join(backupDir, file.path, '..'), { recursive: true })
      copyFileSync(target, join(backupDir, file.path))
      overwritten.push({ path: file.path, sha256: sha256File(target) })
    } else {
      overwritten.push({ path: file.path, sha256: null })
    }
  }
  for (const deletion of manifest.deletions) {
    const target = resolve(programRoot, deletion)
    if (!contained(programRoot, target)) throw new Error('UPDATE_TARGET_OUTSIDE_PROGRAM_DIRECTORY')
    if (existsSync(target)) {
      mkdirSync(join(backupDir, deletion, '..'), { recursive: true })
      copyFileSync(target, join(backupDir, deletion))
      overwritten.push({ path: deletion, sha256: sha256File(target) })
    } else if (!overwritten.some(row => row.path === deletion)) {
      overwritten.push({ path: deletion, sha256: null })
    }
  }
  const record: BackupRecord = { stamp, programRoot, overwritten }
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(join(backupDir, 'backup-manifest.json'), JSON.stringify(record, null, 2))
  return record
}

/** Restore exactly the recorded pre-install facts; remove files that were new. */
export function restoreBackup(backupDir: string, programRoot: string): void {
  const record: BackupRecord = JSON.parse(readFileSync(join(backupDir, 'backup-manifest.json'), 'utf8'))
  if (resolve(record.programRoot) !== resolve(programRoot)) throw new Error('RECOVERY_ROOT_MISMATCH')
  for (const entry of record.overwritten) {
    const target = resolve(programRoot, entry.path)
    if (!contained(programRoot, target)) throw new Error('UPDATE_TARGET_OUTSIDE_PROGRAM_DIRECTORY')
    if (entry.sha256 === null) {
      if (existsSync(target)) unlinkSync(target)
    } else {
      const source = join(backupDir, entry.path)
      if (!existsSync(source) || sha256File(source) !== entry.sha256) {
        throw new Error('RECOVERY_BACKUP_INTEGRITY_FAILED')
      }
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(source, target)
    }
  }
}

export function verifyCombination(current: { desktopVersion: string; runtimePython: string },
    pending: PendingUpdate): boolean {
  return current.desktopVersion === pending.manifest.desktop.version &&
    current.runtimePython === pending.manifest.runtime.python
}

const LOCK_FILE = 'updates-recovery.json'

export function readRecoveryState(userData: string): RecoveryState | null {
  try {
    return JSON.parse(readFileSync(join(userData, LOCK_FILE), 'utf8')) as RecoveryState
  } catch { return null }
}

export function writeRecoveryState(userData: string, state: RecoveryState): void {
  writeFileSync(join(userData, LOCK_FILE), JSON.stringify(state, null, 2))
}

/**
 * One-shot restart verification. A mismatch rolls back exactly once; a failed
 * rollback stops every further automatic update attempt and preserves the
 * backup and diagnostics for manual repair.
 */
export function resolveRestart(recovery: RecoveryState, pending: PendingUpdate | null, backupDir: string | null,
    userData: string, current: { desktopVersion: string; runtimePython: string }): RecoveryState {
  if (recovery.state !== 'applied-pending-verify') return recovery
  const expected = pending?.manifest.desktop.version ?? recovery.desktopVersion
  const expectedRuntime = pending?.manifest.runtime.python ?? recovery.runtimePython
  if (current.desktopVersion === expected && current.runtimePython === expectedRuntime) {
    const updated: RecoveryState = { ...recovery, state: 'updated', detail: 'restart verified the installed combination' }
    writeRecoveryState(userData, updated)
    return updated
  }
  if (backupDir && existsSync(join(backupDir, 'backup-manifest.json'))) {
    try {
      restoreBackup(backupDir, recovery.programRoot)
      const rolled: RecoveryState = { ...recovery, state: 'rolled-back', desktopVersion: current.desktopVersion,
        runtimePython: current.runtimePython, detail: 'the installed combination did not verify; the previous program files were restored. User data was never touched. Please run manual repair before updating again.' }
      writeRecoveryState(userData, rolled)
      return rolled
    } catch (error) {
      const failed: RecoveryState = { ...recovery, state: 'recovery-failed',
        detail: 'automatic recovery failed; automatic updates are disabled. Backups and diagnostics were preserved for manual repair: ' + String(error) }
      writeRecoveryState(userData, failed)
      return failed
    }
  }
  const failed: RecoveryState = { ...recovery, state: 'recovery-failed',
    detail: 'no recovery backup was found; automatic updates are disabled and manual repair is required' }
  writeRecoveryState(userData, failed)
  return failed
}

export const removeTree = (path: string): void => rmSync(path, { recursive: true, force: true })
export const listDir = (path: string): string[] => existsSync(path) ? readdirSync(path) : []
export const fileSize = (path: string): number => statSync(path).size

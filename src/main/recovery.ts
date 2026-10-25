import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from './update-filesystem'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface RecoveryState {
  state: 'applied-pending-verify' | 'updated' | 'rolled-back' | 'recovery-failed'
  stamp: string
  programRoot: string
  desktopVersion: string
  runtimePython: string
  detail: string
  journalPath?: string
}
export const PROFILE_FORMAT = 1
export const PROFILE_READERS = [1]
export const FORMAT_FILE = 'data-format.json'
export const contained = (base: string, target: string): boolean => {
  const rel = relative(resolve(base), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
export const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Reject junctions, alternate streams, reserved device names and dot segments. */
export function safeProgramPath(base: string, path: string): string {
  const inspect = (path: string): void => {
    try {
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error('UPDATE_REPARSE_POINT_REJECTED')
      if (info.isFile() && info.nlink > 1) throw new Error('UPDATE_HARDLINK_REJECTED')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (!path || path.includes('\\') || path.includes(':') || path.includes('\0') || path.startsWith('/') ||
      path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('UPDATE_PATH_INVALID')
  const target = resolve(base, path)
  if (!contained(base, target)) throw new Error('UPDATE_PATH_OUTSIDE_PROGRAM_DIRECTORY')
  let root = resolve(base)
  for (;;) {
    inspect(root)
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }
  let current = resolve(base)
  for (const part of path.split('/')) {
    current = join(current, part)
    inspect(current)
  }
  return target
}

export function durableJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = path + '.' + randomUUID() + '.tmp'
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}

/** Missing is deployed legacy format; malformed never means legacy. */
export function readDataFormat(userData: string): number {
  const path = safeProgramPath(userData, FORMAT_FILE)
  if (!existsSync(path)) return 1
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('UPDATE_DATA_FORMAT_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'format' ||
      !Number.isSafeInteger((value as { format: number }).format) || (value as { format: number }).format < 1) throw new Error('UPDATE_DATA_FORMAT_INVALID')
  return (value as { format: number }).format
}
export function initializeDataFormat(userData: string): number {
  const format = readDataFormat(userData)
  if (!PROFILE_READERS.includes(format)) throw new Error('UPDATE_DATA_FORMAT_UNREADABLE_MANUAL_REPAIR')
  if (!existsSync(join(userData, FORMAT_FILE))) durableJSON(join(userData, FORMAT_FILE), { format })
  return format
}

const LOCK_FILE = 'updates-recovery.json'
export function readRecoveryState(userData: string): RecoveryState | null {
  const path = safeProgramPath(userData, LOCK_FILE)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RecoveryState
    if (!['applied-pending-verify', 'updated', 'rolled-back', 'recovery-failed'].includes(value.state) ||
        typeof value.stamp !== 'string' || typeof value.detail !== 'string') throw new Error('invalid state')
    return value
  } catch {
    return { state: 'recovery-failed', stamp: '', programRoot: '', desktopVersion: '', runtimePython: '',
      detail: 'Recovery record is unreadable. Automatic updates are disabled; preserve Updates and run manual repair.' }
  }
}
export function writeRecoveryState(userData: string, state: RecoveryState): void {
  durableJSON(safeProgramPath(userData, LOCK_FILE), state)
}

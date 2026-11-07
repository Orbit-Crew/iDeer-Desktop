/**
 * Issue 86: the shell's device-local preference store. Main owns it because
 * main alone decides at close time; the renderer reaches it only through the
 * validated `desktop:preferences` command family. It is deliberately not the
 * Runtime settings profile (a shell preference, not runtime configuration)
 * and deliberately not localStorage (main cannot read it).
 *
 * The parse rules are Electron-free and tolerant by design: a missing,
 * corrupt or partly unreadable store answers the resident default instead of
 * making the close path throw.
 */
import { readFileSync } from 'node:fs'
import type { PreferenceCommand } from '../shared/desktop'
import { atomicWriteFile } from './atomic-save'

export interface ShellPreferences {
  /** true (default): closing the window hides to the tray and the Runtime
   * keeps running. false (关窗即退出): the close itself is a true exit. */
  closeToTray: boolean
}

export const DEFAULT_SHELL_PREFERENCES: ShellPreferences = { closeToTray: true }

export function parseShellPreferences(raw: string | null | undefined): ShellPreferences {
  if (raw === null || raw === undefined || raw === '') return { ...DEFAULT_SHELL_PREFERENCES }
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SHELL_PREFERENCES }
    const row = value as Record<string, unknown>
    return {
      closeToTray: typeof row.closeToTray === 'boolean'
        ? row.closeToTray
        : DEFAULT_SHELL_PREFERENCES.closeToTray
    }
  } catch {
    return { ...DEFAULT_SHELL_PREFERENCES }
  }
}

export function serializeShellPreferences(prefs: ShellPreferences): string {
  return JSON.stringify({ closeToTray: prefs.closeToTray === false ? false : true })
}

/** Strictly the two command shapes; anything else is the family error. */
export function parsePreferenceCommand(command: unknown): PreferenceCommand {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('PREFERENCE_COMMAND_INVALID')
  }
  const row = command as Record<string, unknown>
  const keys = Object.keys(row).length
  if (row.action === 'get' && keys === 1) return { action: 'get' }
  if (row.action === 'set' && keys === 2 && typeof row.closeToTray === 'boolean') {
    return { action: 'set', closeToTray: row.closeToTray }
  }
  throw new Error('PREFERENCE_COMMAND_INVALID')
}

/** The physical seam, injected so the rules above stay hermetically testable. */
export interface PreferenceIO {
  read(file: string): string | null
  write(file: string, content: string): void
}

/** userData IO: reads are best-effort, writes go through the shared atomic
 * staged rename so a crash never leaves a partial preference file. */
export const nodePreferenceIO: PreferenceIO = {
  read: (file) => {
    try { return readFileSync(file, 'utf8') } catch { return null }
  },
  write: (file, content) => { atomicWriteFile(file, content, 'tmp') }
}

export class ShellPreferenceStore {
  constructor(private readonly file: string, private readonly io: PreferenceIO = nodePreferenceIO) {}

  load(): ShellPreferences {
    return parseShellPreferences(this.io.read(this.file))
  }

  save(prefs: ShellPreferences): void {
    this.io.write(this.file, serializeShellPreferences(prefs))
  }
}

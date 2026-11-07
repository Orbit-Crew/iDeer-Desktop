import { describe, expect, it } from 'vitest'
import { DEFAULT_SHELL_PREFERENCES, parsePreferenceCommand, parseShellPreferences,
  serializeShellPreferences, ShellPreferenceStore, type PreferenceIO } from '../src/main/preferences'

/** Issue 86: the shell's device-local window-lifecycle preference. Main owns
 * the store (a small userData JSON) because main needs it at close time; the
 * parse/serialize/command rules are Electron-free and validated here. */

const memoryIO = (initial: Record<string, string> = {}): PreferenceIO & { files: Map<string, string> } => {
  const files = new Map(Object.entries(initial))
  return {
    files,
    read: (file) => files.get(file) ?? null,
    write: (file, content) => { files.set(file, content) }
  }
}

describe('shell preference parsing (#86)', () => {
  it('defaults to tray-resident close for every missing or unreadable file', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '"str"', '42']) {
      expect(parseShellPreferences(raw)).toEqual(DEFAULT_SHELL_PREFERENCES)
      expect(DEFAULT_SHELL_PREFERENCES.closeToTray).toBe(true)
    }
  })
  it('reads a stored preference and keeps it device-local (no account fields)', () => {
    expect(parseShellPreferences('{"closeToTray":false}')).toEqual({ closeToTray: false })
    expect(parseShellPreferences('{"closeToTray":true}')).toEqual({ closeToTray: true })
  })
  it('falls back per-field instead of trusting a wrong-typed value', () => {
    expect(parseShellPreferences('{"closeToTray":"yes"}')).toEqual(DEFAULT_SHELL_PREFERENCES)
    expect(parseShellPreferences('{"closeToTray":null}')).toEqual(DEFAULT_SHELL_PREFERENCES)
  })
  it('serializes exactly the one preference field back', () => {
    expect(serializeShellPreferences({ closeToTray: false })).toBe('{"closeToTray":false}')
    expect(parseShellPreferences(serializeShellPreferences({ closeToTray: false })))
      .toEqual({ closeToTray: false })
  })
})

describe('shell preference command validation (#86)', () => {
  it('accepts exactly get and the one boolean set form', () => {
    expect(parsePreferenceCommand({ action: 'get' })).toEqual({ action: 'get' })
    expect(parsePreferenceCommand({ action: 'set', closeToTray: false }))
      .toEqual({ action: 'set', closeToTray: false })
  })
  it.each([
    null, undefined, 'get', [], {},
    { action: 'get', extra: 1 },
    { action: 'set' },
    { action: 'set', closeToTray: 'no' },
    { action: 'set', closeToTray: 1 },
    { action: 'set', closeToTray: false, extra: 1 },
    { action: 'reset' }
  ])('rejects %j', (command) => {
    expect(() => parsePreferenceCommand(command)).toThrow('PREFERENCE_COMMAND_INVALID')
  })
})

describe('shell preference store (#86)', () => {
  const file = 'C:\\userData\\preferences.json'
  it('round-trips a saved preference through the atomic write', () => {
    const io = memoryIO()
    const store = new ShellPreferenceStore(file, io)
    expect(store.load()).toEqual(DEFAULT_SHELL_PREFERENCES)
    store.save({ closeToTray: false })
    expect(new ShellPreferenceStore(file, io).load()).toEqual({ closeToTray: false })
    expect(io.files.get(file)).toBe('{"closeToTray":false}')
  })
  it('answers the default for a corrupt store instead of failing the close path', () => {
    const store = new ShellPreferenceStore(file, memoryIO({ [file]: '{broken' }))
    expect(store.load()).toEqual(DEFAULT_SHELL_PREFERENCES)
  })
})

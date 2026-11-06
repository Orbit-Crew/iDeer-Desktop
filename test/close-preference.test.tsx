// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ClosePreference, { ClosePreferenceView } from '../src/renderer/src/components/Layout/ClosePreference'
import type { PreferenceCommand, PreferencesView } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

/** Issue 86: the settings surface's 关窗即退出 toggle. The switch reads the
 * device-local preference through the desktop:preferences family and writes
 * exactly the inverse boolean; failures surface honestly, never silently. */

describe('close preference view (#86)', () => {
  it('renders 关窗即退出 unchecked while the resident default holds', () => {
    render(<ClosePreferenceView view={{ closeToTray: true }} busy={false} error=""
      onCommand={() => {}} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })
  it('renders the switch checked when 关窗即退出 is set', () => {
    render(<ClosePreferenceView view={{ closeToTray: false }} busy={false} error=""
      onCommand={() => {}} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })
  it('sends exactly the inverse boolean when toggled', () => {
    const commands: PreferenceCommand[] = []
    render(<ClosePreferenceView view={{ closeToTray: true }} busy={false} error=""
      onCommand={(command) => commands.push(command)} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(commands).toEqual([{ action: 'set', closeToTray: false }])
  })
  it('keeps the switch usable during a save and shows an honest failure', () => {
    render(<ClosePreferenceView view={{ closeToTray: true }} busy={false}
      error="PREFERENCE_COMMAND_INVALID" onCommand={() => {}} />)
    expect(screen.getByText(/设置未保存/)).toBeTruthy()
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
  })
  it('disables the switch while a save is in flight', () => {
    render(<ClosePreferenceView view={{ closeToTray: true }} busy={true} error=""
      onCommand={() => {}} />)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  })
  it('answers nothing before the preference has loaded', () => {
    render(<ClosePreferenceView view={null} busy={false} error="" onCommand={() => {}} />)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('close preference wiring (#86)', () => {
  it('loads the stored preference once and toggles it through the family', async () => {
    const calls: PreferenceCommand[] = []
    let stored: PreferencesView = { closeToTray: true }
    ;(window as { ideer?: unknown }).ideer = {
      preferences: vi.fn((command: PreferenceCommand) => {
        calls.push(command)
        if (command.action === 'set') stored = { closeToTray: command.closeToTray }
        return Promise.resolve(stored)
      })
    }
    render(<ClosePreference />)
    await waitFor(() => expect(calls).toEqual([{ action: 'get' }]))
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(calls).toEqual([{ action: 'get' }, { action: 'set', closeToTray: false }]))
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  })
  it('surfaces a failed read instead of pretending the default', async () => {
    ;(window as { ideer?: unknown }).ideer = {
      preferences: vi.fn(() => Promise.reject(new Error('PREFERENCE_COMMAND_INVALID')))
    }
    render(<ClosePreference />)
    await waitFor(() => expect(screen.getByText(/设置未保存/)).toBeTruthy())
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps the previous value visible when a save fails', async () => {
    const calls: PreferenceCommand[] = []
    ;(window as { ideer?: unknown }).ideer = {
      preferences: vi.fn((command: PreferenceCommand) => {
        calls.push(command)
        if (command.action === 'set') return Promise.reject(new Error('PREFERENCE_WRITE_FAILED'))
        return Promise.resolve({ closeToTray: true })
      })
    }
    render(<ClosePreference />)
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByText(/设置未保存/)).toBeTruthy())
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    // The failed save keeps the confirmed view and re-reads the store once.
    expect(calls).toEqual([{ action: 'get' }, { action: 'set', closeToTray: false }, { action: 'get' }])
  })
})

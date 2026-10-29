// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillSection } from '../src/renderer/src/components/SkillSection'
import type { RuntimeStatus, SkillScriptAuthorizationView, SkillScriptCommand, SkillScriptView } from '../src/shared/desktop'

// antd's responsive helpers need matchMedia under jsdom.
beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const GRANT_ID = 'a'.repeat(64)
const grant = (overrides: Partial<SkillScriptAuthorizationView> = {}): SkillScriptAuthorizationView => ({
  id: GRANT_ID, resourceId: 'weekly-report', slug: 'weekly-report', version: 1, contentHash: 'a'.repeat(64),
  scriptPath: 'scripts/report.py', scriptSha256: 'c'.repeat(64), requirementsHash: 'e'.repeat(64),
  status: 'granted', createdAt: '2026-10-29T00:00:00Z', ...overrides
})

const mount = (onScriptCommands: (command: SkillScriptCommand) => Promise<SkillScriptView>) =>
  render(<SkillSection busy={false} error="" onCommand={() => {}}
    onPreferences={async () => ({ skills: [] })} onScriptCommands={onScriptCommands} />)

describe('SkillSection revoke responses carry the real Runtime shapes (#41)', () => {
  it('drops the revoked row and shows no error on {revoked:true, authorizations:[]}', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ authorizations: [grant()] })
      .mockResolvedValueOnce({ authorizations: [], revoked: true })
    mount((command) => api(command))
    const row = await screen.findByText(/weekly-report · scripts\/report\.py · V1/)
    expect(row).toBeTruthy()
    fireEvent.click(screen.getByLabelText('撤销脚本授权 weekly-report'))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith({ action: 'revoke', authorizationId: GRANT_ID }))
    await waitFor(() => expect(screen.queryByText(/scripts\/report\.py/)).toBeNull())
    expect(screen.queryByText(/脚本授权不可用/)).toBeNull()
    expect(screen.queryByText('该授权此前已不存在或已被撤销，无需重复操作。')).toBeNull()
  })

  it('shows the already-gone notice (not an error) on {revoked:false}', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ authorizations: [grant()] })
      .mockResolvedValueOnce({ authorizations: [], revoked: false })
    mount((command) => api(command))
    await screen.findByText(/weekly-report · scripts\/report\.py · V1/)
    fireEvent.click(screen.getByLabelText('撤销脚本授权 weekly-report'))
    await waitFor(() => expect(screen.getByText('该授权此前已不存在或已被撤销，无需重复操作。')).toBeTruthy())
    expect(screen.queryByText(/脚本授权不可用/)).toBeNull()
    expect(screen.queryByText(/weekly-report · scripts\/report\.py/)).toBeNull()
  })

  it('surfaces the cross-process rejection category as the script error', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ authorizations: [grant()] })
      .mockRejectedValueOnce(new Error('SKILL_SCRIPT_UNAVAILABLE'))
    mount((command) => api(command))
    await screen.findByText(/weekly-report · scripts\/report\.py · V1/)
    fireEvent.click(screen.getByLabelText('撤销脚本授权 weekly-report'))
    await waitFor(() => expect(screen.getByText('脚本授权不可用：SKILL_SCRIPT_UNAVAILABLE')).toBeTruthy())
    // The grant row stays listed: the device state is unknown, not confirmed gone.
    expect(screen.getByText(/weekly-report · scripts\/report\.py · V1/)).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillSection } from '../src/renderer/src/components/SkillSection'
import type { RuntimeStatus, SkillTriggerPreferenceView } from '../src/shared/desktop'

// antd's responsive helpers need matchMedia under jsdom.
beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const preferenceRow = (overrides: Partial<SkillTriggerPreferenceView> = {}): SkillTriggerPreferenceView => ({
  skillId: '77777777-7777-4777-8777-777777777777', slug: 'report-skill', displayName: 'Report skill',
  latestVersion: 2, available: true, enabled: true, keywords: ['weekly report'], alwaysInject: false,
  applicableAgentIds: [], priority: 3, ...overrides
})

const runtimeSnapshot = (): RuntimeStatus =>
  ({ process: 'running', connection: 'connected', tasks: [] })

// Issue 40: the production component mounts through the pinned window.ideer
// bridges. Before the fix the per-render fallback arrows rebuilt the reload
// callbacks, so every parent status tick re-ran the load effects — re-sending
// the single-slot list requests (SKILL_PREFERENCE_BUSY / SKILL_SCRIPT_BUSY)
// and overwriting unsaved drafts with fresh server rows.
describe('SkillSection default-bridge loading runs once per mount (#40)', () => {
  it('does not re-send single-slot list requests on unrelated re-renders and keeps unsaved drafts', async () => {
    const skillPreferences = vi.fn().mockResolvedValue({ skills: [preferenceRow()] })
    const skillScripts = vi.fn().mockResolvedValue({ authorizations: [] })
    ;(window as unknown as { ideer: unknown }).ideer = { skillPreferences, skillScripts }
    const view = render(<SkillSection busy={false} error="" onCommand={() => {}} />)

    await screen.findByText(/report-skill ·/)
    await waitFor(() => expect(skillPreferences).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(skillScripts).toHaveBeenCalledTimes(1))

    const keywords = 'weekly, 未保存草稿'
    fireEvent.change(screen.getByLabelText('关键词输入 report-skill'), { target: { value: keywords } })
    expect((screen.getByLabelText('关键词输入 report-skill') as HTMLInputElement).value).toBe(keywords)

    // The real parent pushes a fresh runtime snapshot object every second;
    // that re-render must not re-trigger the load effects.
    view.rerender(<SkillSection busy={false} error="" onCommand={() => {}} runtime={runtimeSnapshot()} />)
    expect(skillPreferences).toHaveBeenCalledTimes(1)
    expect(skillScripts).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText('关键词输入 report-skill') as HTMLInputElement).value).toBe(keywords)

    view.rerender(<SkillSection busy error="导入失败：SKILL_COMMAND_INVALID" onCommand={() => {}} runtime={runtimeSnapshot()} />)
    expect(skillPreferences).toHaveBeenCalledTimes(1)
    expect(skillScripts).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText('关键词输入 report-skill') as HTMLInputElement).value).toBe(keywords)
  })
})

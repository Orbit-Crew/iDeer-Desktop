// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import ModelSettingsModal, { ModelSettingsSection, MODEL_ABSENCE_NOTES } from '../src/renderer/src/components/Layout/ModelSettingsModal'
import type { ModelSettingsView } from '../src/shared/desktop'

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const view = (overrides: Partial<ModelSettingsView> = {}): ModelSettingsView => ({
  models: [
    { name: 'model-alpha', displayName: 'Alpha', description: 'first', supportsThinking: false },
    { name: 'model-beta', displayName: 'Beta', description: '', supportsThinking: true }
  ],
  accountDefault: 'model-alpha', fallback: '', canRead: true, reason: '', ...overrides
})

describe('model settings surface (#73)', () => {
  it('renders the authorized list choices without any provider or key field', () => {
    const html = renderToStaticMarkup(<ModelSettingsSection view={view()} busy={false} error="" onCommand={() => {}} />)
    expect(html).toContain('账号默认模型')
    expect(html).toContain('备用模型')
    expect(html).toContain('Alpha')
    expect(html).toContain('与 Web 端同一设置')
    for (const note of MODEL_ABSENCE_NOTES) expect(html).toContain(note)
    // The absence statements are in place, and no provider/credential input exists.
    expect(html).not.toMatch(/Base URL.*input|API Key.*input|input[^>]*aria-label="[^"]*Key/i)
    expect(html).not.toContain('Ollama 分区')
  })

  it('states the absence of the model catalog instead of faking rows', () => {
    const html = renderToStaticMarkup(<ModelSettingsSection view={view({ canRead: false, reason: 'CHAT_MODEL_LIST_FORBIDDEN', models: [], accountDefault: '' })}
      busy={false} error="" onCommand={() => {}} />)
    expect(html).toContain('没有平台模型目录的读取权限')
    expect(html).toContain('平台默认模型')
  })

  it('loads once per open and refreshes the post-action view through the pinned bridge', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ fallback: 'model-beta' }))
    ;(window as unknown as { ideer: unknown }).ideer = { models }
    const modal = render(<ModelSettingsModal open onClose={() => {}} />)
    await screen.findByText(/Alpha/)
    expect(models).toHaveBeenCalledTimes(1)
    // The 备用模型 selector is the second ant-select in the modal.
    fireEvent.mouseDown(document.querySelectorAll('.ant-select-selector')[1])
    await screen.findByText(/^Beta$/)
    fireEvent.click(screen.getByText(/^Beta$/))
    await waitFor(() => expect(models).toHaveBeenCalledWith({ action: 'set-fallback', modelName: 'model-beta' }))
    await waitFor(() => expect(document.querySelector('.ant-select-selection-item[title="Beta"]')).toBeTruthy())
    modal.unmount()
  })

  it('keeps the settings actions sequential and reports a failed write without losing the view', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce(view())
      .mockRejectedValueOnce(new Error('CHAT_IDENTITY_CHANGED'))
      .mockResolvedValueOnce(view({ accountDefault: '' }))
    ;(window as unknown as { ideer: unknown }).ideer = { models }
    render(<ModelSettingsModal open onClose={() => {}} />)
    await screen.findByText(/Alpha/)
    fireEvent.mouseDown(document.querySelectorAll('.ant-select-selector')[0])
    await screen.findByText(/^Beta$/)
    fireEvent.click(screen.getByText(/^Beta$/))
    await screen.findByText(/模型设置不可用：CHAT_IDENTITY_CHANGED/)
    await waitFor(() => expect(models).toHaveBeenCalledTimes(3))
  })
})

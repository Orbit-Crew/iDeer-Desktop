// @vitest-environment jsdom
// Issue 107 + 109: the browser slot hosts BOTH browsers behind one explicit
// 本机/远端 choice. The default is 本机 (the restored local webview pane);
// 远端 is the platform's pixel-stream pane. The location never changes on
// its own — only this visible choice moves it, and the current location is
// always stated in place.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BrowserPaneEvent, ChatSnapshot, DesktopBridge, RemoteBrowserEvent } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  const backing = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string, value: string) => void backing.delete(key),
    clear: () => void backing.clear()
  }
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

/** The full bridge surface both panes touch, mocked the way the pane tests
 * mock it: the local pane subscribes to browser facts; the remote pane asks
 * chat state and subscribes to stream facts. */
function harness(): void {
  const chatState: ChatSnapshot = {
    scope: 'scope-1',
    thread: { id: 'th-1', status: 'idle', agentId: 'a1', skillId: '' },
    artifacts: [], resources: [], threads: [], messages: [], events: [], run: null,
    subagents: [], stream: 'idle', error: ''
  } as ChatSnapshot
  ;(window as unknown as { ideer: DesktopBridge }).ideer = {
    browser: vi.fn(async () => {}),
    onBrowserEvents: (listener: (event: BrowserPaneEvent) => void) => () => { void listener },
    chat: vi.fn(async () => chatState),
    remoteBrowser: vi.fn(async () => ({ status: 'open' })),
    onRemoteBrowserEvents: () => () => {}
  } as unknown as DesktopBridge
}

describe('browser slot location choice (issues 107 + 109)', () => {
  it('defaults to 本机: the local pane renders and the choice states both locations', async () => {
    harness()
    const { default: BrowserSlotPane } = await import('../src/renderer/src/dock/panels/browserSlotPane')
    const { default: BrowserPane } = await import('../src/renderer/src/dock/panels/browserPane')
    const { PANEL_REGISTRY } = await import('../src/renderer/src/dock/panelRegistry')

    const browserDef = PANEL_REGISTRY.find((p) => p.id === 'browser')!
    expect(browserDef.component).toBe(BrowserSlotPane)

    render(<BrowserSlotPane instanceId="inst-1" panelType="browser" />)

    const choice = screen.getByRole('group', { name: '浏览器位置选择' })
    expect(choice).toBeTruthy()
    const localButton = screen.getByRole('button', { name: '本机' })
    const remoteButton = screen.getByRole('button', { name: '远端' })
    expect(localButton.getAttribute('aria-pressed')).toBe('true')
    expect(remoteButton.getAttribute('aria-pressed')).toBe('false')
    // The local pane is the restored 本机 browser (its address bar shows).
    expect(screen.getByPlaceholderText('输入网址')).toBeTruthy()
    // The remote pane's permanent badge must not appear while 本机 is chosen.
    expect(screen.queryByText('远端', { selector: '.ant-tag' })).toBeNull()
    void BrowserPane
  })

  it('switches location only through the explicit choice, both ways', async () => {
    harness()
    const { default: BrowserSlotPane } = await import('../src/renderer/src/dock/panels/browserSlotPane')
    render(<BrowserSlotPane instanceId="inst-1" panelType="browser" />)

    // 远端 chosen explicitly: the remote pane shows its permanent badge and
    // honest location line; the local address bar is gone.
    fireEvent.click(screen.getByRole('button', { name: '远端' }))
    expect(screen.getByText('远端', { selector: '.ant-tag' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('输入网址')).toBeNull()

    // Back to 本机: explicit again — the slot never stays or drifts silently.
    fireEvent.click(screen.getByRole('button', { name: '本机' }))
    expect(screen.queryByText('远端', { selector: '.ant-tag' })).toBeNull()
    expect(screen.getByPlaceholderText('输入网址')).toBeTruthy()
  })
})

// @vitest-environment jsdom
// Issue 107: the restored local browser pane. These pin the honest start
// page, the webview attach shape (the one fixed partition, no node
// integration, no popups), the address grammar with no invented search
// engine, multi-tab and navigation behavior, per-event permission/download
// records, and the clear action riding the trusted main-process dialog.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BrowserPane from '../src/renderer/src/dock/panels/browserPane'
import type { BrowserPaneEvent, DesktopBridge } from '../src/shared/desktop'
import { BROWSER_PARTITION } from '../src/shared/desktop'

type EventListener = (event: BrowserPaneEvent) => void

function harness(): { browser: ReturnType<typeof vi.fn>; emit: (event: BrowserPaneEvent) => void; listeners: EventListener[] } {
  const listeners: EventListener[] = []
  const browser = vi.fn(async () => {})
  ;(window as unknown as { ideer: DesktopBridge }).ideer = {
    browser,
    onBrowserEvents: (listener: EventListener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  } as unknown as DesktopBridge
  return {
    browser,
    emit: (event) => act(() => { listeners.forEach((listener) => listener(event)) }),
    listeners
  }
}

/** Dispatches one guest webview event the way Electron delivers it — a plain
 * event object carrying its payload properties — inside act(). */
function guest(el: HTMLElement, name: string, payload: Record<string, unknown> = {}): void {
  act(() => { el.dispatchEvent(Object.assign(new Event(name), payload)) })
}

function webviews(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('webview')) as HTMLElement[]
}

function attrs(el: HTMLElement): Record<string, string> {
  const record: Record<string, string> = {}
  for (const attribute of Array.from(el.attributes)) record[attribute.name] = attribute.value
  return record
}

function typeAddress(container: HTMLElement, value: string): void {
  const input = screen.getByPlaceholderText('输入网址') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(input.closest('form')!)
}

beforeEach(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { ideer?: DesktopBridge }).ideer
})

describe('browser pane start page (issue 107)', () => {
  it('opens at the honest start page with navigation affordances', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    expect(container.textContent).toContain('浏览器起始页')
    expect(container.textContent).toContain('页面均为外部内容，不接入可信桥')
    expect(container.textContent).toContain('登录态与 Cookie 存独立分区')
    expect(container.textContent).toContain('下载自动进入已授权文件夹')
    expect(container.textContent).toContain('权限请求默认拒绝')
    expect(screen.getByRole('button', { name: '后退' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '前进' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '主页' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建页签' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '清空分区' })).toBeTruthy()
    expect(webviews(container)).toHaveLength(0)
  })

  it('subscribes to the pushed browser facts exactly once and unsubscribes on unmount', () => {
    const { listeners } = harness()
    const { unmount } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    expect(listeners).toHaveLength(1)
    unmount()
    expect(listeners).toHaveLength(0)
  })
})

describe('browser pane navigation (issue 107)', () => {
  it('attaches a webview with the fixed partition and hardened preferences', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    const attached = webviews(container)
    expect(attached).toHaveLength(1)
    const record = attrs(attached[0])
    expect(record['partition']).toBe(BROWSER_PARTITION)
    expect(record['src']).toBe('https://example.com')
    expect(record['webpreferences']).toContain('nodeIntegration=no')
    expect(record['webpreferences']).toContain('contextIsolation=yes')
    expect(record['webpreferences']).toContain('sandbox=yes')
    expect(record['allowpopups']).toBeUndefined()
    expect(record['preload']).toBeUndefined()
  })

  it('rejects a file path with an honest error and never mounts a webview', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'file:///C:/Windows/notepad.exe')
    expect(container.textContent).toContain('无法识别的地址')
    expect(webviews(container)).toHaveLength(0)
  })

  it('rejects free text instead of inventing a search destination', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'wing profile simulation tutorial')
    expect(container.textContent).toContain('无法识别的地址')
    expect(webviews(container)).toHaveLength(0)
  })

  it('keeps every tab mounted and only hides the inactive webview', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    fireEvent.click(screen.getByRole('button', { name: '新建页签' }))
    typeAddress(container, 'second.example')
    const attached = webviews(container)
    expect(attached).toHaveLength(2)
    expect(attrs(attached[0])['src']).toBe('https://example.com')
    expect(attrs(attached[1])['src']).toBe('https://second.example')
    expect(attached[1].style.display).not.toBe('none')
    expect(attached[0].style.display).toBe('none')
    // 切回第一个页签：仍然挂载，只是可见性变化
    fireEvent.click(screen.getByTitle('https://example.com'))
    expect(webviews(container)).toHaveLength(2)
    expect(webviews(container)[0].style.display).not.toBe('none')
    expect(webviews(container)[1].style.display).toBe('none')
  })

  it('rides the webview history for back/forward and reloads the active tab', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    const el = webviews(container)[0]
    el.goBack = vi.fn()
    el.goForward = vi.fn()
    el.reload = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    expect(el.goBack).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    expect(el.goForward).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(el.reload).toHaveBeenCalledOnce()
    // 主页回到起始页：webview 卸载，如实不保留外部页状态
    fireEvent.click(screen.getByRole('button', { name: '主页' }))
    expect(webviews(container)).toHaveLength(0)
    expect(container.textContent).toContain('浏览器起始页')
  })

  it('follows committed navigations into the address bar and title', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    const el = webviews(container)[0]
    guest(el, 'did-navigate', { url: 'https://example.com/landing' })
    guest(el, 'page-title-updated', { title: 'Example Domain' })
    expect((screen.getByPlaceholderText('输入网址') as HTMLInputElement).value).toBe('https://example.com/landing')
    expect(screen.getByTitle('Example Domain')).toBeTruthy()
  })

  it('shows a main-frame load failure with retry instead of pretending success', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    const el = webviews(container)[0]
    el.reload = vi.fn()
    guest(el, 'did-fail-load', {
      errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://example.com', isMainFrame: true
    })
    expect(container.textContent).toContain('页面加载失败')
    expect(container.textContent).toContain('ERR_NAME_NOT_RESOLVED')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(el.reload).toHaveBeenCalledOnce()
  })

  it('ignores subframe failures and aborted loads', () => {
    harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    const el = webviews(container)[0]
    guest(el, 'did-fail-load', {
      errorCode: -3, errorDescription: 'ERR_ABORTED', validatedURL: 'https://example.com', isMainFrame: true
    })
    guest(el, 'did-fail-load', {
      errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://cdn.example', isMainFrame: false
    })
    expect(container.textContent).not.toContain('页面加载失败')
  })
})

describe('browser pane facts (issue 107)', () => {
  it('records each denied permission ask as its own visible line', () => {
    const { emit } = harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    emit({ kind: 'permission', permission: 'geolocation', origin: 'https://maps.example' })
    emit({ kind: 'permission', permission: 'unknown-perm', origin: '' })
    expect(container.textContent).toContain('已拒绝「地理位置」权限请求（https://maps.example）')
    expect(container.textContent).toContain('已拒绝「unknown-perm」权限请求')
  })

  it('reports the download phases against the authorized folder', () => {
    const { emit } = harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    emit({ kind: 'download', phase: 'started', filename: 'result.csv' })
    emit({ kind: 'download', phase: 'completed', filename: 'result.csv' })
    emit({ kind: 'download', phase: 'rejected', filename: 'x.bin', reason: 'WORKSPACE_UNCONFIRMED' })
    expect(container.textContent).toContain('result.csv 开始下载（存入授权文件夹）')
    expect(container.textContent).toContain('result.csv 下载完成（已存入授权文件夹）')
    expect(container.textContent).toContain('x.bin 下载被拒绝：未确认授权文件夹，已取消')
  })

  it('opens a window-open fact as a tab in the owning pane only', () => {
    const { emit } = harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    const el = webviews(container)[0]
    el.getWebContentsId = () => 42
    emit({ kind: 'window-open', contentsId: 42, url: 'https://popup.example/target' })
    const attached = webviews(container)
    expect(attached).toHaveLength(2)
    expect(attrs(attached[1])['src']).toBe('https://popup.example/target')
    // 非本窗格的 contentsId：不产生任何页签或提示
    emit({ kind: 'window-open', contentsId: 99, url: 'https://elsewhere.example' })
    expect(webviews(container)).toHaveLength(2)
    expect(container.textContent).not.toContain('elsewhere.example')
  })

  it('does not open a tab from a non-web window-open fact', () => {
    const { emit } = harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    webviews(container)[0].getWebContentsId = () => 42
    emit({ kind: 'window-open', contentsId: 42, url: '' })
    expect(webviews(container)).toHaveLength(1)
  })

  it('resets every tab to the start page after the partition clear', async () => {
    const { emit } = harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    typeAddress(container, 'example.com')
    expect(webviews(container)).toHaveLength(1)
    emit({ kind: 'cleared' })
    await waitFor(() => expect(webviews(container)).toHaveLength(0))
    expect(container.textContent).toContain('浏览器起始页')
    expect(container.textContent).toContain('浏览器分区已清空，页签已回到起始页')
  })

  it('routes the clear action through the trusted main-process dialog entry', () => {
    const { browser } = harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    fireEvent.click(screen.getByRole('button', { name: '清空分区' }))
    expect(browser).toHaveBeenCalledWith({ action: 'clear' })
    expect(container.textContent).toContain('清空分区需在确认对话框中确认')
  })

  it('dismisses notice lines without touching the facts themselves', () => {
    const { emit } = harness()
    const { container } = render(<BrowserPane instanceId="inst-1" panelType="browser" />)
    emit({ kind: 'permission', permission: 'notifications', origin: 'https://news.example' })
    const line = screen.getByText(/已拒绝「通知」权限请求（https:\/\/news\.example）/)
    fireEvent.click(line)
    expect(container.textContent).not.toContain('已拒绝「通知」权限请求')
  })
})

// @vitest-environment jsdom
// Issue 109: the remote browser pane's visible contract. The location marker
// 远端 is permanent, failures are honest (a refused navigation is reported,
// never retried or fallen back), remote downloads say they live on the server
// and reach this device only through the explicit per-file retrieval, and the
// pane renders pixels — never an embedded-content seam.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import RemoteBrowserPane from '../src/renderer/src/dock/panels/remoteBrowserPane'
import type { ChatSnapshot, DesktopBridge, RemoteBrowserCommand, RemoteBrowserEvent } from '../src/shared/desktop'

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

function chatStateWith(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    scope: 'scope-1',
    thread: { id: 'th-1', status: 'idle', agentId: 'a1', skillId: '' },
    artifacts: [{ artifact_id: 'af1', name: 'shot.png', sha256: 'a'.repeat(64), bytes: 12 }],
    resources: [], threads: [], messages: [], events: [], run: null, subagents: [],
    stream: 'idle', error: '',
    ...overrides
  } as ChatSnapshot
}

interface Harness {
  chat: ReturnType<typeof vi.fn>
  remoteBrowser: ReturnType<typeof vi.fn>
  emit: (event: RemoteBrowserEvent) => void
  calls: RemoteBrowserCommand[]
}

function harness(state: ChatSnapshot | { error: string }, openResult: { streamId: string } | Error = { streamId: 'st-1' }): Harness {
  const calls: RemoteBrowserCommand[] = []
  let listener: ((event: RemoteBrowserEvent) => void) | null = null
  const chat = vi.fn(async () => state)
  const remoteBrowser = vi.fn(async (command: RemoteBrowserCommand) => {
    calls.push(command)
    if (openResult instanceof Error) throw openResult
    if (command.action === 'open') return openResult
    if (command.action === 'retrieve') return { status: 'saved' }
    return { acknowledged: true }
  })
  const api = {
    chat,
    remoteBrowser,
    onRemoteBrowserEvents: (push: (event: RemoteBrowserEvent) => void) => {
      listener = push
      return () => { listener = null }
    }
  }
  return {
    ...api,
    chat, remoteBrowser, calls,
    emit: (event) => listener?.(event)
  }
}

function pane(h: Harness): ReturnType<typeof render> {
  return render(<RemoteBrowserPane instanceId="inst-rb" panelType="browser" api={h as never} />)
}

describe('remote browser location marking (issue 109)', () => {
  it('marks the pane 远端 permanently and explains the location difference', () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    expect(view.getByText('远端')).toBeTruthy()
    expect(view.getByText(/平台服务器网络（隔离沙箱）/)).toBeTruthy()
    expect(view.getByText(/不会自动落到本机/)).toBeTruthy()
  })

  it('states honestly that a platform session is required before any browsing', async () => {
    const h = harness(chatStateWith({ thread: null }))
    const view = pane(h)
    await waitFor(() => expect(view.getByText(/请先在对话面板打开一个平台会话/)).toBeTruthy())
    expect(h.chat).toHaveBeenCalledWith({ action: 'state' })
  })

  it('shows the login requirement instead of a fake surface when the runtime refuses', async () => {
    const h = harness({ error: 'CHAT_UNAUTHENTICATED' })
    const view = pane(h)
    await waitFor(() => expect(view.getByText(/需要先登录平台/)).toBeTruthy())
  })

  it('never renders an embedded-content element', () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    expect(view.container.querySelector('webview, iframe, object, embed')).toBeNull()
  })
})

describe('remote browser stream lifecycle (issue 109)', () => {
  it('connects to the snapshot thread and reports the stream state', async () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    await waitFor(() => expect(view.getByText('连接远端会话')).toBeTruthy())
    fireEvent.click(view.getByText('连接远端会话'))
    await waitFor(() => expect(h.remoteBrowser).toHaveBeenCalledWith({ action: 'open', threadId: 'th-1', scope: 'scope-1' }))
    h.emit({ kind: 'state', state: 'open' })
    await waitFor(() => expect(view.getByText(/远端会话已连接/)).toBeTruthy())
    // antd inserts a space between two CJK button characters ("断 开").
    fireEvent.click(view.getByText(/断\s*开/))
    await waitFor(() => expect(h.remoteBrowser).toHaveBeenCalledWith({ action: 'close' }))
  })

  it('surfaces an open refusal honestly', async () => {
    const h = harness(chatStateWith(), new Error('REMOTE_BROWSER_UNAUTHENTICATED'))
    const view = pane(h)
    await waitFor(() => expect(view.getByText('连接远端会话')).toBeTruthy())
    fireEvent.click(view.getByText('连接远端会话'))
    await waitFor(() => expect(view.getByText(/远端登录态失效/)).toBeTruthy())
  })

  it('feeds frames to the pixel surface and follows the server url', async () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    await waitFor(() => expect(view.getByText('连接远端会话')).toBeTruthy())
    fireEvent.click(view.getByText('连接远端会话'))
    h.emit({ kind: 'url', url: 'https://example.test/page' })
    h.emit({ kind: 'frame', data: 'aGVsbG8=' })
    await waitFor(() => {
      const surface = view.container.querySelector('img[data-remote-screen="true"]') as HTMLImageElement | null
      expect(surface).toBeTruthy()
      expect(surface!.src).toBe('data:image/jpeg;base64,aGVsbG8=')
    })
    const address = view.container.querySelector('input[type="text"]') as HTMLInputElement
    expect(address.value).toBe('https://example.test/page')
  })

  it('reports a refused navigation as a location difference without fallback', async () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    await waitFor(() => expect(view.getByText('连接远端会话')).toBeTruthy())
    fireEvent.click(view.getByText('连接远端会话'))
    h.emit({ kind: 'state', state: 'open' })
    h.emit({ kind: 'url', url: 'https://example.test/' })
    h.emit({ kind: 'nav-rejected', url: 'https://intranet.test/secret', message: 'host not allowed' })
    await waitFor(() => expect(view.getByText(/远端无法访问该地址/)).toBeTruthy())
    expect(view.getByText(/intranet\.test\/secret/)).toBeTruthy()
    expect(view.getByText(/host not allowed/)).toBeTruthy()
  })

  it('maps the platform close codes to honest reasons', async () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    await waitFor(() => expect(view.getByText('连接远端会话')).toBeTruthy())
    fireEvent.click(view.getByText('连接远端会话'))
    h.emit({ kind: 'state', state: 'closed', code: 4404, category: 'THREAD_UNAVAILABLE' })
    await waitFor(() => expect(view.getByText(/远端会话已关闭：该 Thread 不可用、不属于当前账号，或平台浏览器能力未开启（4404）/)).toBeTruthy())
  })

  it('forwards typed navigation and pointer input through the bridge only', async () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    await waitFor(() => expect(view.getByText('连接远端会话')).toBeTruthy())
    fireEvent.click(view.getByText('连接远端会话'))
    h.emit({ kind: 'state', state: 'open' })
    const address = view.container.querySelector('input[type="text"]') as HTMLInputElement
    fireEvent.change(address, { target: { value: 'example.org/page' } })
    // antd v5 binds onPressEnter to the input's keydown.
    fireEvent.keyDown(address, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(h.remoteBrowser).toHaveBeenCalledWith({ action: 'input', event: { type: 'navigate', url: 'https://example.org/page' } }))
    h.emit({ kind: 'frame', data: 'aGVsbG8=' })
    await waitFor(() => expect(view.container.querySelector('img[data-remote-screen="true"]')).toBeTruthy())
    const surface = view.container.querySelector('img[data-remote-screen="true"]')!
    fireEvent.mouseMove(surface, { clientX: 8, clientY: 4 })
    await waitFor(() => expect(h.remoteBrowser).toHaveBeenCalledWith({ action: 'input', event: { type: 'move', x: 8, y: 4 } }))
  })
})

describe('remote browser explicit downloads (issue 109)', () => {
  it('says files land on the server and retrieves only on the explicit step', async () => {
    const h = harness(chatStateWith())
    const view = pane(h)
    await waitFor(() => expect(view.getByText(/下载发生在远端/)).toBeTruthy())
    expect(view.getByText('shot.png')).toBeTruthy()
    fireEvent.click(view.getByText('取回到本机'))
    await waitFor(() => expect(h.remoteBrowser).toHaveBeenCalledWith({ action: 'retrieve', threadId: 'th-1', artifactId: 'af1', scope: 'scope-1' }))
    await waitFor(() => expect(view.getByText(/已取回/)).toBeTruthy())
  })

  it('shows the refusal when the platform rejects the retrieval', async () => {
    const h = harness(chatStateWith())
    h.remoteBrowser.mockRejectedValueOnce(new Error('CHAT_ARTIFACT_NOT_FOUND'))
    const view = pane(h)
    await waitFor(() => expect(view.getByText('取回到本机')).toBeTruthy())
    fireEvent.click(view.getByText('取回到本机'))
    await waitFor(() => expect(view.getByText(/平台拒绝取回：CHAT_ARTIFACT_NOT_FOUND/)).toBeTruthy())
  })
})

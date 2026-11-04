// @vitest-environment jsdom
// Issue 94: the restored FilePanel — read-only human browsing over the
// confirmed workspace. These pin the honest empty states, the guarded tree,
// the bounded text/image previews and the external open/reveal actions, and
// keep the surface free of write affordances, approval machinery and any
// embedded-content seam.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import FilePanel from '../src/renderer/src/components/FilePanel'
import { useDockStore } from '../src/renderer/src/dock/dockStore'
import type { DesktopBridge, DesktopStatus, FilesCommand, FilesListView } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  const backing = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => void backing.clear()
  }
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const statusWith = (runtime: Partial<DesktopStatus['runtime']>): DesktopStatus => ({
  version: '0.2.0', server: 'connected',
  runtime: { process: 'running', connection: 'connected', tasks: [], ...runtime }
} as DesktopStatus)

const readyStatus = statusWith({
  login: { state: 'authenticated' } as never,
  workspace: { state: 'ready', logicalRoot: '/workspace/abc' }
})

function harness(overrides: { status?: DesktopStatus; onFiles?: (command: FilesCommand) => Promise<unknown> } = {}): {
  calls: FilesCommand[]
  api: Pick<DesktopBridge, 'files' | 'getStatus'>
} {
  const calls: FilesCommand[] = []
  const api = {
    getStatus: vi.fn(async () => overrides.status ?? readyStatus),
    files: vi.fn(async (command: FilesCommand) => {
      calls.push(command)
      if (overrides.onFiles) return overrides.onFiles(command)
      if (command.action === 'list') {
        const view: FilesListView = {
          entries: [
            { name: 'src', kind: 'dir', size: 0 },
            { name: 'README.md', kind: 'file', size: 9 }
          ], truncated: false
        }
        return view
      }
      return { kind: 'text', content: '', truncated: false }
    })
  }
  return { calls, api: api as unknown as Pick<DesktopBridge, 'files' | 'getStatus'> }
}

/** antd attaches selection to the node content wrapper, not the title text. */
function clickNode(view: ReturnType<typeof render>, name: string): void {
  const node = view.container.querySelector(`.ant-tree-node-content-wrapper[title="${name}"]`) ??
    view.getByText(name)
  fireEvent.click(node)
}

describe('FilePanel readiness states (issue 94)', () => {
  it('shows the honest guidance and opens the runtime pane while no workspace is bound', async () => {
    const { api } = harness({ status: statusWith({ login: { state: 'authenticated' } as never, workspace: { state: 'unavailable', logicalRoot: '' } }) })
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('文件树尚未就绪')).toBeTruthy())
    expect(view.getByText('尚未选择并确认工作目录。人工浏览不触发任何审批；Agent 取材仍走既有审批。')).toBeTruthy()
    const before = useDockStore.getState().layout
    fireEvent.click(view.getByText('打开「本机 Runtime」面板'))
    expect(useDockStore.getState().layout).not.toBe(before)
  })

  it('guides to the runtime pane when the runtime process is not running', async () => {
    const { api } = harness({ status: statusWith({ process: 'stopped' }) })
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('本机 Runtime 未运行；文件树浏览绑定在已确认的工作目录上。')).toBeTruthy())
  })
})

describe('FilePanel tree and read-only preview (issue 94)', () => {
  it('lists the confirmed workspace root with directories first and names the logical root', async () => {
    const { api } = harness()
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('src')).toBeTruthy())
    expect(view.getByText('README.md')).toBeTruthy()
    expect(view.getByText(/工作目录 \/workspace\/abc/)).toBeTruthy()
    const listCalls = (api.files as ReturnType<typeof vi.fn>).mock.calls as [FilesCommand][]
    expect(listCalls[0][0]).toEqual({ action: 'list', path: '/workspace/abc' })
  })

  it('previews a selected text file as read-only text', async () => {
    const { api } = harness({ onFiles: async (command) => {
      if (command.action === 'read') return { kind: 'text', content: '# hello', truncated: false }
      return { entries: [{ name: 'README.md', kind: 'file', size: 9 }], truncated: false } as FilesListView
    } })
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('README.md')).toBeTruthy())
    clickNode(view, 'README.md')
    await waitFor(() => expect(view.getByText('# hello')).toBeTruthy())
    expect((view.container.querySelector('iframe, webview'))).toBeNull()
  })

  it('says so instead of pretending when a capped text preview is truncated', async () => {
    const { api } = harness({ onFiles: async (command) => {
      if (command.action === 'read') return { kind: 'text', content: 'x', truncated: true }
      return { entries: [{ name: 'big.log', kind: 'file', size: 1048600 }], truncated: false } as FilesListView
    } })
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('big.log')).toBeTruthy())
    clickNode(view, 'big.log')
    await waitFor(() => expect(view.getByText('仅预览前 1.0 MB，完整内容请外部打开')).toBeTruthy())
  })

  it('renders an image preview from the guarded base64 reply', async () => {
    const { api } = harness({ onFiles: async (command) => {
      if (command.action === 'read') return { kind: 'image', mime: 'image/png', data: 'AAAA' }
      return { entries: [{ name: 'logo.png', kind: 'file', size: 3 }], truncated: false } as FilesListView
    } })
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('logo.png')).toBeTruthy())
    clickNode(view, 'logo.png')
    await waitFor(() => {
      const image = view.container.querySelector('img')
      expect(image?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    })
  })

  it('maps a binary rejection to the external-app hint without inventing content', async () => {
    const { api } = harness({ onFiles: async (command) => {
      if (command.action === 'read') return Promise.reject(new Error('FILE_BINARY'))
      return { entries: [{ name: 'blob.bin', kind: 'file', size: 9 }], truncated: false } as FilesListView
    } })
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('blob.bin')).toBeTruthy())
    clickNode(view, 'blob.bin')
    await waitFor(() => expect(view.getByText('二进制文件请用外部应用打开')).toBeTruthy())
  })
})

describe('FilePanel external actions and read-only guarantees (issue 94)', () => {
  it('resolves open and reveal through the trusted seam with logical paths only', async () => {
    const { calls, api } = harness()
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('README.md')).toBeTruthy())
    clickNode(view, 'README.md')
    await waitFor(() => expect(view.getByText('打开')).toBeTruthy())
    fireEvent.click(view.getByText('打开'))
    await waitFor(() => expect(calls.some((command) => command.action === 'open')).toBe(true))
    expect(calls.find((command) => command.action === 'open')?.path).toBe('/workspace/abc/README.md')
    fireEvent.click(view.getByText('定位'))
    await waitFor(() => expect(calls.some((command) => command.action === 'reveal')).toBe(true))
  })

  it('carries no write affordance, approval control or embedded-content seam', async () => {
    const { api } = harness()
    const view = render(<FilePanel instanceId="inst-files" panelType="files" api={api} />)
    await waitFor(() => expect(view.getByText('README.md')).toBeTruthy())
    const html = view.container.innerHTML
    expect(html).not.toMatch(/iframe|webview|textarea|上传|写入|编辑/)
    // The standing honest line names the split: humans are free, the Agent's
    // material-taking keeps its approval flow.
    expect(view.getByText(/人工浏览不触发审批 · Agent 取材仍走既有审批/)).toBeTruthy()
    expect((view.container.querySelector('iframe, webview, textarea'))).toBeNull()
  })
})

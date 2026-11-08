// @vitest-environment jsdom
// Issue 116: the field (仿真结果) pane's display contract over the #94
// guarded file-read seam. Zero new IPC channels: the renderer names a
// workspace-logical path, the Runtime's own guarded read answers, and the
// pane renders exactly the parsed structured IJK zones — with honest
// notices for truncation, skipped zones and non-finite values, and honest
// refusals for everything outside the original's subset.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FieldPane from '../src/renderer/src/dock/panels/fieldPane'
import { useDockStore } from '../src/renderer/src/dock/dockStore'
import type { DesktopStatus, FilesPreview } from '../src/shared/desktop'

afterEach(() => {
  cleanup()
  useDockStore.getState().clearAutoLoad('field')
})

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
  // jsdom has no ResizeObserver; the canvas view observes its wrapper box.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const pointFile = [
  'VARIABLES = "x" "y" "z" "p"',
  'ZONE T="slice" I=2 J=2 K=1 F=POINT',
  '0 0 0 1',
  '1 0 0 2',
  '0 1 0 3',
  '1 1 0 4'
].join('\n')

const twoZoneFile = pointFile + '\n' + [
  'ZONE T="upper" I=2 J=1 K=1 F=POINT',
  '0 0 1 10', '1 0 1 20'
].join('\n')

const runtimeStatus = (over: Partial<DesktopStatus['runtime']> = {}): DesktopStatus['runtime'] => ({
  process: 'running',
  login: { state: 'authenticated' },
  workspace: { state: 'ready', logicalRoot: 'C:/ws' },
  version: '', connection: { state: 'connected' }, pid: 0, startedAt: '',
  ...over
} as unknown as DesktopStatus['runtime'])

interface BridgeStub {
  getStatus: ReturnType<typeof vi.fn>
  files: ReturnType<typeof vi.fn>
}

function readyBridge(filesImpl?: BridgeStub['files']): BridgeStub {
  return {
    getStatus: vi.fn().mockResolvedValue({ runtime: runtimeStatus() } as unknown as DesktopStatus),
    files: filesImpl ?? vi.fn().mockResolvedValue({ kind: 'text', content: pointFile, truncated: false } as FilesPreview)
  }
}

function renderPane(api: BridgeStub): void {
  render(<FieldPane instanceId="field-1" panelType="field" api={api as never} />)
}

async function openPath(path = '/results/slice.dat'): Promise<void> {
  const input = await screen.findByPlaceholderText('Tecplot ASCII .dat 工作区路径，如 /results/slice.dat')
  fireEvent.change(input, { target: { value: path } })
  fireEvent.click(screen.getByRole('button', { name: '打开' }))
  await waitFor(() => expect(screen.getByLabelText('Zone 选择')).toBeTruthy())
}

describe('field pane display contract (#116)', () => {
  it('shows the honest workspace state when the runtime or workspace is not ready', async () => {
    const api = readyBridge()
    api.getStatus.mockResolvedValue({
      runtime: runtimeStatus({ workspace: { state: 'missing' } })
    } as unknown as DesktopStatus)
    renderPane(api)
    expect(await screen.findByText('仿真结果查看尚未就绪')).toBeTruthy()
    expect(screen.getByText(/确认工作目录/)).toBeTruthy()
    expect(screen.queryByPlaceholderText('Tecplot ASCII .dat 工作区路径，如 /results/slice.dat')).toBeNull()
  })

  it('loads a structured IJK file over the guarded read seam and exposes zone/variable facts', async () => {
    const api = readyBridge()
    renderPane(api)
    await openPath()
    expect(api.files).toHaveBeenCalledWith({ action: 'read', path: '/results/slice.dat' })
    expect((screen.getByLabelText('Zone 选择') as HTMLSelectElement).value).toBe('0')
    expect(screen.getByLabelText('Zone 选择').textContent).toContain('slice (2×2×1)')
    expect((screen.getByLabelText('变量选择') as HTMLSelectElement).value).toBe('p')
    expect((screen.getByLabelText('显示模式') as HTMLSelectElement).value).toBe('surface')
    // 色标如实给出活动变量的有限值范围
    const bar = screen.getByLabelText('色标范围')
    expect(bar.textContent).toContain('1')
    expect(bar.textContent).toContain('4')
  })

  it('switches zone and keeps the variable when still available', async () => {
    const api = readyBridge(vi.fn().mockResolvedValue({ kind: 'text', content: twoZoneFile, truncated: false } as FilesPreview))
    renderPane(api)
    await openPath()
    fireEvent.change(screen.getByLabelText('Zone 选择'), { target: { value: '1' } })
    await waitFor(() => expect((screen.getByLabelText('Zone 选择') as HTMLSelectElement).value).toBe('1'))
    expect(screen.getByLabelText('Zone 选择').textContent).toContain('upper (2×1×1)')
    expect((screen.getByLabelText('变量选择') as HTMLSelectElement).value).toBe('p')
  })

  it('announces a truncated read instead of passing the cut off as the whole file', async () => {
    const api = readyBridge(vi.fn().mockResolvedValue({ kind: 'text', content: pointFile, truncated: true } as FilesPreview))
    renderPane(api)
    await openPath()
    expect(screen.getByRole('status').textContent).toContain('文件超过预览上限，已按可完整解析的部分显示')
  })

  it('counts skipped zones and non-finite values with explicit notices', async () => {
    const mixed = pointFile + '\n' + [
      'ZONE T="fe" F=FEPOINT N=2 E=1 NV=4', '0 0 0 1', '1 0 0 2', 'a b', 'c d'
    ].join('\n')
    const api = readyBridge(vi.fn().mockResolvedValue({ kind: 'text', content: mixed, truncated: false } as FilesPreview))
    renderPane(api)
    await openPath()
    expect(screen.getByRole('status').textContent).toContain('1 个 zone 无法解析（子集外或数据不完整），未显示')
  })

  it('shows the honest empty result when nothing in the subset parsed', async () => {
    const api = readyBridge(vi.fn().mockResolvedValue({ kind: 'text', content: 'TITLE = "nothing"', truncated: false } as FilesPreview))
    renderPane(api)
    const input = await screen.findByPlaceholderText('Tecplot ASCII .dat 工作区路径，如 /results/slice.dat')
    fireEvent.change(input, { target: { value: '/results/x.dat' } })
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    await waitFor(() => expect(screen.getByText(/未能解析出 Zone/)).toBeTruthy())
    expect(screen.getByText(/仅支持结构化 IJK 的 Tecplot ASCII/)).toBeTruthy()
  })

  it('says both facts when a truncated read yields no complete zone at all', async () => {
    // 文件被 1 MiB 预览截断，最后一个 zone 体不完整：不能只报"文件坏了"。
    const cutFile = [
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=2 K=1 F=POINT',
      '0 0 0 1', '1 0 0 2', '0 1 0 3'
    ].join('\n')
    const api = readyBridge(vi.fn().mockResolvedValue({ kind: 'text', content: cutFile, truncated: true } as FilesPreview))
    renderPane(api)
    const input = await screen.findByPlaceholderText('Tecplot ASCII .dat 工作区路径，如 /results/slice.dat')
    fireEvent.change(input, { target: { value: '/results/big.dat' } })
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    await waitFor(() => expect(screen.getByText(/文件超过预览上限/)).toBeTruthy())
    expect(screen.getByText(/未能解析出完整的 Zone/)).toBeTruthy()
  })

  it('maps the guarded read error codes to honest sentences', async () => {
    const api = readyBridge(vi.fn().mockRejectedValue(new Error('FILE_BINARY')))
    renderPane(api)
    const input = await screen.findByPlaceholderText('Tecplot ASCII .dat 工作区路径，如 /results/slice.dat')
    fireEvent.change(input, { target: { value: '/results/x.dat' } })
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    await waitFor(() => expect(screen.getByText('二进制文件请用外部应用打开')).toBeTruthy())
  })

  it('refuses a zone without x/y/z coordinates instead of drawing a fake field', async () => {
    const badFile = [
      'VARIABLES = "a" "b" "c" "p"',
      'ZONE T="bad" I=2 J=1 K=1 F=POINT', '0 0 1 1', '0 0 1 1'
    ].join('\n')
    const api = readyBridge(vi.fn().mockResolvedValue({ kind: 'text', content: badFile, truncated: false } as FilesPreview))
    renderPane(api)
    await openPath()
    await waitFor(() => expect(screen.getByText(/该 zone 未识别到坐标变量/)).toBeTruthy())
  })

  it('announces non-finite values in the active variable', async () => {
    const infFile = [
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=1 K=1 F=POINT', '0 0 0 1e999', '1 0 0 2'
    ].join('\n')
    const api = readyBridge(vi.fn().mockResolvedValue({ kind: 'text', content: infFile, truncated: false } as FilesPreview))
    renderPane(api)
    await openPath()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 个非有限值'))
  })

  it('switches the display mode between the original three representations', async () => {
    const api = readyBridge()
    renderPane(api)
    await openPath()
    fireEvent.change(screen.getByLabelText('显示模式'), { target: { value: 'points' } })
    expect((screen.getByLabelText('显示模式') as HTMLSelectElement).value).toBe('points')
    fireEvent.change(screen.getByLabelText('显示模式'), { target: { value: 'wireframe' } })
    expect((screen.getByLabelText('显示模式') as HTMLSelectElement).value).toBe('wireframe')
  })

  it('auto-loads a pending result path once the workspace is ready (#117)', async () => {
    const api = readyBridge()
    useDockStore.getState().requestAutoLoad('field', '/results/auto.dat')
    renderPane(api)
    // The auto-load rides the very same guarded read seam as a hand-typed
    // path, shows in the input, and clears its pending entry afterwards.
    await waitFor(() => expect(api.files).toHaveBeenCalledWith({ action: 'read', path: '/results/auto.dat' }))
    expect((screen.getByLabelText('结果文件路径') as HTMLInputElement).value).toBe('/results/auto.dat')
    expect(screen.getByLabelText('Zone 选择').textContent).toContain('slice (2×2×1)')
    expect(useDockStore.getState().autoLoad.field).toBeUndefined()
    useDockStore.getState().clearAutoLoad('field')
  })
})

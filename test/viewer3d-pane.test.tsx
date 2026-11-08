// @vitest-environment jsdom
// Issue 115: the CAD pane's display contract. The pane renders only what the
// trusted channel returned — an unbound workspace is an explicit state, an
// over-cap or malformed model is the channel's honest refusal text, the
// loaded model's real size shows as stats, a WebGL failure falls back to the
// software 2D engine with an announcement, and no geometry-editing control
// exists anywhere. Issue 117: a pending auto-load path loads through the same
// channel once the workspace is ready, and never before.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CadMeshView, DesktopBridge, DesktopStatus } from '../src/shared/desktop'
import { useDockStore } from '../src/renderer/src/dock/dockStore'
import Viewer3dPane from '../src/renderer/src/dock/panels/viewer3dPane'

beforeEach(() => {
  window.matchMedia = window.matchMedia ?? ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  }))
  ;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver =
    class { observe() {} unobserve() {} disconnect() {} }
  window.IntersectionObserver = window.IntersectionObserver ??
    class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } root = null; rootMargin = ''; thresholds = [] } as unknown as typeof IntersectionObserver
})
afterEach(() => {
  cleanup()
  useDockStore.getState().clearAutoLoad('viewer3d')
})

const READY: DesktopStatus = {
  version: '0.0.0-test',
  server: { state: 'connected' } as DesktopStatus['server'],
  runtime: {
    process: 'running',
    tasks: [],
    login: { state: 'authenticated' } as DesktopStatus['runtime']['login'],
    workspace: { state: 'ready', logicalRoot: '/workspace' }
  } as DesktopStatus['runtime']
}

function meshView(): CadMeshView {
  return {
    format: 'stl',
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2]),
    stats: { meshes: 1, vertices: 3, triangles: 1 }
  }
}

interface Harness { cad: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn> }

function renderPane(cadImpl: Harness['cad'], statusImpl?: Harness['getStatus']): Harness {
  const api: Harness = {
    cad: cadImpl,
    getStatus: statusImpl ?? vi.fn(() => Promise.resolve(READY))
  }
  render(<Viewer3dPane instanceId="inst-1" panelType="viewer3d" api={api as unknown as Pick<DesktopBridge, 'cad' | 'getStatus'>} />)
  return api
}

async function openPath(path: string, api: Harness, impl: () => Promise<CadMeshView>): Promise<void> {
  api.cad.mockImplementation(impl)
  // The readiness poll is async; wait for the ready state's input to exist.
  const input = await screen.findByLabelText('模型逻辑路径', {}, { timeout: 2000 })
  fireEvent.change(input, { target: { value: path } })
  fireEvent.click(screen.getByRole('button', { name: /打开/ }))
  await waitFor(() => expect(api.cad).toHaveBeenCalledWith({ action: 'read-mesh', path }))
}

describe('viewer3d pane (#115)', () => {
  it('states the unbound workspace honestly and offers the runtime pane', () => {
    const getStatus = vi.fn(() => Promise.resolve({
      version: '0.0.0-test', server: { state: 'connected' }, runtime: { process: 'stopped', tasks: [] }
    } as unknown as DesktopStatus))
    const cad = vi.fn()
    renderPane(cad, getStatus)
    expect(screen.getByText('三维模型查看器待工作目录就绪')).toBeTruthy()
    expect(screen.getByText('本机 Runtime 未运行；三维查看绑定在已确认的工作目录上。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开「本机 Runtime」面板' })).toBeTruthy()
    expect(screen.queryByLabelText('模型逻辑路径')).toBeNull()
    expect(cad).not.toHaveBeenCalled()
  })

  it('opens a model and shows the real size facts', async () => {
    const api = renderPane(vi.fn())
    await openPath('/workspace/parts/bracket.stl', api, () => Promise.resolve(meshView()))
    await waitFor(() => expect(screen.getByText(/STL · 部件 1 · 顶点 3 · 三角面 1/)).toBeTruthy())
  })

  it("renders the channel's refusal codes as their honest sentences", async () => {
    const api = renderPane(vi.fn())
    await openPath('/workspace/parts/huge.stl', api, () => Promise.reject(new Error("CAD_MESH_TOO_LARGE")))
    await waitFor(() => expect(screen.getByText('模型三角面数超出查看器 1,000,000 上限（软渲染预算），未显示')).toBeTruthy())
    cleanup()
    const api2 = renderPane(vi.fn())
    await openPath('/workspace/parts/part.step', api2, () => Promise.reject(new Error("CAD_STEP_PARSE_FAILED: AP214 不支持")))
    await waitFor(() => expect(screen.getByText('STEP 解析失败（可能是不支持的 ASCII/AP 版本或文件损坏）')).toBeTruthy())
  })

  it('falls back to the software 2D engine when WebGL cannot be created', async () => {
    const api = renderPane(vi.fn())
    await openPath('/workspace/parts/bracket.stl', api, () => Promise.resolve(meshView()))
    // jsdom has no WebGL: the three.js engine fails, onFail switches the
    // engine, and the canvas 2D surface (announced, not silent) takes over.
    // The WebGL attempt is timing-sensitive; parallel suites routinely push
    // it past the 1s default, so these waits carry real headroom (the flake
    // predates #117 — reproducible on bare develop under load).
    await waitFor(() => expect(screen.getByText('WebGL 不可用，已切换到软件渲染')).toBeTruthy(), { timeout: 8000 })
    await waitFor(() => expect(document.querySelector('canvas')).toBeTruthy(), { timeout: 8000 })
  })

  it('never calls the channel for an empty path', async () => {
    const api = renderPane(vi.fn())
    await screen.findByLabelText('模型逻辑路径', {}, { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: /打开/ }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.cad).not.toHaveBeenCalled()
    expect(screen.getByText('输入工作目录内模型路径后点「打开」')).toBeTruthy()
  })

  it('keeps the read-only discipline line and no editing control', async () => {
    renderPane(vi.fn())
    await screen.findByLabelText('模型逻辑路径', {}, { timeout: 2000 })
    expect(screen.getByText('只读查看 · 大模型按上限如实拒绝 · 几何编辑不在范围')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /导出|编辑|删除|保存/ })).toBeNull()
  })

  it('auto-loads a pending result path once the workspace is ready (#117)', async () => {
    useDockStore.getState().requestAutoLoad('viewer3d', '/workspace/parts/auto.stl')
    const api = renderPane(vi.fn(() => Promise.resolve(meshView())))
    await waitFor(() => expect(api.cad).toHaveBeenCalledWith({ action: 'read-mesh', path: '/workspace/parts/auto.stl' }))
    // The pane takes the path over: the input shows it and the pending entry clears.
    await waitFor(() => expect((screen.getByLabelText('模型逻辑路径') as HTMLInputElement).value).toBe('/workspace/parts/auto.stl'))
    expect(useDockStore.getState().autoLoad.viewer3d).toBeUndefined()
    useDockStore.getState().clearAutoLoad('viewer3d')
  })

  it('keeps a pending auto-load path while the workspace is not ready (#117)', async () => {
    useDockStore.getState().requestAutoLoad('viewer3d', '/workspace/parts/wait.stl')
    const getStatus = vi.fn(() => Promise.resolve({
      version: '0.0.0-test', server: { state: 'connected' },
      runtime: { process: 'running', tasks: [], login: { state: 'authenticated' }, workspace: { state: 'missing' } }
    } as unknown as DesktopStatus))
    const api = renderPane(vi.fn(), getStatus)
    await screen.findByText('三维模型查看器待工作目录就绪', {}, { timeout: 2000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Firing early would only burn the one shot on an unbound-workspace
    // refusal, so the path waits until a ready workspace consumes it.
    expect(api.cad).not.toHaveBeenCalled()
    expect(useDockStore.getState().autoLoad.viewer3d).toBe('/workspace/parts/wait.stl')
    useDockStore.getState().clearAutoLoad('viewer3d')
  })
})

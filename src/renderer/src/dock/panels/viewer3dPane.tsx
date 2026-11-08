// Issue 115: the CAD pane — the dock's 三维模型 viewer over the confirmed
// workspace. The renderer names one workspace-logical model file; the trusted
// main process resolves it through the Runtime's own gate, converts it (OCCT
// for STEP, local readers for STL/OBJ) and returns one bounded mesh payload.
// The pane renders exactly that geometry with two honest engines — three.js
// WebGL, or the software 2D canvas when WebGL cannot be created — and refuses
// to invent anything: caps, parse failures and an unbound workspace are all
// explicit states, the loaded model's real size is shown as stats, and
// geometry editing (out of scope by issue) has no control here. Issue 117:
// the conversation→pane auto-load command is part of this surface — a task
// result inside the current workspace grant opens this pane and loads its
// file through the same trusted channel as a hand-typed path; nothing about
// authorization or upload changes.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Select, Spin, Typography, message } from 'antd'
import { FolderOpenOutlined, PlayCircleOutlined } from '@ant-design/icons'
import type { CadMeshView, DesktopBridge, DesktopStatus } from '../../../../shared/desktop'
import { CAD_MAX_FILE_BYTES, CAD_MAX_TRIANGLES } from '../../../../shared/desktop'
import { useDockStore } from '../dockStore'
import ThreeMeshViewer, { type CadRepresentation } from './viewer3d/ThreeMeshViewer'
import MeshCanvasViewer from './viewer3d/MeshCanvasViewer'

type CadApi = Pick<DesktopBridge, 'cad' | 'getStatus'>
type CadEngine = 'three' | 'canvas'

const formatMegabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`
const formatCount = (count: number): string => count.toLocaleString('en-US')

/** Refusal texts built from the shared cap constants, so the pane never
 * states a limit the trusted service does not enforce. */
const CAD_ERROR_TEXT: Record<string, string> = {
  CAD_FORMAT_UNSUPPORTED: '不支持的文件类型；三维窗格仅打开 .stl / .obj / .stp / .step',
  CAD_FILE_TOO_LARGE: `文件超出查看器 ${formatMegabytes(CAD_MAX_FILE_BYTES)} 上限，未读取`,
  CAD_MESH_TOO_LARGE: `模型三角面数超出查看器 ${formatCount(CAD_MAX_TRIANGLES)} 上限（软渲染预算），未显示`,
  CAD_EMPTY_GEOMETRY: '文件中没有可显示的几何',
  CAD_NOT_FOUND: '文件不存在或已被移动',
  CAD_NOT_A_FILE: '路径不是文件',
  CAD_READ_FAILED: '读取文件失败，请重试',
  CAD_OCCT_UNAVAILABLE: 'OpenCASCADE 转换引擎不可用（未随包或加载失败）',
  CAD_STEP_PARSE_FAILED: 'STEP 解析失败（可能是不支持的 ASCII/AP 版本或文件损坏）',
  CAD_MALFORMED_GEOMETRY: '模型数据包含无效坐标或结构',
  CAD_FACE_INDEX_INVALID: '模型的面索引无法解析',
  CAD_COMMAND_INVALID: '命令格式无效',
  FILES_PATH_INVALID: '路径格式无效',
  WORKSPACE_UNAVAILABLE: '工作目录已失效，请在本机 Runtime 面板重新选择并确认',
  FILES_BUSY: '请求太多，请稍候再试',
  FILES_TIMEOUT: '读取超时，请重试'
}

/** Stable-code lookup; structured failures keep their detail after the code. */
function cadErrorText(raw: string): string {
  for (const key of Object.keys(CAD_ERROR_TEXT)) {
    if (raw === key || raw.startsWith(`${key}:`)) return CAD_ERROR_TEXT[key]
  }
  return '无法打开该模型'
}

const REPRESENTATION_OPTIONS: Array<{ value: CadRepresentation; label: string }> = [
  { value: 'surface', label: '实体' },
  { value: 'wireframe', label: '线框' },
  { value: 'points', label: '点云' }
]

const ENGINE_OPTIONS: Array<{ value: CadEngine; label: string }> = [
  { value: 'three', label: 'Three 3D' },
  { value: 'canvas', label: '软件 2D' }
]

interface ViewerState {
  loading: boolean
  mesh?: CadMeshView
  error?: string
}

function Viewer3dView({ mesh, representation, engine, onEngineFail }: {
  mesh: CadMeshView
  representation: CadRepresentation
  engine: CadEngine
  onEngineFail: () => void
}): JSX.Element {
  const stats = mesh.stats
  const statsLine = `部件 ${stats.meshes} · 顶点 ${stats.vertices.toLocaleString()} · 三角面 ${stats.triangles.toLocaleString()}`
  return <div className="flex-1 min-h-0 relative">
    {engine === 'three'
      ? <ThreeMeshViewer positions={mesh.positions} indices={mesh.indices} representation={representation} onFail={onEngineFail} />
      : <MeshCanvasViewer positions={mesh.positions} indices={mesh.indices} representation={representation} />}
    <div className="absolute left-2 bottom-2 px-2 py-1 rounded text-[11px] text-gray-300 pointer-events-none"
      style={{ background: 'rgba(23, 26, 34, 0.72)' }}>
      {mesh.format.toUpperCase()} · {statsLine}
    </div>
  </div>
}

export default function Viewer3dPane({ instanceId, panelType, api }: {
  instanceId: string
  panelType: string
  /** Injectable seam for headless tests; production uses the trusted bridge. */
  api?: CadApi
}): JSX.Element {
  // The production bridge reads stay direct calls (the graph test pins the
  // exact member names); tests inject the seam instead of mocking modules.
  const bridge: CadApi = api ?? {
    cad: (command) => window.ideer.cad(command),
    getStatus: () => window.ideer.getStatus()
  }
  void instanceId
  void panelType
  const openRuntimePane = useDockStore((state) => state.openPanelType)
  const [workspace, setWorkspace] = useState<DesktopStatus['runtime'] | null>(null)
  const [path, setPath] = useState('')
  const [representation, setRepresentation] = useState<CadRepresentation>('surface')
  const [engine, setEngine] = useState<CadEngine>('three')
  const [viewer, setViewer] = useState<ViewerState>({ loading: false })
  const requestSequence = useRef(0)
  // Engine switches are announced once; the ref keeps the fallback idempotent.
  const engineRef = useRef<CadEngine>('three')

  const workspaceReady = workspace?.process === 'running' &&
    workspace.login?.state === 'authenticated' && workspace.workspace?.state === 'ready'
  const logicalRoot = workspace?.workspace?.logicalRoot ?? ''

  useEffect(() => {
    let active = true
    const poll = (): void => {
      void bridge.getStatus().then((status: DesktopStatus) => {
        if (active) setWorkspace(status.runtime)
      }).catch(() => { /* keep the last honest state */ })
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [bridge])

  const open = useCallback(async (raw: string): Promise<void> => {
    const target = raw.trim()
    if (!target) return
    const sequence = ++requestSequence.current
    setViewer({ loading: true })
    try {
      const mesh = await bridge.cad({ action: 'read-mesh', path: target })
      if (sequence !== requestSequence.current) return
      setViewer({ loading: false, mesh })
    } catch (caught) {
      if (sequence !== requestSequence.current) return
      const rawCode = caught instanceof Error ? caught.message : 'CAD_READ_FAILED'
      setViewer({ loading: false, error: cadErrorText(rawCode) })
    }
  }, [bridge])

  const onEngineFail = useCallback((): void => {
    // WebGL context creation failed: the honest fallback is the software 2D
    // engine, announced — never a black pane.
    if (engineRef.current !== 'three') return
    engineRef.current = 'canvas'
    void message.info('WebGL 不可用，已切换到软件渲染')
    setEngine('canvas')
  }, [])

  // Issue 117: consume a pending auto-load path once the workspace is ready —
  // earlier than that, the read would only burn the one shot on an unbound
  // workspace error, so a pending path waits here instead.
  const autoLoadPath = useDockStore((state) => state.autoLoad.viewer3d)
  const clearAutoLoad = useDockStore((state) => state.clearAutoLoad)
  useEffect(() => {
    if (!workspaceReady || !autoLoadPath) return
    setPath(autoLoadPath)
    void open(autoLoadPath)
    clearAutoLoad('viewer3d')
  }, [workspaceReady, autoLoadPath, open, clearAutoLoad])

  if (!workspaceReady) {
    return <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-6 text-center" style={{ background: 'var(--pane-bg, #F4F6FA)' }} data-instance={instanceId}>
      <div className="text-sm font-medium text-gray-700">三维模型查看器待工作目录就绪</div>
      <div className="max-w-md text-xs text-gray-500 leading-relaxed">
        {workspace?.process !== 'running'
          ? '本机 Runtime 未运行；三维查看绑定在已确认的工作目录上。'
          : workspace?.login?.state !== 'authenticated'
            ? '尚未登录并绑定设备；模型读取跟随工作目录授权。'
            : '尚未选择并确认工作目录。'}
      </div>
      <Button onClick={() => openRuntimePane('runtime')}>打开「本机 Runtime」面板</Button>
    </div>
  }

  return <div className="h-full w-full flex flex-col" data-instance={instanceId}>
    <div className="px-3 py-2 border-b border-gray-200 flex-shrink-0">
      <div className="flex gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onPressEnter={() => void open(path)}
          placeholder={logicalRoot ? `${logicalRoot}/parts/bracket.stl` : '/parts/bracket.stl'}
          prefix={<FolderOpenOutlined />}
          size="small"
          aria-label="模型逻辑路径"
        />
        <Button size="small" type="primary" icon={<PlayCircleOutlined />}
          loading={viewer.loading}
          onClick={() => void open(path)}>打开</Button>
        <Select<CadRepresentation> size="small" value={representation} options={REPRESENTATION_OPTIONS}
          onChange={(value) => setRepresentation(value)} style={{ width: 84 }} aria-label="显示方式" />
        <Select<CadEngine> size="small" value={engine} options={ENGINE_OPTIONS}
          onChange={(value) => { engineRef.current = value; setEngine(value) }} style={{ width: 96 }} aria-label="渲染引擎" />
      </div>
      <Typography.Text type="secondary" className="text-[10px] mt-1 leading-tight block">
        拖拽旋转 / 滚轮缩放 · STL / OBJ / STP / STEP · Three 黑屏时可切「软件 2D」
      </Typography.Text>
    </div>
    {viewer.loading
      ? <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2" style={{ background: '#171a22' }}>
          <Spin />
          <span className="text-xs text-gray-300">解析模型中…</span>
        </div>
      : viewer.error
        ? <div className="flex-1 min-h-0 flex items-center justify-center p-4" style={{ background: '#171a22' }}>
            <Alert className="max-w-md" type="info" showIcon message={viewer.error} />
          </div>
        : viewer.mesh
          ? <Viewer3dView mesh={viewer.mesh} representation={representation} engine={engine} onEngineFail={onEngineFail} />
          : <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-gray-400" style={{ background: '#171a22' }}>
              输入工作目录内模型路径后点「打开」
            </div>}
    <div className="px-3 py-1 border-t border-gray-200 text-[11px] text-gray-400">
      只读查看 · 大模型按上限如实拒绝 · 几何编辑不在范围
    </div>
  </div>
}

// Issue 116: the field pane — the original linz SolverResultsPanel restored
// on the Desktop's own seams. The renderer names a workspace-logical path
// only; reading rides the #94 guarded desktop:files seam (zero new IPC
// channels); parsing is the faithful Tecplot structured IJK ASCII subset
// (POINT/BLOCK); rendering is this pane's own no-WebGL software 2D engine
// (field/fieldCanvasModel + FieldCanvasView, the idiom also used by the CAD
// viewer under review in #151). Display modes stay the original three
// (实体/线框/点云) with the original blue→gray→red scalar coloring; everything
// outside the subset — FE zones, binary files, truncated reads, skipped
// zones, non-finite values — is announced, never faked. Issue 117: chat→pane
// auto-open is part of this surface — a task result inside the current
// workspace grant opens this pane and reads its file through the same
// guarded seam as a hand-typed path; upload and authorization stay untouched.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopBridge, DesktopStatus, FilesPreview } from '../../../../shared/desktop'
import { previewErrorText } from '../../components/FilePanel'
import { useDockStore } from '../dockStore'
import { useResultAutoLoad } from '../resultAutoOpen'
import { parseTecplotAscii, type ParsedTecplot } from './field/tecplotReader'
import {
  buildFieldGeometry, formatScalar, MAX_RENDER_POINTS, MAX_RENDER_QUADS,
  scalarBarGradient, scalarVariablesOf,
  type FieldGeometry, type FieldGeometryError, type FieldRepresentation
} from './field/fieldCanvasModel'
import FieldCanvasView from './field/FieldCanvasView'

type FilesApi = Pick<DesktopBridge, 'files' | 'getStatus'>

const REPRESENTATION_OPTIONS: Array<{ value: FieldRepresentation; label: string }> = [
  { value: 'surface', label: '实体' },
  { value: 'wireframe', label: '线框' },
  { value: 'points', label: '点云' }
]

interface LoadOutcome {
  parsed: ParsedTecplot
  truncated: boolean
}

export default function FieldPane({ instanceId, panelType, api }: {
  instanceId: string
  panelType: string
  /** Injectable seam for headless tests; production uses the trusted bridge. */
  api?: FilesApi
}): JSX.Element {
  const bridge: FilesApi = api ?? window.ideer
  // `instanceId`/`panelType` keep the dock pane signature; the field pane is
  // single-instance and stateless across restarts, so view state is
  // component-local on purpose.
  void instanceId
  void panelType
  const openRuntimePane = useDockStore((state) => state.openPanelType)
  const [workspace, setWorkspace] = useState<DesktopStatus['runtime'] | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [outcome, setOutcome] = useState<LoadOutcome | null>(null)
  const [zoneIndex, setZoneIndex] = useState(0)
  const [activeVar, setActiveVar] = useState('')
  const [rep, setRep] = useState<FieldRepresentation>('surface')
  const requestSequence = useRef(0)

  const workspaceReady = workspace?.process === 'running' &&
    workspace.login?.state === 'authenticated' && workspace.workspace?.state === 'ready'

  useEffect(() => {
    let active = true
    const poll = (): void => {
      void bridge.getStatus().then((status: DesktopStatus) => {
        if (active) setWorkspace(status.runtime)
      }).catch(() => { /* the pane keeps the last honest state */ })
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [bridge])

  const parsed = outcome?.parsed ?? null
  const scalarVars = parsed ? scalarVariablesOf(parsed.variables) : []
  const zones = parsed?.zones ?? []
  const zone = zones.length > 0 ? zones[Math.min(zoneIndex, zones.length - 1)] : null

  // 每个 (zone, 变量) 一次纯几何构建；错误按原版语义如实落到画布区。
  let geometry: FieldGeometry | null = null
  let geometryError: FieldGeometryError | null = null
  if (zone) {
    const built = buildFieldGeometry(zone, parsed!.variables, activeVar)
    if ('error' in built) geometryError = built.error
    else geometry = built
  }

  const load = useCallback(async (requested: string): Promise<void> => {
    const target = requested.trim()
    if (!target || busy) return
    const sequence = ++requestSequence.current
    setBusy(true)
    setLoadErr('')
    try {
      const view = await bridge.files({ action: 'read', path: target }) as FilesPreview
      if (sequence !== requestSequence.current) return
      if (view.kind !== 'text') {
        setLoadErr('二进制文件请用外部应用打开')
        setOutcome(null)
        return
      }
      const result = parseTecplotAscii(view.content)
      if (result.zones.length === 0) {
        // 截断读取可能一个完整 zone 都装不下：两个事实一起说，不冒充"文件坏了"。
        setLoadErr(view.truncated
          ? '文件超过预览上限（1 MiB），未能解析出完整的 Zone（仅支持结构化 IJK 的 Tecplot ASCII .dat）'
          : '未能解析出 Zone（仅支持结构化 IJK 的 Tecplot ASCII .dat）')
        setOutcome(null)
        return
      }
      const scalar = scalarVariablesOf(result.variables)
      setOutcome({ parsed: result, truncated: view.truncated })
      setZoneIndex(0)
      setActiveVar(scalar[0] ?? '')
      if (scalar.length === 0) {
        setLoadErr('未找到坐标 (x,y,z) 之外的标量变量，无着色数据可显示（原版以第 4 个变量起作标量着色）')
      }
    } catch (caught) {
      if (sequence !== requestSequence.current) return
      setLoadErr(previewErrorText(caught instanceof Error ? caught.message : 'FILES_FAILED'))
      setOutcome(null)
    } finally {
      if (sequence === requestSequence.current) setBusy(false)
    }
  }, [bridge, busy])

  const switchZone = useCallback((idx: number): void => {
    if (!parsed || idx < 0 || idx >= parsed.zones.length) return
    setZoneIndex(idx)
    const scalar = scalarVariablesOf(parsed.variables)
    if (!scalar.includes(activeVar)) setActiveVar(scalar[0] ?? '')
  }, [parsed, activeVar])

  // Issue 117: a task result inside the current workspace grant parks its
  // workspace-logical path here; it reads through the same guarded seam as a
  // hand-typed path once the workspace is ready and no load is in flight.
  const autoLoad = useCallback((target: string): void => {
    setPath(target)
    void load(target)
  }, [load])
  useResultAutoLoad('field', workspaceReady && !busy, autoLoad)

  if (!workspaceReady) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm font-medium text-gray-700">仿真结果查看尚未就绪</div>
        <div className="max-w-md text-xs text-gray-500 leading-relaxed">
          {workspace?.process !== 'running'
            ? '本机 Runtime 未运行；Tecplot 结果查看绑定在已确认的工作目录上。'
            : '请先登录并在本机 Runtime 面板确认工作目录，再在此打开结果文件。'}
        </div>
        <button
          type="button"
          className="text-xs text-blue-600 underline"
          onClick={() => openRuntimePane('runtime')}
        >
          打开本机 Runtime 面板
        </button>
      </div>
    )
  }

  const notices: string[] = []
  if (outcome?.truncated) notices.push('文件超过预览上限，已按可完整解析的部分显示。')
  if (parsed && parsed.zonesOmitted > 0) {
    notices.push(`${parsed.zonesOmitted} 个 zone 无法解析（子集外或数据不完整），未显示。`)
  }
  if (parsed && parsed.nonFiniteValues > 0) {
    notices.push(`文件内共 ${parsed.nonFiniteValues} 个非有限值（NaN/±Inf）。`)
  }
  if (geometry && geometry.nonFiniteActive > 0) {
    notices.push(`该 zone 有 ${geometry.nonFiniteActive} 个非有限值，按中点色显示。`)
  }
  if (geometry && geometry.layerQuadCount === 0 && rep !== 'points') {
    notices.push('该 zone 无 k=0 层网格面（需 I>1 且 J>1），请切换点云查看。')
  }
  if (geometry && geometry.layerQuadCount > MAX_RENDER_QUADS) {
    notices.push(`网格面数 ${geometry.layerQuadCount} 超出画布上限，实体/线框不可用（点云仍可显示）。`)
  }
  if (geometry && geometry.xyz.length / 3 > MAX_RENDER_POINTS && rep === 'points') {
    notices.push(`网格点数 ${geometry.xyz.length / 3} 超出画布上限，点云不可用（实体/线框仍可显示）。`)
  }

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 flex-shrink-0 space-y-1.5">
        <div className="flex gap-2">
          <input
            className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void load(path) }}
            placeholder="Tecplot ASCII .dat 工作区路径，如 /results/slice.dat"
            aria-label="结果文件路径"
            disabled={busy}
          />
          <button
            type="button"
            className="px-3 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-50"
            onClick={() => void load(path)}
            disabled={busy}
          >
            {busy ? '读取中…' : '打开'}
          </button>
        </div>
        {zones.length > 0 && (
          <div className="flex gap-2 items-center">
            <select
              className="flex-1 min-w-0 border border-gray-300 rounded px-1 py-1 text-xs"
              aria-label="Zone 选择"
              value={Math.min(zoneIndex, zones.length - 1)}
              onChange={(e) => switchZone(Number(e.target.value))}
            >
              {zones.map((z, i) => (
                <option key={`${z.name}-${i}`} value={i}>
                  {`${z.name} (${z.dims[0]}×${z.dims[1]}×${z.dims[2]})`}
                </option>
              ))}
            </select>
            <select
              className="flex-1 min-w-0 border border-gray-300 rounded px-1 py-1 text-xs"
              aria-label="变量选择"
              value={activeVar}
              onChange={(e) => setActiveVar(e.target.value)}
            >
              {scalarVars.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <select
              className="w-20 border border-gray-300 rounded px-1 py-1 text-xs"
              aria-label="显示模式"
              value={rep}
              onChange={(e) => setRep(e.target.value as FieldRepresentation)}
            >
              {REPRESENTATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}
        {notices.length > 0 && (
          <div role="status" className="text-[11px] text-amber-700 leading-relaxed space-y-0.5">
            {notices.map((n) => <div key={n}>{n}</div>)}
          </div>
        )}
        <p className="text-[10px] text-gray-400 leading-tight">
          结构化 IJK ASCII 子集（POINT/BLOCK）· 实体/线框/点云 + 标量色标 · FE/二进制等更广格式不支持
        </p>
      </div>
      <div className="flex-1 min-h-0 relative flex">
        <div className="flex-1 min-w-0 relative" style={{ background: '#171a22' }}>
          {loadErr !== '' && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300 p-4 text-center">
              {loadErr}
            </div>
          )}
          {loadErr === '' && geometryError === 'NO_COORDINATES' && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300 p-4 text-center">
              该 zone 未识别到坐标变量（x/y/z），暂无法显示
            </div>
          )}
          {loadErr === '' && geometryError === null && geometry && (
            <FieldCanvasView geom={geometry} representation={rep} />
          )}
        </div>
        {geometry && (
          <div
            className="w-14 flex-shrink-0 flex flex-col items-center justify-center py-2 gap-1 bg-gray-50 border-l border-gray-200"
            aria-label="色标范围"
          >
            <span className="text-[10px] text-gray-600">{formatScalar(geometry.range[1])}</span>
            <div
              className="flex-1 w-4 rounded-sm"
              style={{ background: scalarBarGradient() }}
            />
            <span className="text-[10px] text-gray-600">{formatScalar(geometry.range[0])}</span>
          </div>
        )}
      </div>
    </div>
  )
}

import { Alert, Button, Checkbox, Radio, Slider, Space, Typography } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KnowledgeGraphView, KnowledgeSimilarityView } from '../../../shared/desktop'
import {
  buildEntityGraph, buildSimilarityGraph, clampZoom, exportGraphPayload, screenToWorld,
  similarityStatusNames, WORLD_HEIGHT, WORLD_WIDTH, zoomAround, type GraphModel, type ScreenPoint, type ViewportState
} from './graphCanvasModel'

const statusNames: Record<KnowledgeSimilarityView['status'], string> = {
  completed: '计算完成',
  partial: '部分可算',
  failed: '无法计算'
}

export interface KnowledgeGraphCanvasProps {
  graph: KnowledgeGraphView | null
  similarity: KnowledgeSimilarityView | null
  busy: boolean
}

/**
 * Issue 99 交互画布：实体图（平台产物）与相似图（设备侧计算）共用一个
 * 可拖拽、可缩放、可筛选、可导出的画布。模型全部来自纯函数模块；视图
 * 只处理指针交互（背景拖拽平移、节点拖拽、滚轮缩放，滚轮走非被动监听，
 * 与 FieldCanvasView 的惯用法一致）。部分失败如实呈现：失败的文档仍是
 * 节点，并带各自的设备侧核验状态。
 */
export function KnowledgeGraphCanvas({ graph, similarity, busy }: KnowledgeGraphCanvasProps): JSX.Element {
  const [mode, setMode] = useState<'entities' | 'similarity'>(graph ? 'entities' : 'similarity')
  const [threshold, setThreshold] = useState(similarity?.threshold ?? 0.05)
  const [entityTypes, setEntityTypes] = useState<string[]>([])
  const [positions, setPositions] = useState<Record<string, ScreenPoint>>({})
  const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, scale: 1 })
  const [exportError, setExportError] = useState(false)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ kind: 'node' | 'pan'; id?: string; grabX: number; grabY: number } | null>(null)

  const entityModel = useMemo(() => (graph ? buildEntityGraph(graph) : null), [graph])
  const similarityModel = useMemo(() => (similarity ? buildSimilarityGraph(similarity, threshold) : null), [similarity, threshold])
  const model: GraphModel | null = mode === 'entities' ? entityModel : similarityModel
  const meta = mode === 'entities' ? graph : similarity

  const entityTypeOptions = useMemo(
    () => [...new Set((graph?.entities ?? []).map((entity) => entity.type || '').filter(Boolean))].sort(),
    [graph]
  )
  const visibleModel = useMemo(() => {
    if (!model) return null
    if (mode !== 'entities' || entityTypes.length === 0) return model
    const allowed = new Set(entityTypes)
    const nodes = model.nodes.filter((node) => allowed.has(node.group))
    const ids = new Set(nodes.map((node) => node.id))
    return { nodes, edges: model.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) }
  }, [model, mode, entityTypes])

  // 滚轮缩放：React 的 wheel 是被动监听，这里按仓库惯例走非被动原生监听。
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      setViewport((current) => zoomAround(current, { x: rect.left, y: rect.top }, { x: event.clientX, y: event.clientY }, event.deltaY))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const pointer = (event: React.PointerEvent): ScreenPoint => ({ x: event.clientX, y: event.clientY })
  const offset = (event: React.PointerEvent): ScreenPoint => {
    const rect = svgRef.current?.getBoundingClientRect()
    return { x: rect?.left ?? 0, y: rect?.top ?? 0 }
  }
  const startNodeDrag = (id: string) => (event: React.PointerEvent) => {
    if (busy || !visibleModel) return
    event.stopPropagation()
    const world = screenToWorld(viewport, offset(event), pointer(event))
    const node = visibleModel.nodes.find((item) => item.id === id)
    const current = positions[id] ?? (node ? { x: node.x, y: node.y } : { x: 0, y: 0 })
    dragRef.current = { kind: 'node', id, grabX: world.x - current.x, grabY: world.y - current.y }
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId)
    } catch {
      // 指针捕获失败不影响拖拽
    }
  }
  const startPan = (event: React.PointerEvent) => {
    const start = pointer(event)
    dragRef.current = { kind: 'pan', grabX: start.x - viewport.x, grabY: start.y - viewport.y }
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId)
    } catch {
      // 指针捕获失败不影响拖拽
    }
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'pan') {
      const start = pointer(event)
      setViewport((current) => ({ ...current, x: start.x - drag.grabX, y: start.y - drag.grabY }))
      return
    }
    if (!drag.id) return
    const world = screenToWorld(viewport, offset(event), pointer(event))
    setPositions((current) => ({ ...current, [drag.id as string]: { x: world.x - drag.grabX, y: world.y - drag.grabY } }))
  }
  const endDrag = () => {
    dragRef.current = null
  }

  const exportGraph = () => {
    if (!visibleModel || !meta) return
    try {
      const payload = exportGraphPayload({
        graphType: mode,
        kbId: meta.kbId,
        revisionId: meta.revisionId,
        revisionNo: meta.revisionNo,
        manifestHash: meta.manifestHash,
        status: meta.status,
        threshold: mode === 'similarity' ? threshold : undefined,
        model: visibleModel
      })
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `knowledge-graph-R${meta.revisionNo}-${mode}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setExportError(false)
    } catch {
      setExportError(true)
    }
  }

  const resetLayout = () => {
    setPositions({})
    setViewport({ x: 0, y: 0, scale: 1 })
  }

  const failedDocuments = (similarity?.documents ?? []).filter((document) => document.status !== 'matched')
  const usable = (similarity?.documents ?? []).filter((document) => document.status === 'matched').length

  return <div className="mt-3">
    <Space wrap className="mb-2">
      <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)} disabled={busy}>
        <Radio.Button value="entities" aria-label="实体图模式" disabled={!graph}>实体图</Radio.Button>
        <Radio.Button value="similarity" aria-label="相似图模式" disabled={!similarity}>相似图</Radio.Button>
      </Radio.Group>
      {mode === 'entities' && entityTypeOptions.length > 0 && <Checkbox.Group
        aria-label="按实体类型筛选" value={entityTypes} options={entityTypeOptions}
        disabled={busy} onChange={(values) => setEntityTypes(values as string[])} />}
      {mode === 'similarity' && similarity && <span className="flex items-center gap-2">
        <Typography.Text type="secondary">相似度阈值</Typography.Text>
        <Slider aria-label="相似度阈值" min={similarity.threshold} max={1} step={0.05}
          value={threshold} disabled={busy} onChange={(value) => setThreshold(value as number)}
          style={{ width: 160 }} />
        <Typography.Text type="secondary">{Math.round(threshold * 100)}%</Typography.Text>
      </span>}
      <Button aria-label="重置布局" disabled={busy} onClick={resetLayout}>重置布局</Button>
      <Button aria-label="导出当前图 JSON" disabled={busy || !visibleModel} onClick={exportGraph}>导出 JSON</Button>
    </Space>
    {mode === 'entities' && !graph && <Typography.Text type="secondary">尚未生成实体图：先对已登记版本执行「生成图谱」。</Typography.Text>}
    {mode === 'similarity' && !similarity && <Typography.Text type="secondary">尚未计算相似图：对已登记版本执行「生成相似图」，设备将在本机核验后计算。</Typography.Text>}
    {visibleModel && meta && <>
      <Typography.Paragraph className="mb-1" type="secondary">
        版本 R{meta.revisionNo} · {mode === 'entities' ? '' : `${statusNames[similarity!.status]} · 已核验 ${usable}/${similarity!.documents.length} · `}
        节点 {visibleModel.nodes.length} · 边 {visibleModel.edges.length}
        {mode === 'similarity' && similarity!.truncated ? ' · 边数已达设备上限，已如实截断' : ''}
      </Typography.Paragraph>
      {mode === 'similarity' && similarity!.status === 'partial' &&
        <Alert className="mb-2" type="warning" showIcon
          message="部分文档无法参与相似计算：缺失的文档不代表完整相似图"
          description={failedDocuments.map((document) => `${document.filename}（${similarityStatusNames[document.status]}）`).join('、')} />}
      {exportError && <Alert className="mb-2" type="warning" message="导出未完成：当前环境不支持下载" />}
      <svg ref={svgRef} role="img" aria-label={mode === 'entities' ? '实体关系图画布' : '文档相似图画布'}
        className="w-full cursor-grab select-none rounded border border-gray-200 bg-gray-50 active:cursor-grabbing"
        style={{ height: 420 }}
        viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
        onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <rect width={WORLD_WIDTH} height={WORLD_HEIGHT} fill="transparent"
          onPointerDown={startPan} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`}>
          {visibleModel.edges.map((edge) => {
            const source = positions[edge.source] ?? visibleModel.nodes.find((node) => node.id === edge.source)
            const target = positions[edge.target] ?? visibleModel.nodes.find((node) => node.id === edge.target)
            if (!source || !target) return null
            return <g key={edge.id}>
              <line x1={source.x} y1={source.y} x2={target.x} y2={target.y}
                stroke={mode === 'similarity' ? '#8fb8e8' : '#c9c9c9'}
                strokeWidth={mode === 'similarity' ? Math.max(1, edge.weight * 4) : 1.5} />
              <text x={(source.x + target.x) / 2} y={(source.y + target.y) / 2 - 4}
                textAnchor="middle" fontSize={11} fill="#666">{edge.label}</text>
            </g>
          })}
          {visibleModel.nodes.map((node) => {
            const point = positions[node.id] ?? node
            const failed = node.status !== undefined && node.status !== 'matched'
            return <g key={node.id} transform={`translate(${point.x},${point.y})`}
              className="cursor-move" onPointerDown={startNodeDrag(node.id)}>
              <circle r={16} fill={failed ? '#f5f5f5' : '#e6f0fb'}
                stroke={failed ? '#d9a441' : '#5a8fd6'} strokeWidth={1.5} />
              <text textAnchor="middle" dy={4} fontSize={11} fill="#333">
                {node.label.length > 12 ? `${node.label.slice(0, 11)}…` : node.label}
              </text>
              <text textAnchor="middle" y={30} fontSize={10} fill="#999">
                {mode === 'entities' ? (node.group || '未分类') : similarityStatusNames[node.status as keyof typeof similarityStatusNames] ?? node.group}
              </text>
            </g>
          })}
        </g>
      </svg>
      <Typography.Paragraph type="secondary" className="mt-1 mb-0">
        拖拽背景平移 · 滚轮缩放 · 拖动节点调整位置 · 筛选与导出只作用于当前显示的图
      </Typography.Paragraph>
    </>}
  </div>
}

import type { KnowledgeGraphView, KnowledgeSimilarityView } from '../../../shared/desktop'

/**
 * Issue 99 图谱画布的纯模型：建图、确定性布局、过滤与导出全部是纯函数，
 * 不触碰浏览器 API，与 field-canvas-model 的先例一致。视图组件只负责
 * 把这份模型画出来并处理拖拽/缩放交互。
 */

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 5

/** The world the layout positions into; the SVG scales to fit its width. */
export const WORLD_WIDTH = 900
export const WORLD_HEIGHT = 560

export interface GraphNode {
  id: string
  label: string
  group: string
  /** Similarity rows carry their device-side verification status. */
  status?: string
  x: number
  y: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  label: string
  weight: number
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface ExportGraphInput {
  graphType: 'entities' | 'similarity'
  kbId: string
  revisionId: string
  revisionNo: number
  manifestHash: string
  status: string
  /** Similarity exports carry the display threshold that produced the edges. */
  threshold?: number
  model: GraphModel
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

/** Pan (x, y) plus zoom, in the SVG's client-pixel space. */
export interface ViewportState { x: number; y: number; scale: number }
export interface ScreenPoint { x: number; y: number }

/** Client point → world point for the current viewport. */
export function screenToWorld(viewport: ViewportState, offset: ScreenPoint, point: ScreenPoint): ScreenPoint {
  return { x: (point.x - offset.x - viewport.x) / viewport.scale, y: (point.y - offset.y - viewport.y) / viewport.scale }
}

/** Wheel zoom that keeps the world point under the cursor stationary. */
export function zoomAround(viewport: ViewportState, offset: ScreenPoint, point: ScreenPoint, deltaY: number): ViewportState {
  const scale = clampZoom(viewport.scale * (deltaY < 0 ? 1.08 : 0.92))
  const world = screenToWorld(viewport, offset, point)
  return { scale, x: point.x - offset.x - world.x * scale, y: point.y - offset.y - world.y * scale }
}

/**
 * Deterministic layered layout: groups become clusters on a ring, members
 * sit on a small circle inside their cluster. Same input, same output —
 * no Math.random anywhere — so tests and snapshots stay stable.
 */
export function layoutGraph(nodes: GraphNode[]): GraphNode[] {
  const groups = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const bucket = groups.get(node.group) ?? []
    bucket.push(node)
    groups.set(node.group, bucket)
  }
  const names = [...groups.keys()].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
  const positioned = new Map<string, { x: number; y: number }>()
  const centerX = WORLD_WIDTH / 2
  const centerY = WORLD_HEIGHT / 2
  const clusterRadius = names.length > 1 ? Math.min(centerX, centerY) - 90 : 0
  names.forEach((name, groupIndex) => {
    const members = groups.get(name)!
    const clusterAngle = (2 * Math.PI * groupIndex) / names.length - Math.PI / 2
    const cx = centerX + clusterRadius * Math.cos(clusterAngle)
    const cy = centerY + clusterRadius * Math.sin(clusterAngle)
    if (members.length === 1) {
      positioned.set(members[0].id, { x: cx, y: cy })
      return
    }
    const memberRadius = 36 + 8 * members.length
    members.forEach((member, memberIndex) => {
      const angle = (2 * Math.PI * memberIndex) / members.length - Math.PI / 2
      positioned.set(member.id, {
        x: cx + memberRadius * Math.cos(angle),
        y: cy + memberRadius * Math.sin(angle)
      })
    })
  })
  return nodes.map((node) => ({ ...node, x: positioned.get(node.id)?.x ?? centerX, y: positioned.get(node.id)?.y ?? centerY }))
}

/**
 * 实体图：平台声明的实体各成一节点（同名去重、按类型分簇）；关系端点
 * 未被声明为实体时如实补为未分类节点，绝不静默丢边。
 */
export function buildEntityGraph(view: KnowledgeGraphView): GraphModel {
  const nodes = new Map<string, GraphNode>()
  for (const entity of view.entities) {
    if (!entity.name || nodes.has(entity.name)) continue
    nodes.set(entity.name, { id: entity.name, label: entity.name, group: entity.type || '', x: 0, y: 0 })
  }
  for (const relation of view.relations) {
    for (const endpoint of [relation.source, relation.target]) {
      if (!endpoint || nodes.has(endpoint)) continue
      nodes.set(endpoint, { id: endpoint, label: endpoint, group: '', x: 0, y: 0 })
    }
  }
  const edges: GraphEdge[] = view.relations.map((relation, index) => ({
    id: `relation-${index}`,
    source: relation.source,
    target: relation.target,
    label: relation.relation,
    weight: 1
  }))
  return { nodes: layoutGraph([...nodes.values()]), edges }
}

/**
 * 相似图：每个冻结文档都是节点（含失败的文档——缺失的文档不代表完整
 * 相似图），边是设备侧算好的候选集按展示阈值的过滤结果。
 */
export function buildSimilarityGraph(view: KnowledgeSimilarityView, threshold: number): GraphModel {
  const nodes: GraphNode[] = view.documents.map((document) => ({
    id: document.id,
    label: document.filename,
    group: document.status,
    status: document.status,
    x: 0,
    y: 0
  }))
  const ids = new Set(nodes.map((node) => node.id))
  const edges: GraphEdge[] = view.edges
    .filter((edge) => edge.weight >= threshold && ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({
      id: `${edge.source}|${edge.target}`,
      source: edge.source,
      target: edge.target,
      label: `${Math.round(edge.weight * 100)}%`,
      weight: edge.weight
    }))
  return { nodes: layoutGraph(nodes), edges }
}

/** 导出只包含当前过滤后的图与版本绑定，确定性、无时间戳。 */
export function exportGraphPayload(input: ExportGraphInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: 'ideer-knowledge-graph',
    graphType: input.graphType,
    kbId: input.kbId,
    revisionId: input.revisionId,
    revisionNo: input.revisionNo,
    manifestHash: input.manifestHash,
    status: input.status,
    nodes: input.model.nodes.map((node) => ({ id: node.id, label: node.label, group: node.group })),
    edges: input.model.edges.map((edge) => ({
      source: edge.source, target: edge.target, label: edge.label, weight: edge.weight
    }))
  }
  if (input.graphType === 'similarity') payload.threshold = input.threshold
  return payload
}

/** 相似文档行在画布图例里的诚实措辞。 */
export const similarityStatusNames: Record<KnowledgeSimilarityView['documents'][number]['status'], string> = {
  matched: '已核验',
  not_enough_content: '内容过短',
  content_drift: '内容漂移',
  not_searchable: '不可解码',
  file_unavailable: '文件缺失'
}

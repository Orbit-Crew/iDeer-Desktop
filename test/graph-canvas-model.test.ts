import { describe, expect, it } from 'vitest'
import { buildEntityGraph, buildSimilarityGraph, clampZoom, exportGraphPayload, layoutGraph, screenToWorld, zoomAround }
  from '../src/renderer/src/components/graphCanvasModel'
import type { KnowledgeGraphView, KnowledgeSimilarityView } from '../src/shared/desktop'

const KB = '33333333-3333-4333-8333-333333333333'
const REVISION = '77777777-7777-4777-8777-777777777777'
const DOCUMENT = '88888888-8888-4888-8888-888888888888'

const graphView: KnowledgeGraphView = {
  kbId: KB,
  revisionId: REVISION,
  revisionNo: 1,
  manifestHash: 'c'.repeat(64),
  status: 'completed',
  generated: 1,
  failed: 0,
  entities: [
    { name: '甲零件', type: '零件', documentId: DOCUMENT, filename: 'guide.txt' },
    { name: '乙组件', type: '组件', documentId: DOCUMENT, filename: 'guide.txt' }
  ],
  relations: [
    { source: '甲零件', target: '乙组件', relation: '属于', documentId: DOCUMENT, filename: 'guide.txt' },
    // A relation whose endpoint was never stated as an entity still displays:
    // the endpoint joins the canvas as an uncategorized node, never dropped.
    { source: '乙组件', target: '螺栓', relation: '包含', documentId: DOCUMENT, filename: 'guide.txt' }
  ],
  sources: [{ documentId: DOCUMENT, filename: 'guide.txt', contentHash: 'd'.repeat(64), status: 'completed', errorCode: '' }]
}

const similarityView: KnowledgeSimilarityView = {
  kbId: KB,
  revisionId: REVISION,
  revisionNo: 1,
  manifestHash: 'c'.repeat(64),
  status: 'partial',
  threshold: 0.05,
  truncated: false,
  documents: [
    { id: 'guide.txt', filename: 'guide.txt', contentHash: 'd'.repeat(64), status: 'matched', tokenCount: 30 },
    { id: 'spec.txt', filename: 'spec.txt', contentHash: 'e'.repeat(64), status: 'matched', tokenCount: 28 },
    { id: 'lost.txt', filename: 'lost.txt', contentHash: 'f'.repeat(64), status: 'content_drift', tokenCount: 0 }
  ],
  edges: [
    { source: 'guide.txt', target: 'spec.txt', weight: 0.42 },
    { source: 'guide.txt', target: 'lost.txt', weight: 0.1 }
  ]
}

describe('entity graph model (#99)', () => {
  it('builds one node per entity plus uncategorized relation endpoints', () => {
    const model = buildEntityGraph(graphView)
    const labels = model.nodes.map((node) => node.label).sort()
    expect(labels).toEqual(['乙组件', '甲零件', '螺栓'])
    expect(model.nodes.find((node) => node.label === '甲零件')?.group).toBe('零件')
    // 螺栓 was never stated as an entity: it joins uncategorized, honestly.
    expect(model.nodes.find((node) => node.label === '螺栓')?.group).toBe('')
    expect(model.edges.map((edge) => edge.label)).toEqual(['属于', '包含'])
  })

  it('lays positions out deterministically for the same input', () => {
    const first = layoutGraph(buildEntityGraph(graphView).nodes)
    const second = layoutGraph(buildEntityGraph(graphView).nodes)
    expect(first).toEqual(second)
    expect(first.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  })
})

describe('similarity graph model (#99)', () => {
  it('keeps every frozen document as a node including the failed ones', () => {
    const model = buildSimilarityGraph(similarityView, 0.05)
    expect(model.nodes.map((node) => node.id).sort()).toEqual(['guide.txt', 'lost.txt', 'spec.txt'])
    expect(model.nodes.find((node) => node.id === 'lost.txt')?.status).toBe('content_drift')
  })

  it('filters edges by the display threshold and labels weights honestly', () => {
    const all = buildSimilarityGraph(similarityView, 0.05)
    expect(all.edges).toHaveLength(2)
    expect(all.edges[0].label).toBe('42%')
    const raised = buildSimilarityGraph(similarityView, 0.3)
    expect(raised.edges.map((edge) => edge.id)).toEqual(['guide.txt|spec.txt'])
  })
})

describe('canvas viewport and export (#99)', () => {
  it('clamps zoom into the fixed band', () => {
    expect(clampZoom(0.01)).toBe(0.1)
    expect(clampZoom(42)).toBe(5)
    expect(clampZoom(1.5)).toBe(1.5)
  })

  it('zooms around the cursor without moving the world under it', () => {
    const before: { x: number; y: number; scale: number } = { x: 0, y: 0, scale: 1 }
    const pointer = { x: 100, y: 50 }
    const after = zoomAround(before, { x: 0, y: 0 }, pointer, -100)
    expect(after.scale).toBeGreaterThan(1)
    expect(screenToWorld(after, { x: 0, y: 0 }, pointer)).toEqual(screenToWorld(before, { x: 0, y: 0 }, pointer))
  })

  it('exports exactly the filtered display graph with its revision binding', () => {
    const model = buildSimilarityGraph(similarityView, 0.3)
    const payload = exportGraphPayload({
      graphType: 'similarity', kbId: KB, revisionId: REVISION, revisionNo: 1,
      manifestHash: 'c'.repeat(64), status: 'partial', threshold: 0.3, model
    })
    expect(payload).toEqual({
      kind: 'ideer-knowledge-graph',
      graphType: 'similarity',
      kbId: KB,
      revisionId: REVISION,
      revisionNo: 1,
      manifestHash: 'c'.repeat(64),
      status: 'partial',
      threshold: 0.3,
      nodes: model.nodes.map((node) => ({ id: node.id, label: node.label, group: node.group })),
      edges: model.edges.map((edge) => ({ source: edge.source, target: edge.target, label: edge.label, weight: edge.weight }))
    })
  })
})

import { describe, expect, it } from 'vitest'
import { buildWikiGraph, wikiSourceLine } from '../src/renderer/src/components/wikiGraphModel'
import type { WikiNavigation, WikiNavigationPage } from '../src/shared/desktop'

const KB = '33333333-3333-4333-8333-333333333333'
const REVISION = '77777777-7777-4777-8777-777777777777'

let nextDocument = 0
const documentId = (): string => {
  nextDocument += 1
  return String(nextDocument).padStart(8, '0') + '-0100-4100-8100-000000000000'
}

const pageRow = (overrides: Partial<WikiNavigationPage> = {}): WikiNavigationPage => ({
  documentId: documentId(),
  filename: 'guide.txt',
  title: '甲零件与乙组件',
  contentHash: 'd'.repeat(64),
  status: 'completed',
  errorCode: '',
  links: [],
  missingLinks: [],
  backlinks: [],
  ...overrides
})

const navigation = (pages: WikiNavigationPage[]): WikiNavigation => ({
  kbId: KB,
  revisionId: REVISION,
  revisionNo: 1,
  manifestHash: 'c'.repeat(64),
  status: pages.some(row => row.status !== 'completed') ? 'partial' : 'completed',
  generated: pages.filter(row => row.status === 'completed').length,
  failed: pages.filter(row => row.status === 'failed').length,
  skipped: pages.filter(row => row.status === 'skipped').length,
  pages,
  associations: { status: 'not_generated', generated: 0, failed: 0, sources: [], entities: [], relations: [] }
})

describe('the wiki graph model (#100 overview)', () => {
  it('renders every page as a node with its honest status and manifest position', () => {
    const completed = pageRow()
    const skipped = pageRow({ filename: 'policy.txt', title: '', status: 'skipped', errorCode: 'GRAPH_CONTENT_DRIFTED' })
    const graph = buildWikiGraph(navigation([completed, skipped]), 'overview', null)
    expect(graph.nodes.map(node => [node.id, node.status])).toEqual([
      [completed.documentId, 'completed'],
      [skipped.documentId, 'skipped']
    ])
    expect(graph.nodes.map(node => node.position)).toEqual([1, 2])
    expect(graph.nodes.every(node => node.sourceTotal === 2)).toBe(true)
  })

  it('places nodes deterministically and keeps the same layout for the same input', () => {
    const rows = [pageRow(), pageRow({ filename: 'b.txt', title: '乙' }), pageRow({ filename: 'c.txt', title: '丙' })]
    const first = buildWikiGraph(navigation(rows), 'overview', null)
    const second = buildWikiGraph(navigation(rows), 'overview', null)
    expect(first).toEqual(second)
    // One page sits exactly at the canvas center; several pages share it as
    // the circle center but none of them is placed there.
    const single = buildWikiGraph(navigation([pageRow()]), 'overview', null)
    expect(single.nodes[0].x).toBe(single.width / 2)
    expect(single.nodes[0].y).toBe(single.height / 2)
  })

  it('derives directed edges from resolved links only and never duplicates one link row', () => {
    const a = pageRow({ title: '甲' })
    const b = pageRow({ filename: 'b.txt', title: '乙', links: [{ documentId: a.documentId, title: '甲', status: 'completed' }], backlinks: [{ documentId: a.documentId, title: '甲', status: 'completed' }] })
    const c = pageRow({ filename: 'c.txt', title: '丙', links: [{ documentId: a.documentId, title: '甲', status: 'completed' }, { documentId: 'missing-target', title: '', status: 'completed' }] })
    const graph = buildWikiGraph(navigation([a, b, c]), 'overview', null)
    const edges = graph.edges.map(edge => `${edge.source}->${edge.target}`).sort()
    // B lists A twice over (a link and a backlink row for the same pair) but
    // both name the one B→A relation; C's unresolved target never becomes an
    // edge into a page that does not exist.
    expect(edges).toEqual([`${b.documentId}->${a.documentId}`, `${c.documentId}->${a.documentId}`])
  })

  it('keeps a link between two completed pages as two opposite directed edges', () => {
    const a = pageRow({ title: '甲', links: [] })
    const b = pageRow({ filename: 'b.txt', title: '乙', links: [{ documentId: a.documentId, title: '甲', status: 'completed' }] })
    a.links.push({ documentId: b.documentId, title: '乙', status: 'completed' })
    const graph = buildWikiGraph(navigation([a, b]), 'overview', null)
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges.map(edge => `${edge.source}->${edge.target}`).sort())
      .toEqual([`${a.documentId}->${b.documentId}`, `${b.documentId}->${a.documentId}`])
  })
})

describe('the wiki neighborhood (#100 邻域)', () => {
  it('centers on the requested page and walks exactly two hops over links and backlinks', () => {
    const center = pageRow({ title: '中心' })
    const linked = pageRow({ filename: 'linked.txt', title: '正向一跳' })
    const back = pageRow({ filename: 'back.txt', title: '反向一跳' })
    const far = pageRow({ filename: 'far.txt', title: '两跳之外' })
    const distant = pageRow({ filename: 'distant.txt', title: '三跳之外' })
    center.links.push({ documentId: linked.documentId, title: linked.title, status: 'completed' })
    back.links.push({ documentId: center.documentId, title: center.title, status: 'completed' })
    // The Server projects backlinks as the exact inverse of resolved links,
    // so the fixture keeps the same invariant.
    center.backlinks.push({ documentId: back.documentId, title: back.title, status: 'completed' })
    linked.links.push({ documentId: far.documentId, title: far.title, status: 'completed' })
    far.links.push({ documentId: distant.documentId, title: distant.title, status: 'completed' })
    const graph = buildWikiGraph(navigation([center, linked, back, far, distant]), 'neighborhood', center.documentId)
    const included = new Set(graph.nodes.map(node => node.id))
    expect(included).toEqual(new Set([center.documentId, linked.documentId, back.documentId, far.documentId]))
    expect(graph.nodes[0].id).toBe(center.documentId)
  })

  it('falls back to the first completed page when no center is given and stays deterministic', () => {
    const skipped = pageRow({ filename: 'policy.txt', title: '', status: 'skipped' })
    const completed = pageRow({ filename: 'guide.txt', title: '甲' })
    const first = buildWikiGraph(navigation([skipped, completed]), 'neighborhood', null)
    const second = buildWikiGraph(navigation([skipped, completed]), 'neighborhood', null)
    expect(first).toEqual(second)
    expect(first.nodes[0].id).toBe(completed.documentId)
  })

  it('counts a skipped page inside the closure as an honest, unclickable-shaped node', () => {
    const center = pageRow({ title: '中心' })
    const skipped = pageRow({ filename: 'policy.txt', title: '', status: 'skipped' })
    center.links.push({ documentId: skipped.documentId, title: '', status: 'skipped' })
    const graph = buildWikiGraph(navigation([center, skipped]), 'neighborhood', center.documentId)
    expect(graph.nodes.map(node => node.status)).toEqual(['completed', 'skipped'])
  })

  it('stays bounded when the closure would flood the canvas', () => {
    const rows = Array.from({ length: 120 }, () => pageRow())
    // One linear chain through every row: the two-hop closure is small, so
    // flood the graph by linking the first row to everything else instead.
    for (const row of rows.slice(1)) rows[0].links.push({ documentId: row.documentId, title: row.title, status: 'completed' })
    const graph = buildWikiGraph(navigation(rows), 'neighborhood', rows[0].documentId)
    expect(graph.nodes.length).toBeLessThanOrEqual(60)
    expect(graph.nodes[0].id).toBe(rows[0].documentId)
  })
})

describe('the frozen source annotation (#100 来源与位置)', () => {
  it('names the document, its frozen manifest position, and the digest', () => {
    const first = pageRow()
    const second = pageRow({ filename: 'policy.txt', title: '' })
    expect(wikiSourceLine(first, 0, 2)).toBe(`来源 guide.txt · 冻结位置 1/2 · 文档指纹：${'d'.repeat(64)}`)
    expect(wikiSourceLine(second, 1, 2)).toBe(`来源 policy.txt · 冻结位置 2/2 · 文档指纹：${'d'.repeat(64)}`)
  })
})

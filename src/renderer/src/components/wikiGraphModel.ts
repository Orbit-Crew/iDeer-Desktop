import type { WikiNavigation, WikiNavigationPage, WikiPageSummary } from '../../../shared/desktop'

/**
 * Issue #100: the deterministic wiki graph model. The Server's navigation
 * index already owns every fact — pages with their honest statuses, resolved
 * links, backlinks, and frozen document sources — so this module only
 * derives the navigation canvas from it: an overview of the whole revision
 * or the neighborhood of one page, walked over links and backlinks. Nothing
 * is invented: an unresolved target never becomes a node, a skipped or
 * failed page keeps exactly its own status, and the same input always
 * produces the same layout (manifest order, fixed geometry, no randomness).
 */

export type WikiGraphMode = 'overview' | 'neighborhood'

export interface WikiGraphNode {
  id: string
  label: string
  status: WikiPageSummary['status']
  /** 1-based position inside the revision's frozen manifest. */
  position: number
  sourceTotal: number
  degree: number
  x: number
  y: number
  radius: number
}

export interface WikiGraphEdge {
  source: string
  target: string
}

export interface WikiGraph {
  width: number
  height: number
  nodes: WikiGraphNode[]
  edges: WikiGraphEdge[]
}

/** The neighborhood stays a readable picture: at most this many pages. */
const MAX_NEIGHBORHOOD_NODES = 60
const NEIGHBORHOOD_HOPS = 2

export const WIKI_GRAPH_WIDTH = 1000
export const WIKI_GRAPH_HEIGHT = 700

const pageLabel = (row: WikiNavigationPage): string => row.title || row.filename || row.documentId.slice(0, 8)

/**
 * The neighborhood of one page: the page itself plus every page within two
 * hops over its resolved links and backlinks, in manifest-first order,
 * capped so one hub cannot flood the canvas.
 */
const neighborhoodClosure = (pages: WikiNavigationPage[], centerId: string | null): Array<{ id: string; depth: number }> => {
  const byId = new Map(pages.map(row => [row.documentId, row]))
  const center = (centerId && byId.has(centerId)
    ? centerId
    : (pages.find(row => row.status === 'completed') ?? pages[0])?.documentId) ?? null
  if (!center) return []
  const order: Array<{ id: string; depth: number }> = [{ id: center, depth: 0 }]
  const seen = new Set([center])
  let frontier = [center]
  for (let hop = 1; hop <= NEIGHBORHOOD_HOPS; hop += 1) {
    const next: string[] = []
    for (const id of frontier) {
      const row = byId.get(id)
      if (!row) continue
      for (const neighbor of [...row.links.map(link => link.documentId), ...row.backlinks.map(link => link.documentId)]) {
        if (seen.has(neighbor) || !byId.has(neighbor) || order.length >= MAX_NEIGHBORHOOD_NODES) continue
        seen.add(neighbor)
        order.push({ id: neighbor, depth: hop })
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return order
}

const ringPosition = (index: number, count: number, radius: number): { x: number; y: number } => {
  if (count <= 0 || radius === 0) return { x: WIKI_GRAPH_WIDTH / 2, y: WIKI_GRAPH_HEIGHT / 2 }
  const angle = (-90 + (360 * index) / count) * (Math.PI / 180)
  return {
    x: WIKI_GRAPH_WIDTH / 2 + radius * Math.cos(angle),
    y: WIKI_GRAPH_HEIGHT / 2 + radius * Math.sin(angle)
  }
}

const buildOverview = (pages: WikiNavigationPage[]): { entries: Array<{ id: string; depth: number }>; edges: WikiGraphEdge[] } => {
  const included = new Set(pages.map(row => row.documentId))
  const edges: WikiGraphEdge[] = []
  const seen = new Set<string>()
  for (const row of pages) {
    for (const link of row.links) {
      if (!included.has(link.documentId)) continue
      const key = `${row.documentId}->${link.documentId}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: row.documentId, target: link.documentId })
    }
  }
  return { entries: pages.map((row, index) => ({ id: row.documentId, depth: index === 0 && pages.length === 1 ? 0 : 1 })), edges }
}

const buildNeighborhood = (pages: WikiNavigationPage[], centerId: string | null): { entries: Array<{ id: string; depth: number }>; edges: WikiGraphEdge[] } => {
  const entries = neighborhoodClosure(pages, centerId)
  const included = new Set(entries.map(entry => entry.id))
  const byId = new Map(pages.map(row => [row.documentId, row]))
  const edges: WikiGraphEdge[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const row = byId.get(entry.id)
    if (!row) continue
    for (const link of row.links) {
      if (!included.has(link.documentId)) continue
      const key = `${entry.id}->${link.documentId}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: entry.id, target: link.documentId })
    }
  }
  return { entries, edges }
}

/**
 * The canvas model for one navigation index: overview lays every page on
 * one circle in manifest order; the neighborhood centers the selected page
 * and rings its one-hop and two-hop pages. Degrees come from the rendered
 * edges only, so a node's size always names its visible relations.
 */
export const buildWikiGraph = (navigation: WikiNavigation, mode: WikiGraphMode, centerId: string | null): WikiGraph => {
  const pages = navigation.pages
  const sourceTotal = pages.length
  const { entries, edges } = mode === 'neighborhood'
    ? buildNeighborhood(pages, centerId)
    : buildOverview(pages)
  const byId = new Map(pages.map(row => [row.documentId, row]))
  const degrees = new Map<string, number>()
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1)
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1)
  }
  const rings = new Map<number, string[]>()
  for (const entry of entries) {
    const ring = rings.get(entry.depth) ?? []
    ring.push(entry.id)
    rings.set(entry.depth, ring)
  }
  const nodes = entries.map(entry => {
    const row = byId.get(entry.id)
    const degree = degrees.get(entry.id) ?? 0
    let position: { x: number; y: number }
    if (entry.depth === 0) {
      position = { x: WIKI_GRAPH_WIDTH / 2, y: WIKI_GRAPH_HEIGHT / 2 }
    } else {
      const ring = rings.get(entry.depth) ?? []
      const radius = mode === 'neighborhood' ? (entry.depth === 1 ? 170 : 300) : Math.min(300, 90 + 22 * pages.length)
      position = ringPosition(ring.indexOf(entry.id), ring.length, radius)
    }
    return {
      id: entry.id,
      label: row ? pageLabel(row) : entry.id,
      status: (row?.status ?? 'not_generated') as WikiPageSummary['status'],
      position: pages.findIndex(row => row.documentId === entry.id) + 1,
      sourceTotal,
      degree,
      x: Math.round(position.x * 100) / 100,
      y: Math.round(position.y * 100) / 100,
      radius: 12 + Math.min(10, degree * 2)
    }
  })
  return { width: WIKI_GRAPH_WIDTH, height: WIKI_GRAPH_HEIGHT, nodes, edges }
}

/**
 * The one frozen source line every page row and selected node carries: the
 * document it was generated from, its position inside the frozen manifest,
 * and the digest that binds them together.
 */
export const wikiSourceLine = (row: Pick<WikiNavigationPage, 'filename' | 'contentHash'>, index: number, total: number): string =>
  `来源 ${row.filename} · 冻结位置 ${index + 1}/${total} · 文档指纹：${row.contentHash}`

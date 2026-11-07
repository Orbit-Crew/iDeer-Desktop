import type { WikiGraph, WikiGraphNode } from './wikiGraphModel'

/** One node color per honest page status; the graph never invents a look
 * for a state the Server did not state. */
const STATUS_COLORS: Record<WikiGraphNode['status'], string> = {
  completed: '#1E6FCC',
  skipped: '#FA8C16',
  failed: '#CF1322',
  not_generated: '#8C8C8C'
}

export interface WikiGraphCanvasProps {
  graph: WikiGraph
  selectedId: string | null
  onNodeClick: (documentId: string) => void
}

/**
 * Issue #100: the wiki navigation canvas. A fixed, deterministic SVG
 * projection of the graph model — nodes colored by their honest page
 * status, sized by their visible relations, joined by directed link edges.
 * Hovering a node highlights its edges and neighbors; every node is
 * clickable and the panel decides what a click means for that page's
 * status. No physics engine and no random layout: the same index always
 * draws the same picture.
 */
export function WikiGraphCanvas({ graph, selectedId, onNodeClick }: WikiGraphCanvasProps): JSX.Element {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const neighbors = (id: string): Set<string> => {
    const set = new Set<string>([id])
    for (const edge of graph.edges) {
      if (edge.source === id) set.add(edge.target)
      if (edge.target === id) set.add(edge.source)
    }
    return set
  }
  return (
    <svg
      className="w-full rounded border border-gray-200 bg-white"
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      role="img"
      aria-label="wiki 图导航"
      style={{ minHeight: 260 }}
    >
      <defs>
        <marker id="wiki-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#C9CDD4" />
        </marker>
      </defs>
      {graph.edges.map(edge => {
        const source = byId.get(edge.source)
        const target = byId.get(edge.target)
        if (!source || !target) return null
        return <line
          key={`${edge.source}->${edge.target}`}
          x1={source.x} y1={source.y} x2={target.x} y2={target.y}
          stroke="#C9CDD4" strokeWidth={1.5} opacity={0.7}
          markerEnd="url(#wiki-graph-arrow)"
        />
      })}
      {graph.nodes.map(node => {
        const highlight = neighbors(node.id)
        return <g
          key={node.id}
          role="button"
          aria-label={`页面节点 ${node.label}`}
          className="cursor-pointer"
          onClick={() => onNodeClick(node.id)}
        >
          {selectedId === node.id && <circle cx={node.x} cy={node.y} r={node.radius + 5} fill="none" stroke="#1E6FCC" strokeWidth={2} />}
          <circle cx={node.x} cy={node.y} r={node.radius} fill={STATUS_COLORS[node.status]} stroke="#FFFFFF" strokeWidth={2} />
          <text x={node.x} y={node.y + node.radius + 14} textAnchor="middle" fontSize={12} fill="#333333">
            {node.label}
          </text>
          <title>{`${node.label} · ${highlight.size - 1} 条可见关系`}</title>
        </g>
      })}
    </svg>
  )
}

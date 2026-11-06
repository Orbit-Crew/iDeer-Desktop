// Issue 113: the Synapse session map returns as the platform Thread
// projection — the 五期·39 restoration. Every node is one of the account's
// own platform threads (the sidebar's own list read); every edge is a branch
// fact the Server itself reported when a branch succeeded on this device,
// recorded by the Runtime's scope-bound branch-edge ledger and rebuilt after
// a restart. The pane draws no invented node and no guessed edge: a session
// without a recorded parent — or whose parent sits outside the list page —
// renders unconnected. Actions reuse the list's semantics: clicking a node
// asks to open the session (the same signal the sidebar sends), and the open
// session's node offers 从此分支 under the same gate the conversation
// renders. Both actions ride the session store's signals into the
// conversation's single serialized command path — the map observes; the
// conversation owns the session.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { ChatSnapshot, ThreadRowView, ThreadView } from '../../../../shared/desktop'
import { branchGate } from '../../../../shared/chatTurns'
import { useSessionStore } from '../../stores/sessionStore'

const NODE_W = 168
const NODE_H = 40
const H_GAP = 28
const LEVEL_H = 76
const TITLE_LIMIT = 18

interface GraphNode { row: ThreadRowView; x: number; y: number }
interface GraphEdge { parent: GraphNode; child: GraphNode }

/** The forest layout: children slot under their present parent, leaves take
 * in-order x slots and a parent centers over its children. A defensive
 * visited set keeps a malformed edge cycle from looping — layout only; the
 * platform's own parent facts can never form one. */
const layoutForest = (rows: ThreadRowView[]): { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number } => {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const presentParent = (row: ThreadRowView): ThreadRowView | null => {
    const parentId = row.branchedFrom?.threadId
    return parentId && byId.has(parentId) ? byId.get(parentId)! : null
  }
  const children = new Map<string, ThreadRowView[]>()
  for (const row of rows) {
    const parent = presentParent(row)
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), row])
  }
  const depthOf = new Map<string, number>()
  const depth = (row: ThreadRowView, seen: Set<string>): number => {
    const known = depthOf.get(row.id)
    if (known !== undefined) return known
    const parent = presentParent(row)
    if (!parent || seen.has(row.id)) {
      depthOf.set(row.id, 0)
      return 0
    }
    seen.add(row.id)
    const value = depth(parent, seen) + 1
    seen.delete(row.id)
    depthOf.set(row.id, value)
    return value
  }
  for (const row of rows) depth(row, new Set())
  const slotOf = new Map<string, number>()
  let slot = 0
  const walkX = (row: ThreadRowView): number => {
    const known = slotOf.get(row.id)
    if (known !== undefined) return known
    const kids = children.get(row.id) ?? []
    let value: number
    if (!kids.length) {
      value = slot++
    } else {
      const kidSlots = kids.map(walkX)
      value = (kidSlots[0] + kidSlots[kidSlots.length - 1]) / 2
    }
    slotOf.set(row.id, value)
    return value
  }
  for (const row of rows) {
    if (!presentParent(row)) walkX(row)
  }
  // A malformed cycle would own no root; it still lays out instead of
  // disappearing, laid out like a root row.
  for (const row of rows) walkX(row)
  const nodes: GraphNode[] = []
  const nodeById = new Map<string, GraphNode>()
  let maxSlot = 0
  let maxDepth = 0
  for (const row of rows) {
    const node = { row, x: (slotOf.get(row.id) ?? 0) * (NODE_W + H_GAP), y: (depthOf.get(row.id) ?? 0) * LEVEL_H }
    maxSlot = Math.max(maxSlot, slotOf.get(row.id) ?? 0)
    maxDepth = Math.max(maxDepth, depthOf.get(row.id) ?? 0)
    nodes.push(node)
    nodeById.set(row.id, node)
  }
  const edges: GraphEdge[] = []
  for (const row of rows) {
    const parent = presentParent(row)
    if (parent) edges.push({ parent: nodeById.get(parent.id)!, child: nodeById.get(row.id)! })
  }
  return { nodes, edges, width: Math.max(1, maxSlot + 1) * (NODE_W + H_GAP) - H_GAP, height: (maxDepth + 1) * LEVEL_H }
}

const titleText = (row: ThreadRowView): string =>
  row.title.length > TITLE_LIMIT ? `${row.title.slice(0, TITLE_LIMIT)}…` : row.title

const SessionGraph = ({ rows, activeThreadId, branchable, onOpen, onBranch }: {
  rows: ThreadRowView[]
  activeThreadId: string
  branchable: boolean
  onOpen: (threadId: string) => void
  onBranch: () => void
}): JSX.Element => {
  const { nodes, edges, width, height } = layoutForest(rows)
  return <svg role="img" aria-label="会话与分支关系图" width={width} height={height}
    style={{ maxWidth: '100%', display: 'block' }}>
    {edges.map(({ parent, child }) => {
      const px = parent.x + NODE_W / 2
      const py = parent.y + NODE_H
      const cx = child.x + NODE_W / 2
      const cy = child.y
      return <path key={`${parent.row.id}->${child.row.id}`}
        aria-label={`分支连线：${titleText(parent.row)} → ${titleText(child.row)}`}
        d={`M ${px} ${py} C ${px} ${py + 24}, ${cx} ${cy - 24}, ${cx} ${cy}`}
        stroke="#94a3b8" strokeWidth={1.5} fill="none" />
    })}
    {nodes.map(({ row, x, y }) => {
      const active = row.id === activeThreadId
      return <g key={row.id} transform={`translate(${x},${y})`} style={{ cursor: 'pointer' }}
        aria-label={`会话节点：${titleText(row)}`} onClick={() => onOpen(row.id)}>
        <title>打开会话 {row.title}</title>
        <rect width={NODE_W} height={NODE_H} rx={8}
          fill={active ? '#e6f4ff' : '#ffffff'} stroke={active ? '#1677ff' : '#d1d5db'} strokeWidth={active ? 1.5 : 1} />
        <text x={10} y={25} fontSize={12} fill="#1f2937" style={{ pointerEvents: 'none' }}>{titleText(row)}</text>
        {active && branchable && <text x={NODE_W - 10} y={25} fontSize={11} fill="#1677ff" textAnchor="end"
          role="button" aria-label={`从此分支：${titleText(row)}`} style={{ cursor: 'pointer' }}
          onClick={(event) => { event.stopPropagation(); onBranch() }}>
          <title>从这条会话的最后一个回复开启新支线（历史保持一致，后续各自独立）</title>
          从此分支
        </text>}
      </g>
    })}
  </svg>
}

/** The pure view: exactly the platform's own rows and this device's observed
 * edges, or an explicit unavailable/empty state — never a fabricated node. */
export function SynapseView({ failed, view, snapshot, activeThreadId, onOpen, onBranch, onRefresh }: {
  failed: boolean
  view: ThreadView | null
  snapshot: ChatSnapshot | null
  activeThreadId: string
  onOpen: (threadId: string) => void
  onBranch: () => void
  onRefresh: () => void
}): JSX.Element {
  const rows = view?.threads ?? []
  // Issue 78/113: the map offers the same gate the conversation renders —
  // the conversation re-checks on its own serialized path either way.
  const branchable = !!view?.permissions.canRename && branchGate(snapshot ?? {
    thread: null, stream: 'idle', run: null, platform: undefined, messages: []
  })
  return <div className="h-full w-full overflow-auto p-4" style={{ background: 'var(--pane-bg, #F4F6FA)' }}>
    <div className="mb-1 flex items-center gap-2">
      <span className="text-sm font-medium text-gray-800">会话地图</span>
      <span className="text-xs text-gray-500">平台 Thread · 只读投影</span>
      <Button size="small" icon={<ReloadOutlined />} aria-label="刷新会话地图" className="ml-auto"
        onClick={onRefresh}>刷新</Button>
    </div>
    <Typography.Paragraph type="secondary" className="mb-3 text-xs">
      节点为本账号的平台会话；连线是本机发起分支时平台返回的父子事实，重启后可重建。没有记录父会话的会话独立成节点，不伪造关系。
      点节点打开会话；当前打开的会话节点上可发起「从此分支」，动作与列表同权限。
    </Typography.Paragraph>
    {failed
      ? <Alert type="warning" showIcon message="平台未连接，会话地图不可用"
          description="读取平台会话列表失败；连接恢复后可重新生成地图。" />
      : rows.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />
        : <SessionGraph rows={rows} activeThreadId={activeThreadId} branchable={branchable}
            onOpen={onOpen} onBranch={onBranch} />}
  </div>
}

/** The pane: the sidebar's own list read (event-driven, never polled — the
 * threads family is single-slot) plus a slow read-only poll of the same
 * snapshot the conversation reads, for the branch gate alone. */
export default function SynapsePane(): JSX.Element {
  const [view, setView] = useState<ThreadView | null>(null)
  const [failed, setFailed] = useState(false)
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null)
  const activeThreadId = useSessionStore((state) => state.activeThreadId)
  const sessionsVersion = useSessionStore((state) => state.sessionsVersion)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const load = useCallback(async (retried = 0): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const next = await window.ideer.threads({ action: 'list' })
      if (mounted.current) {
        setView(next)
        setFailed(false)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The single slot is shared with the sidebar; a wire-busy rejection
      // retries a bounded three times instead of surfacing a spurious error.
      if (message === 'THREADS_BUSY' && retried < 3) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        if (mounted.current) {
          inFlight.current = false
          return load(retried + 1)
        }
      }
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])
  // Issue 78/113: a successful branch bumps the sessions signal — the map
  // re-reads the platform's own list instead of waiting for a manual refresh.
  useEffect(() => { void load() }, [sessionsVersion, load])
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    // 1s cadence: an observer, not the conversation's own 500ms loop.
    const poll = async (): Promise<void> => {
      try {
        const next = await window.ideer.chat({ action: 'state' })
        if (mounted.current) setSnapshot(next)
      } catch { if (mounted.current) setSnapshot(null) }
      if (mounted.current) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [])
  return <SynapseView failed={failed} view={view} snapshot={snapshot} activeThreadId={activeThreadId}
    onOpen={(threadId) => useSessionStore.getState().requestOpen(threadId)}
    onBranch={() => useSessionStore.getState().requestBranch()}
    onRefresh={() => void load()} />
}

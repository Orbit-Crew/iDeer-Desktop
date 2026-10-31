// The eight fixed window arrangements from the pinned linz dock (issue 71),
// unchanged in structure: click the workspace layout button, pick an
// arrangement, the dock rebuilds from the spec tree. The arrangements keep the
// original browser/terminal/files vocabulary; unwired panes render their
// honest placeholder inside the same geometry.
import { type CSSProperties } from 'react'
import { genNodeId, makeInstance, type DockLayout, type DockNode, type Pane, type PanelInstance, type PanelTypeId, type SplitNode, type Tab } from './types'
import { useDockStore } from './dockStore'
import { defaultTitle } from './panelMeta'
import { useUIStore } from '../stores/uiStore'

/**
 * 固定窗口排布预设。
 * 点击布局按钮时弹出选择器，让用户挑选一种固定排布。
 * 排布用嵌套树描述（row=左右分栏 / col=上下分栏），支持上下、左右、三栏、混合等多种形态。
 */

export type SpecNode =
  | { kind: 'anchor' } // 对话锚点窗格
  | { kind: 'pane'; tabs: PanelTypeId[] } // 工具窗格（页签）
  | { kind: 'row'; ratio: number; children: SpecNode[] } // 左右分栏（横向）
  | { kind: 'col'; ratio: number; children: SpecNode[] } // 上下分栏（纵向）

export type PresetSpec =
  | { type: 'single' } // 仅对话
  | { type: 'tree'; root: SpecNode }

export interface LayoutPreset {
  id: string
  title: string
  description: string
  position: 'r' | 'd' | 'b' | 'm' // r=右侧 r', d=底部, b=双向/混合, m=居中三栏
  spec: PresetSpec
}

const anchor = (): SpecNode => ({ kind: 'anchor' })
const pane = (tabs: PanelTypeId[]): SpecNode => ({ kind: 'pane', tabs })
const row = (ratio: number, children: SpecNode[]): SpecNode => ({ kind: 'row', ratio, children })
const col = (ratio: number, children: SpecNode[]): SpecNode => ({ kind: 'col', ratio, children })

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'chat-only',
    title: '仅对话',
    description: '隐藏工具面板，专注对话',
    position: 'r',
    spec: { type: 'single' }
  },
  {
    id: 'tools-right',
    title: '对话 + 右侧工具',
    description: '右侧浏览器 / 终端 / 文件',
    position: 'r',
    spec: { type: 'tree', root: row(0.68, [anchor(), pane(['browser', 'terminal', 'files'])]) }
  },
  {
    id: 'browser-right',
    title: '对话 + 右侧浏览器',
    description: '右侧内嵌浏览器',
    position: 'r',
    spec: { type: 'tree', root: row(0.72, [anchor(), pane(['browser'])]) }
  },
  {
    id: 'tools-bottom',
    title: '对话 + 底部工具',
    description: '底部浏览器 / 终端 / 文件',
    position: 'd',
    spec: { type: 'tree', root: col(0.68, [anchor(), pane(['browser', 'terminal', 'files'])]) }
  },
  {
    id: 'bottom-row',
    title: '对话 + 底部双栏',
    description: '底部 浏览器｜终端',
    position: 'd',
    spec: { type: 'tree', root: col(0.68, [anchor(), row(0.5, [pane(['browser']), pane(['terminal'])])]) }
  },
  {
    id: 'right-stack',
    title: '对话 + 右侧上下双栏',
    description: '右侧 浏览器 / 终端',
    position: 'b',
    spec: { type: 'tree', root: row(0.68, [anchor(), col(0.5, [pane(['browser']), pane(['terminal'])])]) }
  },
  {
    id: 'three-col',
    title: '三栏工作台',
    description: '工具｜对话｜终端',
    position: 'm',
    spec: { type: 'tree', root: row(0.34, [pane(['browser']), anchor(), pane(['terminal'])]) }
  },
  {
    id: 'bottom-terminal',
    title: '对话 + 底部终端',
    description: '右上浏览器 + 底部终端全宽',
    position: 'b',
    spec: { type: 'tree', root: col(0.6, [row(0.62, [anchor(), pane(['browser'])]), pane(['terminal'])]) }
  }
]

/** 面板缩略图配色 */
const PANEL_COLOR: Record<PanelTypeId, string> = {
  chat: '#1E6FCC',
  runtime: '#13C2C2',
  browser: '#1890FF',
  terminal: '#2f3542',
  files: '#FA8C16',
  kb: '#722ED1',
  viewer3d: '#08979C',
  field: '#389E0D',
  sql: '#CF1322',
  synapse: '#531dAB'
}

// —— 布局构建 ——

function makeAnchorPane(): Pane {
  const tab: Tab = { id: genNodeId('tab'), panelType: 'chat', title: '对话' }
  return { id: genNodeId('pane'), kind: 'pane', tabs: [tab], activeTabId: tab.id, anchor: true }
}

/** 工具窗格：tabs 决定页签列表（每页签独立实例，多页签共享同一窗格） */
function buildToolsPane(panelTypes: PanelTypeId[]): { pane: Pane; instances: PanelInstance[] } {
  const paneId = genNodeId('pane')
  const pane: Pane = { id: paneId, kind: 'pane', tabs: [], activeTabId: null }
  const instances: PanelInstance[] = []
  const countByType: Record<string, number> = {}
  let firstTabId: string | null = null
  for (const pt of panelTypes) {
    countByType[pt] = (countByType[pt] ?? 0) + 1
    const inst = makeInstance(pt, paneId)
    instances.push(inst)
    const tab: Tab = { id: genNodeId('tab'), panelType: pt, title: defaultTitle(pt, countByType[pt]), instanceId: inst.id }
    pane.tabs.push(tab)
    if (!firstTabId) firstTabId = tab.id
  }
  pane.activeTabId = firstTabId
  return { pane, instances }
}

interface Builder {
  byId: Record<string, DockNode>
  instances: Record<string, PanelInstance>
}

/** 递归构建 spec 树，返回根节点 id */
function buildNode(b: Builder, node: SpecNode): string {
  if (node.kind === 'anchor') {
    const anchorPane = makeAnchorPane()
    b.byId[anchorPane.id] = anchorPane
    return anchorPane.id
  }
  if (node.kind === 'pane') {
    const { pane: tools, instances } = buildToolsPane(node.tabs)
    b.byId[tools.id] = tools
    for (const inst of instances) b.instances[inst.id] = inst
    return tools.id
  }
  const children = node.children.map((c) => buildNode(b, c))
  const split: SplitNode = { id: genNodeId('split'), kind: 'split', direction: node.kind, ratio: node.ratio ?? 0.68, children }
  b.byId[split.id] = split
  return split.id
}

export function buildLayoutFromSpec(spec: PresetSpec): DockLayout {
  const b: Builder = { byId: {}, instances: {} }
  const rootSpec: SpecNode = spec.type === 'single' ? { kind: 'anchor' } : spec.root
  const rootId = buildNode(b, rootSpec)
  return { version: 1, rootId, byId: b.byId, instances: b.instances }
}

/** 应用预设：重建 dock 布局并同步伴随窗格显示状态 */
export function applyPreset(presetId: string): void {
  const preset = LAYOUT_PRESETS.find((p) => p.id === presetId)
  if (!preset) return
  useDockStore.getState().hydrate(buildLayoutFromSpec(preset.spec))
  useUIStore.getState().setCompanionPanesVisible(preset.spec.type !== 'single')
}

// —— 缩略图预览 ——

const THUMB_CHAT = '#1E6FCC'

/** 与 DockWorkspace.Split 一致的弹性比例：首子 flex=ratio，其余均分余下空间 */
function flexStyle(index: number, count: number, ratio: number): CSSProperties {
  if (count === 1) return { flex: '1 1 0%' }
  if (index === 0) return { flex: `${ratio} 1 0%` }
  return { flex: `${(1 - ratio) / (count - 1)} 1 0%` }
}

function leafStyle(node: Extract<SpecNode, { kind: 'anchor' | 'pane' }>): CSSProperties {
  if (node.kind === 'anchor') {
    return {
      backgroundColor: `${THUMB_CHAT}26`,
      border: `1px solid ${THUMB_CHAT}55`
    }
  }
  return { backgroundColor: PANEL_COLOR[node.tabs[0]], opacity: 0.92 }
}

function nodeToThumb(node: SpecNode, index: number, count: number, ratio: number): JSX.Element {
  const style = flexStyle(index, count, ratio)
  if (node.kind === 'anchor' || node.kind === 'pane') {
    return <div className="min-w-0 min-h-0 m-[1px] rounded-[2px]" style={{ ...style, ...leafStyle(node) }} />
  }
  return (
    <div className={`flex min-w-0 min-h-0 ${node.kind === 'row' ? 'flex-row' : 'flex-col'}`} style={style}>
      {node.children.map((c, i) => nodeToThumb(c, i, node.children.length, node.ratio))}
    </div>
  )
}

/** 预设对应的迷你排布图（CSS 方块），用于选择器 */
export function renderThumb(spec: PresetSpec): JSX.Element {
  const root: SpecNode = spec.type === 'single' ? { kind: 'anchor' } : spec.root
  return (
    <div className="h-full w-full flex border border-gray-300 rounded bg-white overflow-hidden">
      {nodeToThumb(root, 0, 1, 1)}
    </div>
  )
}

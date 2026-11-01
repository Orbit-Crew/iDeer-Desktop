// Restores the pinned linz dock store (issue 71): split tree, ratios, tab and
// pane drag targets, multi-instance panes and the companion-pane switch.
// Desktop divergences are commented inline: the chat tab can never leave the
// anchor pane, and the restored companion pane carries the device Runtime.
import { create } from 'zustand'
import type {
  DockLayout,
  DockNode,
  Pane,
  PanelInstance,
  PanelTypeId,
  SplitNode,
  Tab
} from './types'
import { genNodeId, makeInstance } from './types'
import { defaultTitle, getPanelMeta } from './panelMeta'
import { buildDefaultLayout, ensureAnchorPane } from './defaultLayout'
import { loadLayout } from './persistence'

export interface PaneRect {
  x: number
  y: number
  width: number
  height: number
}

export function isSplit(n: DockNode): n is SplitNode {
  return n.kind === 'split'
}
export function isPane(n: DockNode): n is Pane {
  return n.kind === 'pane'
}

// —— HTML5 DnD 数据键 ——
export const TAB_DND = 'application/x-ideer-tab'
export const PANE_DND = 'application/x-ideer-pane'
export const FROM_PANE_DND = 'application/x-ideer-frompane'

/** 拖放落点换算：窗口内相对位置决定分屏方向（纯函数，便于测试） */
export function sideFromPoint(dx: number, dy: number): 'left' | 'right' | 'top' | 'bottom' {
  return Math.abs(dx - 0.5) > Math.abs(dy - 0.5)
    ? dx < 0.5
      ? 'left'
      : 'right'
    : dy < 0.5
      ? 'top'
      : 'bottom'
}

function cloneLayout(l: DockLayout): DockLayout {
  const byId: Record<string, DockNode> = {}
  for (const key of Object.keys(l.byId)) {
    const n = l.byId[key]
    byId[key] =
      n.kind === 'split'
        ? { ...n, children: [...n.children] }
        : { ...n, tabs: n.tabs.map((t) => ({ ...t })) }
  }
  const instances: Record<string, PanelInstance> = {}
  for (const key of Object.keys(l.instances)) instances[key] = { ...l.instances[key] }
  return { version: l.version, rootId: l.rootId, byId, instances }
}

function findParent(
  l: DockLayout,
  nodeId: string
): { parent: SplitNode; index: number } | null {
  const root = l.byId[l.rootId]
  if (!root) return null
  const stack: DockNode[] = [root]
  while (stack.length) {
    const n = stack.pop()!
    if (isSplit(n)) {
      const idx = n.children.indexOf(nodeId)
      if (idx >= 0) return { parent: n, index: idx }
      for (const cid of n.children) {
        const c = l.byId[cid]
        if (c) stack.push(c)
      }
    }
  }
  return null
}

export function findAnchorPane(l: DockLayout): Pane | null {
  for (const key of Object.keys(l.byId)) {
    const n = l.byId[key]
    if (isPane(n) && n.anchor) return n
  }
  return null
}

export function collectPanes(l: DockLayout): Pane[] {
  const panes: Pane[] = []
  for (const key of Object.keys(l.byId)) {
    const n = l.byId[key]
    if (isPane(n)) panes.push(n)
  }
  return panes
}

function removeInstancesOf(l: DockLayout, paneId: string): void {
  for (const key of Object.keys(l.instances)) {
    if (l.instances[key].paneId === paneId) delete l.instances[key]
  }
}

function closePaneInner(l: DockLayout, paneId: string): void {
  if (!l.byId[paneId]) return
  removeInstancesOf(l, paneId)
  delete l.byId[paneId]
  const parent = findParent(l, paneId)
  if (!parent) {
    l.rootId = ''
    return
  }
  const { index } = parent
  if (parent.parent.children.length === 2) {
    const siblingId = parent.parent.children[1 - index]
    const grand = findParent(l, parent.parent.id)
    if (grand) grand.parent.children[grand.index] = siblingId
    else l.rootId = siblingId
    delete l.byId[parent.parent.id]
  } else {
    parent.parent.children.splice(index, 1)
  }
}

function clampRatio(r: number): number {
  return Math.min(0.95, Math.max(0.05, r))
}

/** 从树中抽出 nodeId 节点（若父分屏只剩两子则收缩父节点），返回被抽出的节点引用 */
function extractNode(l: DockLayout, nodeId: string): DockNode | null {
  const node = l.byId[nodeId]
  if (!node) return null
  delete l.byId[nodeId]
  const parent = findParent(l, nodeId)
  if (!parent) {
    l.rootId = ''
    return node
  }
  if (parent.parent.children.length === 2) {
    const siblingId = parent.parent.children[1 - parent.index]
    const grand = findParent(l, parent.parent.id)
    if (grand) grand.parent.children[grand.index] = siblingId
    else l.rootId = siblingId
    delete l.byId[parent.parent.id]
  } else {
    parent.parent.children.splice(parent.index, 1)
  }
  return node
}

// 初始布局在 store 创建时恢复（issue 71）：本机保存的布局优先，否则用默认布局。
// zustand v4 的服务端快照（useSyncExternalStore → getInitialState）取创建时的初始
// 状态，静态渲染（启动/验收检查）与真实窗口首帧因此都能呈现完整布局，不再有
// "先空根后 hydrate"的闪烁；键为设备级常量，切账号/项目不影响。
const INITIAL_LAYOUT = ensureAnchorPane(loadLayout() ?? buildDefaultLayout())

interface DockState {
  layout: DockLayout
  paneRects: Record<string, PaneRect>
  /** Dock workspace 容器左上角视口坐标，用于把窗格内容盒换算成相对容器的 rect */
  containerOrigin: { x: number; y: number }

  hydrate: (layout: DockLayout) => void
  setPaneRect: (paneId: string, rect: PaneRect) => void
  setContainerOrigin: (o: { x: number; y: number }) => void
  setActiveTab: (paneId: string, tabId: string) => void
  addTab: (paneId: string, panelType: PanelTypeId) => void
  /**
   * 把 panelType 作为一个新页签放进 paneId；若该类型单实例且已存在则聚焦已有页签。
   * 返回该面板的 instanceId（若无对应实例返回 null）。
   */
  openPanel: (paneId: string, panelType: PanelTypeId) => string | null
  closeTab: (paneId: string, tabId: string) => void
  closePane: (paneId: string) => void
  splitPane: (nodeId: string, direction: 'row' | 'col', panelType?: PanelTypeId) => string
  setRatio: (nodeId: string, ratio: number) => void
  moveTab: (fromPaneId: string, toPaneId: string, tabId: string) => void
  swapPanes: (a: string, b: string) => void
  /** 把 paneId 拖放到 targetPaneId 旁（同父则插到其后；不同父则包一层新分屏） */
  movePaneBeside: (paneId: string, targetPaneId: string) => void
  /**
   * 拖拽落点：把被拖窗格（kind=pane）或页签（kind=tab，抽成新窗格）放到 targetPaneId 的某侧分屏。
   * side: left/right/top/bottom。
   */
  splitBeside: (
    targetPaneId: string,
    payload: { kind: 'pane'; paneId: string } | { kind: 'tab'; tabId: string; fromPaneId: string },
    side: 'left' | 'right' | 'top' | 'bottom'
  ) => void
  /** 全局打开某类面板：聚焦已有页签，或开进某个非锚点窗格，必要时从锚点分出一个新窗格 */
  openPanelType: (panelType: PanelTypeId) => void
  /**
   * 恢复伴随窗格（Desktop 默认为本机 Runtime；原版名 restoreToolsPane）：当布局中
   * 已无任何非锚点窗格时，从锚点分出一个伴随窗格，保证伴随窗格开关在面板被关闭后
   * 仍可重新打开。存在非锚点窗格时为幂等空操作。
   */
  restoreCompanionPane: () => void
}

export const useDockStore = create<DockState>((set, get) => {
  const openPanelInto = (layout: DockLayout, paneId: string, panelType: PanelTypeId): string | null => {
    const pane = layout.byId[paneId]
    if (!pane || isSplit(pane)) return null
    const meta = getPanelMeta(panelType)
    if (!meta.multiInstance) {
      const existing = pane.tabs.find((t) => t.panelType === panelType)
      if (existing) {
        pane.activeTabId = existing.id
        return existing.instanceId ?? null
      }
    }
    const inst = makeInstance(panelType, paneId)
    layout.instances[inst.id] = inst
    const count = Object.values(layout.instances).filter((i) => i.panelType === panelType).length
    const tab: Tab = {
      id: genNodeId('tab'),
      panelType,
      title: defaultTitle(panelType, count),
      instanceId: inst.id
    }
    pane.tabs.push(tab)
    pane.activeTabId = tab.id
    return inst.id
  }

  return {
    layout: INITIAL_LAYOUT,
    paneRects: {},
    containerOrigin: { x: 0, y: 0 },

    hydrate: (layout) => set({ layout }),
    setPaneRect: (paneId, rect) => set((s) => ({ paneRects: { ...s.paneRects, [paneId]: rect } })),
    setContainerOrigin: (o) => set({ containerOrigin: o }),
    setActiveTab: (paneId, tabId) =>
      set((s) => {
        const pane = s.layout.byId[paneId]
        if (!pane || isSplit(pane)) return {}
        const byId = { ...s.layout.byId }
        byId[paneId] = { ...pane, activeTabId: tabId }
        return { layout: { ...s.layout, byId } }
      }),

    openPanel: (paneId, panelType) => {
      const layout = cloneLayout(get().layout)
      const instanceId = openPanelInto(layout, paneId, panelType)
      if (instanceId === null) return null
      set({ layout })
      return instanceId
    },

    addTab: (paneId, panelType) => {
      const layout = cloneLayout(get().layout)
      openPanelInto(layout, paneId, panelType)
      set({ layout })
    },

    closeTab: (paneId, tabId) =>
      set((s) => {
        const layout = cloneLayout(s.layout)
        const pane = layout.byId[paneId]
        if (!pane || isSplit(pane) || pane.anchor) return {}
        const idx = pane.tabs.findIndex((t) => t.id === tabId)
        if (idx < 0) return {}
        const tab = pane.tabs[idx]
        if (tab.instanceId) delete layout.instances[tab.instanceId]
        pane.tabs.splice(idx, 1)
        if (pane.activeTabId === tabId) {
          pane.activeTabId = pane.tabs.length > 0 ? pane.tabs[Math.min(idx, pane.tabs.length - 1)].id : null
        }
        if (pane.tabs.length === 0) closePaneInner(layout, paneId)
        return { layout }
      }),

    closePane: (paneId) =>
      set((s) => {
        const layout = cloneLayout(s.layout)
        const pane = layout.byId[paneId]
        if (!pane || isSplit(pane) || pane.anchor || layout.rootId === paneId) return {}
        closePaneInner(layout, paneId)
        return { layout }
      }),

    splitPane: (nodeId, direction, panelType) => {
      const layout = cloneLayout(get().layout)
      const target = layout.byId[nodeId]
      if (!target) return ''
      const newPaneId = genNodeId('pane')
      const newPane: Pane = { id: newPaneId, kind: 'pane', tabs: [], activeTabId: null }
      layout.byId[newPaneId] = newPane
      if (panelType) {
        const instanceId = openPanelInto(layout, newPaneId, panelType)
        void instanceId
      }
      const splitId = genNodeId('split')
      const split: SplitNode = {
        id: splitId,
        kind: 'split',
        direction,
        ratio: 0.5,
        children: [nodeId, newPaneId]
      }
      layout.byId[splitId] = split
      if (nodeId === layout.rootId) {
        layout.rootId = splitId
      } else {
        const p = findParent(layout, nodeId)
        if (p) p.parent.children[p.index] = splitId
      }
      set({ layout })
      return newPaneId
    },

    setRatio: (nodeId, ratio) =>
      set((s) => {
        const node = s.layout.byId[nodeId]
        if (!node || isPane(node)) return {}
        const byId = { ...s.layout.byId }
        byId[nodeId] = { ...node, ratio: clampRatio(ratio) }
        return { layout: { ...s.layout, byId } }
      }),

    moveTab: (fromPaneId, toPaneId, tabId) =>
      set((s) => {
        const layout = cloneLayout(s.layout)
        const from = layout.byId[fromPaneId]
        const to = layout.byId[toPaneId]
        if (!from || isSplit(from) || !to || isSplit(to)) return {}
        // Desktop 加固（issue 71）：对话锚点的页签不可移出，否则锚点窗格会被收缩删除，
        // 恢复框架就失去了不可关闭的对话承载。
        if (from.anchor) return {}
        const idx = from.tabs.findIndex((t) => t.id === tabId)
        if (idx < 0) return {}
        const [tab] = from.tabs.splice(idx, 1)
        if (tab.instanceId) {
          const inst = layout.instances[tab.instanceId]
          if (inst) inst.paneId = toPaneId
        }
        to.tabs.push(tab)
        to.activeTabId = tab.id
        if (from.tabs.length === 0) closePaneInner(layout, fromPaneId)
        return { layout }
      }),

    swapPanes: (a, b) =>
      set((s) => {
        const layout = cloneLayout(s.layout)
        const pa = findParent(layout, a)
        const pb = findParent(layout, b)
        if (!pa || !pb || pa.parent.id !== pb.parent.id) return {}
        const parent = pa.parent
        parent.children[pa.index] = b
        parent.children[pb.index] = a
        return { layout }
      }),

    movePaneBeside: (paneId, targetPaneId) =>
      set((s) => {
        const layout = cloneLayout(s.layout)
        if (paneId === targetPaneId) return {}
        const target = layout.byId[targetPaneId]
        if (!target || isSplit(target)) return {}
        // 抽出被拖的窗格（归档其子节点引用，稍后放回），若父分屏收缩可能影响 target 的位置
        const node = extractNode(layout, paneId)
        if (!node) return {}
        // 抽出后 target 可能已被父收缩所移动/替换，重新定位
        const t = layout.byId[targetPaneId]
        if (!t || isSplit(t)) {
          // target 意外被移除：把抽出的窗格放回根
          layout.byId[paneId] = node
          if (!layout.rootId) layout.rootId = paneId
          return { layout }
        }
        // target 为根：把根成为新分屏的子，抽出窗格并排
        const tp = findParent(layout, targetPaneId)
        if (!tp) {
          const splitId = genNodeId('split')
          layout.byId[splitId] = {
            id: splitId,
            kind: 'split',
            direction: 'row',
            ratio: 0.5,
            children: [targetPaneId, paneId]
          }
          layout.byId[paneId] = node
          layout.rootId = splitId
          return { layout }
        }
        // 插入 target 旁
        const idx = tp.parent.children.indexOf(targetPaneId)
        layout.byId[paneId] = node
        tp.parent.children.splice(idx + 1, 0, paneId)
        return { layout }
      }),

    splitBeside: (targetPaneId, payload, side) =>
      set((s) => {
        const layout = cloneLayout(s.layout)
        const target = layout.byId[targetPaneId]
        if (!target || isSplit(target)) return {}

        // 取得要放置的节点：窗格本体，或由页签抽成的新窗格
        let placedId: string
        if (payload.kind === 'pane') {
          if (payload.paneId === targetPaneId) return {}
          const node = extractNode(layout, payload.paneId)
          if (!node) return {}
          layout.byId[payload.paneId] = node
          placedId = payload.paneId
        } else {
          const from = layout.byId[payload.fromPaneId]
          if (!from || isSplit(from)) return {}
          // 锚点页签不可抽出新窗格（同 moveTab 的锚点加固）
          if (from.anchor) return {}
          const idx = from.tabs.findIndex((t) => t.id === payload.tabId)
          if (idx < 0) return {}
          const [tab] = from.tabs.splice(idx, 1)
          const newPaneId = genNodeId('pane')
          layout.byId[newPaneId] = { id: newPaneId, kind: 'pane', tabs: [tab], activeTabId: tab.id }
          if (tab.instanceId) {
            const inst = layout.instances[tab.instanceId]
            if (inst) inst.paneId = newPaneId
          }
          if (from.tabs.length === 0) closePaneInner(layout, payload.fromPaneId)
          placedId = newPaneId
        }

        // 抽取可能改了树（父分屏收缩），重新定位 target
        if (!layout.byId[targetPaneId]) return {}
        const parent = findParent(layout, targetPaneId)
        const direction = side === 'left' || side === 'right' ? 'row' : 'col'
        const after = side === 'right' || side === 'bottom'

        if (!parent) {
          const splitId = genNodeId('split')
          layout.byId[splitId] = {
            id: splitId,
            kind: 'split',
            direction,
            ratio: 0.5,
            children: after ? [targetPaneId, placedId] : [placedId, targetPaneId]
          }
          layout.rootId = splitId
          return { layout }
        }
        if (parent.parent.direction === direction) {
          const idx = parent.parent.children.indexOf(targetPaneId)
          parent.parent.children.splice(after ? idx + 1 : idx, 0, placedId)
        } else {
          const splitId = genNodeId('split')
          layout.byId[splitId] = {
            id: splitId,
            kind: 'split',
            direction,
            ratio: 0.5,
            children: after ? [targetPaneId, placedId] : [placedId, targetPaneId]
          }
          parent.parent.children[parent.index] = splitId
        }
        return { layout }
      }),

    openPanelType: (panelType) => {
      const s = get()
      const panes = collectPanes(s.layout)
      const withType = panes.find((p) => !p.anchor && p.tabs.some((t) => t.panelType === panelType))
      if (withType) {
        const tab = withType.tabs.find((t) => t.panelType === panelType)
        if (tab) s.setActiveTab(withType.id, tab.id)
        return
      }
      const target = panes.find((p) => !p.anchor)
      if (target) {
        void s.openPanel(target.id, panelType)
        return
      }
      const anchor = findAnchorPane(s.layout)
      if (anchor) {
        void s.splitPane(anchor.id, 'row', panelType)
      }
    },

    restoreCompanionPane: () => {
      const s = get()
      // 已有非锚点窗格 → 无需恢复
      if (collectPanes(s.layout).some((p) => !p.anchor)) return
      const anchor = findAnchorPane(s.layout)
      if (!anchor) return
      const layout = cloneLayout(s.layout)
      const anchorNode = layout.byId[anchor.id]
      if (!anchorNode || isSplit(anchorNode)) return

      // Desktop 的伴随窗格承载本机 Runtime（设备连接与任务状态），不再复刻原版浏览器/终端组合
      const companionId = genNodeId('pane')
      const companion: Pane = { id: companionId, kind: 'pane', tabs: [], activeTabId: null }
      const runtimeInst = makeInstance('runtime', companionId)
      layout.instances[runtimeInst.id] = runtimeInst
      const runtimeTab: Tab = {
        id: genNodeId('tab'),
        panelType: 'runtime',
        title: defaultTitle('runtime', 1),
        instanceId: runtimeInst.id
      }
      companion.tabs = [runtimeTab]
      companion.activeTabId = runtimeTab.id
      layout.byId[companionId] = companion

      const splitId = genNodeId('split')
      layout.byId[splitId] = {
        id: splitId,
        kind: 'split',
        direction: 'row',
        ratio: 0.68,
        children: [anchor.id, companionId]
      }
      layout.rootId = splitId
      set({ layout })
    }
  }
})

// —— 便捷选择器 ——
export function useAnchorPane(): Pane | null {
  return useDockStore((s) => {
    for (const key of Object.keys(s.layout.byId)) {
      const n = s.layout.byId[key]
      if (isPane(n) && n.anchor) return n
    }
    return null
  })
}

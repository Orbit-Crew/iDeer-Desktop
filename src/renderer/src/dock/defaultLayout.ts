// Desktop default first-run layout (issue 71): the chat anchor on the left and
// the device Runtime pane on the right. The original linz default opened a
// browser/terminal/files tools pane; those panes are not wired in this phase,
// so the honest Desktop companion is the Runtime pane that already carries the
// device connection and task surfaces.
import { genNodeId, makeInstance } from './types'
import type {
  DockLayout,
  Pane,
  PanelInstance,
  PanelTypeId,
  SplitNode,
  Tab
} from './types'

function tabFor(panelType: PanelTypeId, title: string, instanceId?: string): Tab {
  return { id: genNodeId('tab'), panelType, title, instanceId }
}

/** 默认首启布局：左边锚点(chat)，右边"本机 Runtime"伴随窗格，与桌面现状一致 */
export function buildDefaultLayout(): DockLayout {
  const anchorId = genNodeId('pane')
  const companionId = genNodeId('pane')
  const rootId = genNodeId('split')

  const anchorTab = tabFor('chat', '对话')
  const anchor: Pane = {
    id: anchorId,
    kind: 'pane',
    tabs: [anchorTab],
    activeTabId: anchorTab.id,
    anchor: true
  }

  const instances: Record<string, PanelInstance> = {}
  const runtimeInst = makeInstance('runtime', companionId)
  instances[runtimeInst.id] = runtimeInst

  const runtimeTab = tabFor('runtime', '本机 Runtime', runtimeInst.id)
  const companion: Pane = {
    id: companionId,
    kind: 'pane',
    tabs: [runtimeTab],
    activeTabId: runtimeTab.id
  }

  const root: SplitNode = {
    id: rootId,
    kind: 'split',
    direction: 'row',
    ratio: 0.68,
    children: [anchorId, companionId]
  }

  return {
    version: 1,
    rootId,
    byId: { [anchorId]: anchor, [companionId]: companion, [rootId]: root },
    instances
  }
}

/** 首启/hydrate 兜底：保证存在且仅存在一个锚点窗格 */
export function ensureAnchorPane(layout: DockLayout): DockLayout {
  const hasAnchor = Object.values(layout.byId).some(
    (n) => n.kind === 'pane' && (n as Pane).anchor
  )
  if (hasAnchor) return layout
  // 无锚点：临时建一个，挂到根
  const anchorId = genNodeId('pane')
  const anchorTab = tabFor('chat', '对话')
  const anchor: Pane = {
    id: anchorId,
    kind: 'pane',
    tabs: [anchorTab],
    activeTabId: anchorTab.id,
    anchor: true
  }
  layout.byId[anchorId] = anchor
  if (!layout.rootId) {
    layout.rootId = anchorId
  } else {
    const root = layout.byId[layout.rootId]
    if (root && root.kind === 'split') {
      root.children.push(anchorId)
    } else {
      // Desktop 加固（issue 71）：根是单个窗格或悬空引用时，把原根与锚点包成一个
      // 分屏，保证补建的锚点真正接入渲染树，而不是只存在于 byId 里不可达。
      const splitId = genNodeId('split')
      layout.byId[splitId] = {
        id: splitId,
        kind: 'split',
        direction: 'row',
        ratio: 0.68,
        children: [layout.rootId, anchorId]
      }
      layout.rootId = splitId
    }
  }
  return layout
}

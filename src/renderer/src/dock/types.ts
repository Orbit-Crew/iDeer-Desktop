// Restores the pinned linz dock type model (issue 71). `runtime` is a
// Desktop-only native pane that keeps the device platform surfaces inside the
// restored framework; every other id keeps its original linz vocabulary and
// column position, so unwired capabilities stay visible where they used to be.
import type { ComponentType, ReactNode } from 'react'

export type PanelTypeId =
  | 'chat'
  | 'runtime'
  | 'browser'
  | 'terminal'
  | 'files'
  | 'kb'
  | 'viewer3d'
  | 'field'
  | 'sql'
  | 'synapse'

export type PanelRuntime = 'native' | 'webview' | 'pty' | 'webgl'

export interface PanelTypeDef {
  id: PanelTypeId
  title: string
  icon: ReactNode
  /** 渲染该面板实例的组件；instanceId 唯一标识一个实例（用于 store 寻址会话/状态） */
  component: ComponentType<{ instanceId: string; panelType: PanelTypeId }>
  /** browser/terminal 允许多实例 → 页签条列出实例；否则单实例聚焦或创建 */
  multiInstance: boolean
  closable: boolean
  /** chat：锚点窗格，不可关闭/不可拖走 */
  anchorOnly?: boolean
  runtime: PanelRuntime
}

export interface Tab {
  id: string
  panelType: PanelTypeId
  title: string
  /** 指向 overlay 中的 PanelInstance；多实例面板用它定位内容 */
  instanceId?: string
  pinned?: boolean
}

export interface Pane {
  id: string
  kind: 'pane'
  tabs: Tab[]
  activeTabId: string | null
  /** chat 锚点：不可关闭、不可拖走 */
  anchor?: boolean
  closed?: boolean
}

export type DockNode = SplitNode | Pane

export interface SplitNode {
  id: string
  kind: 'split'
  direction: 'row' | 'col'
  /** 第一个孩子占父容器比例（0~1），第二个孩子为 1-ratio */
  ratio: number
  /** 归一化存储：children 存节点 id，节点本体在 DockLayout.byId */
  children: string[]
}

export interface PanelInstance {
  id: string
  /** 所属窗格；移动页签/窗格只需改 paneId → overlay 重定位，组件不重挂载 */
  paneId: string
  panelType: PanelTypeId
  sessionId?: string | null
  url?: string
  state?: unknown
}

export interface DockLayout {
  version: number
  rootId: string
  byId: Record<string, DockNode>
  instances: Record<string, PanelInstance>
}

let nodeSeq = 0
export function genNodeId(prefix: string): string {
  nodeSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${nodeSeq}`
}

/** 面板实例工厂：与 store 解耦，供 defaultLayout / layoutPresets 在构建布局时使用 */
export function makeInstance(panelType: PanelTypeId, paneId: string): PanelInstance {
  return { id: genNodeId('inst'), paneId, panelType }
}

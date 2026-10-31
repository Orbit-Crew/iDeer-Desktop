// Panel registry (issue 71): the dock's composable components. The chat anchor
// hosts the platform chat; the Desktop runtime pane carries the device
// surfaces; the remaining original vocabulary keeps its column position with
// honest placeholders until its phase lands. `sql` stays meta-only, exactly as
// in the pinned linz source (it was never a delivered original pane).
import {
  ApartmentOutlined,
  CodeOutlined,
  DeploymentUnitOutlined,
  DesktopOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LineChartOutlined,
  MessageOutlined,
  SearchOutlined
} from '@ant-design/icons'
import type { PanelTypeDef, PanelTypeId } from './types'
import { getPanelMeta } from './panelMeta'
import ChatPanel from '../components/ChatPanel'
import RuntimePane from './panels/runtimePane'
import ExternalPanePlaceholder from './panels/externalPanes'
import UnwiredNativePane from './panels/unwiredPanes'

/** chat 锚点内容：桌面平台聊天（无路由，锚点窗格直接承载） */
export function ChatAnchorContent(): JSX.Element {
  return <ChatPanel />
}

/**
 * 面板注册表：加载到 dock 里的可组合组件。
 * chat/runtime 已接线；其余按原栏目位置注册为如实占位，能力在对应阶段接入。
 * 安全缝（test/security.test.ts）：非 native 窗格必须映射 externalPanes 模块的占位组件。
 */
export const PANEL_REGISTRY: PanelTypeDef[] = [
  { ...getPanelMeta('chat'), icon: <MessageOutlined />, component: ChatAnchorContent },
  { ...getPanelMeta('runtime'), icon: <DesktopOutlined />, component: RuntimePane },
  { ...getPanelMeta('browser'), icon: <GlobalOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('terminal'), icon: <CodeOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('files'), icon: <FolderOpenOutlined />, component: UnwiredNativePane },
  { ...getPanelMeta('kb'), icon: <SearchOutlined />, component: UnwiredNativePane },
  { ...getPanelMeta('viewer3d'), icon: <DeploymentUnitOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('field'), icon: <LineChartOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('synapse'), icon: <ApartmentOutlined />, component: ExternalPanePlaceholder }
]

const registryMap = new Map(PANEL_REGISTRY.map((p) => [p.id, p]))

export function getRegisteredPanel(id: PanelTypeId) {
  return registryMap.get(id)
}

/** 图标备忘（供 AddPanelPicker / 页签条使用）；未随组件注册的这里给个兜底 */
export function panelIcon(id: PanelTypeId): JSX.Element {
  switch (id) {
    case 'chat':
      return <MessageOutlined />
    case 'runtime':
      return <DesktopOutlined />
    case 'browser':
      return <GlobalOutlined />
    case 'terminal':
      return <CodeOutlined />
    case 'files':
      return <FolderOpenOutlined />
    case 'kb':
      return <SearchOutlined />
    case 'viewer3d':
      return <DeploymentUnitOutlined />
    case 'field':
      return <LineChartOutlined />
    case 'synapse':
      return <ApartmentOutlined />
    default:
      return <FolderOpenOutlined />
  }
}

// Panel registry (issue 71): the dock's composable components. The chat anchor
// hosts the platform chat; the Desktop runtime pane carries the device
// surfaces; the remaining original vocabulary keeps its column position with
// honest placeholders until its phase lands. `sql` stays meta-only, exactly as
// in the pinned linz source (it was never a delivered original pane).
import {
  ApartmentOutlined,
  BellOutlined,
  CodeOutlined,
  DeploymentUnitOutlined,
  DesktopOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LineChartOutlined,
  MessageOutlined,
  SearchOutlined,
  SnippetsOutlined
} from '@ant-design/icons'
import type { PanelTypeDef, PanelTypeId } from './types'
import { getPanelMeta } from './panelMeta'
import ChatPanel from '../components/ChatPanel'
import RuntimePane from './panels/runtimePane'
import NotificationsPane from './panels/notificationsPane'
import FilePane from './panels/filePane'
import BrowserSlotPane from './panels/browserSlotPane'
import TemplatesPane from './panels/templatesPane'
import ExternalPanePlaceholder from './panels/externalPanes'
import UnwiredNativePane from './panels/unwiredPanes'

/** chat 锚点内容：桌面平台聊天（无路由，锚点窗格直接承载） */
export function ChatAnchorContent(): JSX.Element {
  return <ChatPanel />
}

/**
 * 面板注册表：加载到 dock 里的可组合组件。
 * chat/runtime/files/templates 已接线；browser 槽位自 #107/#109 起在同一个显式 本机/远端
 * 选择后承载两种浏览器：本机为固定分区 webview（主进程附加守卫），远端为平台像素流（无
 * webview、屏面组件不进可信桥），二者绝不静默互切；其余按原栏目位置注册为如实占位，
 * 能力在对应阶段接入。
 * 安全缝（test/security.test.ts）：externalPanes 占位与 remoteBrowser 屏面模块的
 * 模块图都不含可信桥；browser 槽位由 browserSlotPane 显式承载两种位置。
 */
export const PANEL_REGISTRY: PanelTypeDef[] = [
  { ...getPanelMeta('chat'), icon: <MessageOutlined />, component: ChatAnchorContent },
  { ...getPanelMeta('runtime'), icon: <DesktopOutlined />, component: RuntimePane },
  // Issues 107 + 109: the browser slot merges both entries behind one
  // explicit 本机/远端 choice — never a silent switch. 本机 is the local
  // webview pane (fixed partition, main-process attach guard); 远端 is the
  // platform's pixel-stream pane (no webview, permanent 远端 badge, the
  // pixel surface stays out of the trusted bridge). These facts are pinned
  // by test/security.test.ts and test/browser-slot.test.tsx.
  { ...getPanelMeta('browser'), icon: <GlobalOutlined />, component: BrowserSlotPane },
  { ...getPanelMeta('terminal'), icon: <CodeOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('files'), icon: <FolderOpenOutlined />, component: FilePane },
  { ...getPanelMeta('kb'), icon: <SearchOutlined />, component: UnwiredNativePane },
  { ...getPanelMeta('viewer3d'), icon: <DeploymentUnitOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('field'), icon: <LineChartOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('synapse'), icon: <ApartmentOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('notifications'), icon: <BellOutlined />, component: NotificationsPane },
  { ...getPanelMeta('templates'), icon: <SnippetsOutlined />, component: TemplatesPane }
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
    case 'notifications':
      return <BellOutlined />
    case 'templates':
      return <SnippetsOutlined />
    default:
      return <FolderOpenOutlined />
  }
}

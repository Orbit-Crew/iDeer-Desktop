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
  SearchOutlined
} from '@ant-design/icons'
import type { PanelTypeDef, PanelTypeId } from './types'
import { getPanelMeta } from './panelMeta'
import ChatPanel from '../components/ChatPanel'
import RuntimePane from './panels/runtimePane'
import NotificationsPane from './panels/notificationsPane'
import FilePane from './panels/filePane'
import RemoteBrowserPane from './panels/remoteBrowserPane'
import ExternalPanePlaceholder from './panels/externalPanes'
import UnwiredNativePane from './panels/unwiredPanes'

/** chat 锚点内容：桌面平台聊天（无路由，锚点窗格直接承载） */
export function ChatAnchorContent(): JSX.Element {
  return <ChatPanel />
}

/**
 * 面板注册表：加载到 dock 里的可组合组件。
 * chat/runtime/files 已接线；browser 槽位自 #109 起承载平台远端浏览器（画面为像素、
 * 无 webview、屏面组件不进可信桥）；其余按原栏目位置注册为如实占位，能力在对应阶段接入。
 * 安全缝（test/security.test.ts）：externalPanes 占位与 remoteBrowser 屏面模块的
 * 模块图都不含可信桥；主窗口外部内容守卫保持关闭。
 */
export const PANEL_REGISTRY: PanelTypeDef[] = [
  { ...getPanelMeta('chat'), icon: <MessageOutlined />, component: ChatAnchorContent },
  { ...getPanelMeta('runtime'), icon: <DesktopOutlined />, component: RuntimePane },
  // Issue 109: the browser slot renders the platform's REMOTE browser (the
  // permanent 远端 badge lives in the pane chrome). The local-browser webview
  // side is open PR #136's seam; when it lands the slot merges the two entries
  // behind an explicit 本机/远端 choice — never a silent switch. The pane
  // embeds no webview and the pixel surface (RemoteScreenSurface) stays out
  // of the trusted bridge; both facts are pinned by test/security.test.ts.
  { ...getPanelMeta('browser'), icon: <GlobalOutlined />, component: RemoteBrowserPane },
  { ...getPanelMeta('terminal'), icon: <CodeOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('files'), icon: <FolderOpenOutlined />, component: FilePane },
  { ...getPanelMeta('kb'), icon: <SearchOutlined />, component: UnwiredNativePane },
  { ...getPanelMeta('viewer3d'), icon: <DeploymentUnitOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('field'), icon: <LineChartOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('synapse'), icon: <ApartmentOutlined />, component: ExternalPanePlaceholder },
  { ...getPanelMeta('notifications'), icon: <BellOutlined />, component: NotificationsPane }
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
    default:
      return <FolderOpenOutlined />
  }
}

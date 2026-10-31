// Issue 71: the main area becomes the restored linz dock workspace — the chat
// anchor plus splittable panes. The former stacked connection/runtime/update/
// compatibility cards move into the device Runtime pane; the sidebar keeps its
// width and collapse rail.
import { DoubleRightOutlined } from '@ant-design/icons'
import { useUIStore } from '../../stores/uiStore'
import Sidebar from './Sidebar'
import DockWorkspace from '../../dock/DockWorkspace'

export default function AppLayout(): JSX.Element {
  const leftPanelOpen = useUIStore((state) => state.leftPanelOpen)
  const toggleLeftPanel = useUIStore((state) => state.toggleLeftPanel)
  return (
    <div data-desktop-ready="true" className="flex h-screen w-screen overflow-hidden">
      <div className="relative flex-shrink-0 h-full overflow-hidden border-r border-line bg-white"
        style={{ width: leftPanelOpen ? 260 : 20, transition: 'width 0.2s ease-in-out' }}>
        {leftPanelOpen ? <Sidebar /> : (
          <button onClick={toggleLeftPanel} className="w-5 pt-4 text-gray-400"
            title="显示侧边栏" aria-label="显示侧边栏">
            <DoubleRightOutlined style={{ fontSize: 12 }} />
          </button>
        )}
      </div>
      <main className="flex-1 min-w-0 h-full relative overflow-hidden flex">
        <DockWorkspace />
      </main>
    </div>
  )
}

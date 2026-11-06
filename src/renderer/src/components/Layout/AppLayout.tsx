// Issue 71: the main area becomes the restored linz dock workspace — the chat
// anchor plus splittable panes. The former stacked connection/runtime/update/
// compatibility cards move into the device Runtime pane; the sidebar keeps its
// width and collapse rail.
import { useEffect } from 'react'
import { DoubleRightOutlined } from '@ant-design/icons'
import { useUIStore } from '../../stores/uiStore'
import { NotificationCenterController, useNotificationCenter } from '../../stores/notificationCenter'
import { ScheduledTasksController, useScheduledTasks } from '../../stores/scheduledTasks'
import Sidebar from './Sidebar'
import DockWorkspace from '../../dock/DockWorkspace'

export default function AppLayout(): JSX.Element {
  const leftPanelOpen = useUIStore((state) => state.leftPanelOpen)
  const toggleLeftPanel = useUIStore((state) => state.toggleLeftPanel)
  // Issue 77: the notification center listens for the whole app lifetime so
  // an OS-toast click can jump back even when the center pane is closed.
  useEffect(() => {
    const controller = new NotificationCenterController(window.ideer)
    useNotificationCenter.getState().attach(controller)
    controller.start()
    return () => {
      controller.stop()
      useNotificationCenter.getState().attach(null)
    }
  }, [])
  // Issue 85: the scheduled-tasks controller lives for the whole app too —
  // the Runtime pane's card acts through it from anywhere in the dock.
  useEffect(() => {
    const controller = new ScheduledTasksController(window.ideer)
    useScheduledTasks.getState().attach(controller)
    return () => { useScheduledTasks.getState().attach(null) }
  }, [])
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

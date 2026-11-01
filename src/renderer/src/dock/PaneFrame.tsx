// Pane chrome from the pinned linz dock (issue 71): draggable title bar, tab
// strip, four-side split drop targets. The anchor branch hosts the chat
// surface directly (Desktop has no router; the original rendered <Outlet/>).
import { memo, useEffect, useRef, useState } from 'react'
import { HolderOutlined, CloseOutlined } from '@ant-design/icons'
import { Button, Tooltip } from 'antd'
import { useDockStore, TAB_DND, PANE_DND, FROM_PANE_DND, sideFromPoint } from './dockStore'
import { panelIcon, ChatAnchorContent } from './panelRegistry'
import { getPanelMeta } from './panelMeta'
import AddPanelPicker from './AddPanelPicker'
import type { Pane, Tab } from './types'

interface PaneFrameProps {
  pane: Pane
}

function PaneFrame({ pane }: PaneFrameProps): JSX.Element {
  const setActiveTab = useDockStore((s) => s.setActiveTab)
  const closeTab = useDockStore((s) => s.closeTab)
  const closePane = useDockStore((s) => s.closePane)
  const moveTab = useDockStore((s) => s.moveTab)
  const movePaneBeside = useDockStore((s) => s.movePaneBeside)
  const splitBeside = useDockStore((s) => s.splitBeside)
  const setPaneRect = useDockStore((s) => s.setPaneRect)

  const contentRef = useRef<HTMLDivElement | null>(null)
  const [dropSrc, setDropSrc] = useState<string | null>(null)

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]

  // 上报内容盒 rect（视口坐标 - 容器原点 = 相对容器的 rect，供 overlay 定位）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      const o = useDockStore.getState().containerOrigin
      setPaneRect(pane.id, { x: r.x - o.x, y: r.y - o.y, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pane.id, setPaneRect])

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropSrc(pane.id)
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropSrc(null)
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    const dx = (e.clientX - rect.left) / w
    const dy = (e.clientY - rect.top) / h
    const side = sideFromPoint(dx, dy)
    const nearEdge = dx < 0.3 || dx > 0.7 || dy < 0.3 || dy > 0.7
    const tabId = e.dataTransfer.getData(TAB_DND)
    const fromPane = e.dataTransfer.getData(FROM_PANE_DND)
    const dragPane = e.dataTransfer.getData(PANE_DND)
    if (tabId && fromPane) {
      if (pane.anchor) {
        // 锚点不可并入页签 → 一律在其侧向分屏
        splitBeside(pane.id, { kind: 'tab', tabId, fromPaneId: fromPane }, side)
      } else if (nearEdge) {
        splitBeside(pane.id, { kind: 'tab', tabId, fromPaneId: fromPane }, side)
      } else {
        moveTab(fromPane, pane.id, tabId)
      }
    } else if (dragPane && dragPane !== pane.id) {
      splitBeside(pane.id, { kind: 'pane', paneId: dragPane }, side)
    }
  }

  const tabDragStart =
    (tab: Tab) =>
    (e: React.DragEvent): void => {
      e.dataTransfer.setData(TAB_DND, tab.id)
      e.dataTransfer.setData(FROM_PANE_DND, pane.id)
      e.dataTransfer.effectAllowed = 'move'
      e.stopPropagation()
    }
  const paneDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData(PANE_DND, pane.id)
    e.dataTransfer.effectAllowed = 'move'
    e.stopPropagation()
  }

  // 锚点（对话）：无 chrome，始终渲染平台聊天；锚点不可拖拽/关闭，但可作为其它面板的分屏落点
  if (pane.anchor) {
    return (
      <div
        className={`h-full w-full min-w-0 overflow-hidden relative ${
          dropSrc ? 'ring-2 ring-primary/40' : ''
        }`}
        style={{ background: 'var(--pane-bg, #FFFFFF)' }}
        onDragOver={onDragOver}
        onDragLeave={() => setDropSrc(null)}
        onDrop={onDrop}
      >
        <ChatAnchorContent />
      </div>
    )
  }

  const paneTitle = activeTab ? getPanelMeta(activeTab.panelType).title : '面板'

  return (
    <div
      className={`h-full flex flex-col border border-line-light overflow-hidden ${
        dropSrc ? 'ring-2 ring-primary/40' : ''
      }`}
      style={{ background: 'var(--pane-bg, #FFFFFF)' }}
      onDragOver={onDragOver}
      onDragLeave={() => setDropSrc(null)}
      onDrop={onDrop}
    >
      {/* 标题栏：可拖拽移动窗格 */}
      <div
        draggable
        onDragStart={paneDragStart}
        className="flex items-center gap-1 px-2 h-9 border-b border-gray-200 bg-gray-50 flex-shrink-0 cursor-grab"
        title="拖拽到另一窗格旁进行分屏"
      >
        <HolderOutlined className="text-gray-300 text-xs mr-1" />
        <span className="text-xs font-medium text-gray-700 truncate flex-1">{paneTitle}</span>
        <AddPanelPicker paneId={pane.id} title="添加面板" />
        <Tooltip title="关闭窗格">
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined style={{ fontSize: 11 }} />}
            onClick={() => closePane(pane.id)}
          />
        </Tooltip>
      </div>

      {/* 页签条：页签可拖拽到另一窗格 */}
      {pane.tabs.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-200 bg-gray-50 overflow-x-auto flex-shrink-0">
          {pane.tabs.map((tab) => {
            const act = tab.id === activeTab?.id
            return (
              <div
                key={tab.id}
                draggable
                onDragStart={tabDragStart(tab)}
                onClick={() => setActiveTab(pane.id, tab.id)}
                className={`group flex items-center gap-1 pl-2 pr-1 py-0.5 rounded text-xs cursor-pointer transition-colors flex-shrink-0 ${
                  act
                    ? 'bg-white text-primary border border-gray-200'
                    : 'text-gray-600 hover:bg-gray-100 border border-transparent'
                }`}
                title={getPanelMeta(tab.panelType).title}
              >
                <span className="text-primary/80">{panelIcon(tab.panelType)}</span>
                <span className="max-w-[110px] truncate">{tab.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(pane.id, tab.id)
                  }}
                  className="opacity-50 group-hover:opacity-100 hover:text-red-500 transition-opacity p-0.5"
                  title="关闭页签"
                >
                  <CloseOutlined style={{ fontSize: 9 }} />
                </button>
              </div>
            )
          })}
          <div className="flex-1" />
        </div>
      )}

      {/* 内容区：空壳，实时上报 rect（真实内容在 InstanceHostOverlay） */}
      <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden relative" />
    </div>
  )
}

export default memo(PaneFrame)

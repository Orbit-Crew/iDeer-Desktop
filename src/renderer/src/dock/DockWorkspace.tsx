// Dock workspace from the pinned linz dock (issue 71): renders the split tree,
// the content overlay, and the layout-arrangement button. Without a layout it
// renders the chat anchor directly (Desktop has no router; the original
// rendered <Outlet/> there).
import { Fragment, memo, useEffect, useRef } from 'react'
import PaneFrame from './PaneFrame'
import InstanceHostOverlay from './InstanceHostOverlay'
import LayoutPresetDropdown from './LayoutPresetDropdown'
import { ChatAnchorContent } from './panelRegistry'
import { useDockStore, isSplit } from './dockStore'
import { useUIStore } from '../stores/uiStore'
import type { DockNode, SplitNode } from './types'

function flexFor(index: number, count: number, ratio: number): React.CSSProperties {
  if (count === 1) return { flexGrow: 1, flexShrink: 1, flexBasis: '0%' }
  if (index === 0) return { flexGrow: ratio, flexShrink: 1, flexBasis: '0%' }
  return { flexGrow: (1 - ratio) / (count - 1), flexShrink: 1, flexBasis: '0%' }
}

function SplitDivider({ splitId, direction }: { splitId: string; direction: 'row' | 'col' }): JSX.Element {
  const setRatio = useDockStore((s) => s.setRatio)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const container = el.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    const len = direction === 'row' ? rect.width : rect.height
    if (len <= 0) return
    const left = direction === 'row' ? rect.left : rect.top

    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 忽略（某些环境不支持）
    }

    document.body.style.cursor = direction === 'row' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: PointerEvent): void => {
      const pos = (direction === 'row' ? ev.clientX : ev.clientY) - left
      const nxt = pos / len
      if (!Number.isNaN(nxt)) setRatio(splitId, nxt)
    }
    const onUp = (): void => {
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // 忽略
      }
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      className={
        direction === 'row'
          ? 'w-1 h-full cursor-col-resize hover:bg-primary/40 transition-colors flex-shrink-0 z-10'
          : 'h-1 w-full cursor-row-resize hover:bg-primary/40 transition-colors flex-shrink-0 z-10'
      }
      title="拖拽调整大小"
    />
  )
}

const Split = memo(function SplitTransform({ split }: { split: SplitNode }): JSX.Element {
  const byId = useDockStore((s) => s.layout.byId)
  const rootId = useDockStore((s) => s.layout.rootId)
  const companionVisible = useUIStore((s) => s.companionPanesVisible)
  const children = split.children.map((id) => byId[id]).filter(Boolean) as DockNode[]
  const direction = split.direction
  const count = children.length
  const isTopRowSplit = split.id === rootId && direction === 'row'

  return (
    <div
      className={`flex h-full w-full min-w-0 min-h-0 overflow-hidden ${
        direction === 'row' ? 'flex-row' : 'flex-col'
      }`}
    >
      {children.map((child, i) => {
        // 顶层行分割的非首子节点 = 右侧伴生窗格；收起时 flex-grow 归零实现滑动隐藏
        const collapsed = !companionVisible && isTopRowSplit && i > 0
        return (
          <Fragment key={child.id}>
            {i > 0 && !collapsed && <SplitDivider splitId={split.id} direction={direction} />}
            <div
              className={`${direction === 'row' ? 'h-full' : 'w-full'} min-w-0 min-h-0 overflow-hidden`}
              style={{
                ...(collapsed
                  ? { flexGrow: 0, flexShrink: 0, flexBasis: '0%' }
                  : flexFor(i, count, split.ratio)),
                transition: 'flex-grow 0.2s ease-in-out'
              }}
            >
              <NodeRenderer node={child} />
            </div>
          </Fragment>
        )
      })}
    </div>
  )
})

function NodeRenderer({ node }: { node: DockNode }): JSX.Element {
  if (isSplit(node)) return <Split split={node} />
  return <PaneFrame pane={node} />
}

export default function DockWorkspace(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const root = useDockStore((s) => (s.layout.rootId ? s.layout.byId[s.layout.rootId] : null))
  const setContainerOrigin = useDockStore((s) => s.setContainerOrigin)

  // 上报容器原点，供窗格内容盒换算相对 rect
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      setContainerOrigin({ x: r.left, y: r.top })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [setContainerOrigin])

  // 无布局时直接渲染聊天；有布局时始终渲染拆分树（右侧窗格的显隐由 Split 内部 flex 过渡处理）
  if (!root) {
    return (
      <div ref={containerRef} className="flex-1 h-full min-w-0 relative overflow-hidden" style={{ background: 'var(--content-bg, #F4F6FA)' }}>
        <ChatAnchorContent />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex-1 h-full min-w-0 relative overflow-hidden" style={{ background: 'var(--content-bg, #F4F6FA)' }}>
      <NodeRenderer node={root} />
      <InstanceHostOverlay />
      <LayoutPresetDropdown />
    </div>
  )
}

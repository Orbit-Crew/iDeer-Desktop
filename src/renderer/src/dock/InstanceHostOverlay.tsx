// Global content layer from the pinned linz dock (issue 71): every panel
// instance renders here, absolutely positioned over its pane's rect. Moving
// panes/tabs only changes instance.paneId → this layer repositions and the
// content components never remount (keeps chat state alive across moves).
// Desktop change: the mounted set starts with the initially active instances
// so the first frame (and static acceptance markup) is complete.
import { Suspense, useEffect, useState } from 'react'
import { useDockStore, isPane } from './dockStore'
import { getRegisteredPanel } from './panelRegistry'
import { getPanelMeta } from './panelMeta'
import { useUIStore } from '../stores/uiStore'
import type { PanelInstance } from './types'

function PanelContent({ instance }: { instance: PanelInstance }): JSX.Element {
  const def = getRegisteredPanel(instance.panelType)
  if (!def) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-xs">
        未实现的面板：{getPanelMeta(instance.panelType).title}
      </div>
    )
  }
  const Comp = def.component
  return (
    <Suspense
      fallback={<div className="h-full flex items-center justify-center text-xs text-gray-400">加载面板…</div>}
    >
      <Comp instanceId={instance.id} panelType={instance.panelType} />
    </Suspense>
  )
}

function activeInstanceIds(): Set<string> {
  const active = new Set<string>()
  const { byId } = useDockStore.getState().layout
  for (const key of Object.keys(byId)) {
    const n = byId[key]
    if (isPane(n)) {
      const tab = n.tabs.find((t) => t.id === n.activeTabId) ?? n.tabs[0]
      if (tab?.instanceId) active.add(tab.instanceId)
    }
  }
  return active
}

export default function InstanceHostOverlay(): JSX.Element | null {
  const instances = useDockStore((s) => s.layout.instances)
  const byId = useDockStore((s) => s.layout.byId)
  const paneRects = useDockStore((s) => s.paneRects)
  const companionVisible = useUIStore((s) => s.companionPanesVisible)

  // 记录该实例是否曾被激活（一旦激活即常驻挂载，仅隐藏）
  const [mounted, setMounted] = useState<Set<string>>(activeInstanceIds)

  // 当前应可见的实例 id（每个窗格的激活页签实例）
  const active = activeInstanceIds()
  const activeKey = Array.from(active)
    .sort()
    .join(',')

  useEffect(() => {
    setMounted((prev) => {
      let changed = false
      const next = new Set(prev)
      active.forEach((id) => {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      })
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  if (Object.keys(instances).length === 0) return null

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
      {Object.keys(instances).map((id) => {
        const inst = instances[id]
        // 锚点(chat)不在此层渲染，由 PaneFrame/DockWorkspace 直接渲染锚点内容
        if (inst.panelType === 'chat') return null
        if (!mounted.has(id)) return null
        const pane = inst.paneId ? byId[inst.paneId] : null
        const r = paneRects[inst.paneId]

        if (!r || !companionVisible) {
          return (
            <div
              key={id}
              className="absolute pointer-events-auto"
              style={{ left: 0, top: 0, width: 0, height: 0, display: 'none', background: 'var(--pane-bg, #FFFFFF)' }}
            >
              <PanelContent instance={inst} />
            </div>
          )
        }

        const tabActive =
          pane !== null && isPane(pane) && pane.tabs.find((t) => t.id === pane.activeTabId)?.instanceId === inst.id
        return (
          <div
            key={id}
            className="absolute pointer-events-auto"
            style={{ left: r.x, top: r.y, width: r.width, height: r.height, display: tabActive ? 'block' : 'none', background: 'var(--pane-bg, #FFFFFF)' }}
          >
            <PanelContent instance={inst} />
          </div>
        )
      })}
    </div>
  )
}

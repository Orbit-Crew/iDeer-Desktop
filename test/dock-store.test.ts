// Issue 71: dock store logic — split tree, ratios, tab/pane moves, multi-instance
// panes, presets and device-local persistence. The store is module-global, so
// every test hydrates a fresh layout first.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  collectPanes,
  findAnchorPane,
  isSplit,
  sideFromPoint,
  useDockStore
} from '../src/renderer/src/dock/dockStore'
import { buildDefaultLayout, ensureAnchorPane } from '../src/renderer/src/dock/defaultLayout'
import { LAYOUT_PRESETS, applyPreset, buildLayoutFromSpec } from '../src/renderer/src/dock/layoutPresets'
import { loadLayout, saveLayout } from '../src/renderer/src/dock/persistence'
import { useUIStore } from '../src/renderer/src/stores/uiStore'
import type { DockLayout, Pane } from '../src/renderer/src/dock/types'

// —— localStorage stub（node 测试环境无 localStorage；persistence/uiStore 靠它读写） ——
const backingStore = new Map<string, string>()
beforeAll(() => {
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => backingStore.get(key) ?? null,
    setItem: (key: string, value: string) => void backingStore.set(key, value),
    removeItem: (key: string) => void backingStore.delete(key),
    clear: () => void backingStore.clear()
  }
})
afterAll(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
  backingStore.clear()
})

function hydrate(layout: DockLayout = buildDefaultLayout()): void {
  useDockStore.getState().hydrate(layout)
}

function panes(): Pane[] {
  return collectPanes(useDockStore.getState().layout)
}

function paneByType(panelType: string): Pane | undefined {
  return panes().find((p) => p.tabs.some((t) => t.panelType === panelType))
}

describe('default layout', () => {
  it('anchors exactly one chat pane and carries the device Runtime pane beside it', () => {
    hydrate()
    const layout = useDockStore.getState().layout
    const anchorPanes = panes().filter((p) => p.anchor)
    expect(anchorPanes).toHaveLength(1)
    expect(anchorPanes[0].tabs.map((t) => t.panelType)).toEqual(['chat'])
    expect(anchorPanes[0].tabs[0].instanceId).toBeUndefined()
    const root = layout.byId[layout.rootId]
    expect(isSplit(root)).toBe(true)
    if (!isSplit(root)) return
    expect(root.direction).toBe('row')
    expect(root.ratio).toBeCloseTo(0.68)
    const companion = paneByType('runtime')
    expect(companion).toBeDefined()
    expect(companion!.anchor).toBeFalsy()
    // runtime 页签指向一个真实实例
    const runtimeTab = companion!.tabs[0]
    expect(layout.instances[runtimeTab.instanceId!].panelType).toBe('runtime')
  })

  it('falls back to a fresh anchor when the stored layout lost it', () => {
    const empty: DockLayout = { version: 1, rootId: '', byId: {}, instances: {} }
    const repaired = ensureAnchorPane(empty)
    const anchor = findAnchorPane(repaired)
    expect(anchor).not.toBeNull()
    expect(repaired.rootId).toBe(anchor!.id)

    // 分屏根但无锚点：锚点追加进根分屏
    const splitOrphan = buildLayoutFromSpec({
      type: 'tree',
      root: { kind: 'row', ratio: 0.5, children: [{ kind: 'pane', tabs: ['browser'] }, { kind: 'pane', tabs: ['terminal'] }] }
    })
    const repaired2 = ensureAnchorPane(splitOrphan)
    const anchor2 = findAnchorPane(repaired2)
    expect(anchor2).not.toBeNull()
    const root2 = repaired2.byId[repaired2.rootId]
    expect(isSplit(root2) && root2.children).toContain(anchor2!.id)

    // Desktop 加固：根是单个窗格时，补建的锚点必须真正接入渲染树（与根并成分屏）
    const paneRoot = buildLayoutFromSpec({ type: 'tree', root: { kind: 'pane', tabs: ['browser'] } })
    const repaired3 = ensureAnchorPane(paneRoot)
    const anchor3 = findAnchorPane(repaired3)
    expect(anchor3).not.toBeNull()
    const root3 = repaired3.byId[repaired3.rootId]
    expect(isSplit(root3) && root3.children).toContain(anchor3!.id)
  })
})

describe('split, ratio and close', () => {
  it('splits the anchor beside a new pane and creates one browser instance', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const newPaneId = useDockStore.getState().splitPane(anchor.id, 'row', 'browser')
    const layout = useDockStore.getState().layout
    const newPane = layout.byId[newPaneId] as Pane
    expect(newPane.tabs).toHaveLength(1)
    expect(newPane.tabs[0].panelType).toBe('browser')
    expect(newPane.tabs[0].title).toBe('浏览器 1')
    expect(Object.keys(layout.instances)).toHaveLength(2) // runtime + browser
    expect(findAnchorPane(layout)!.id).toBe(anchor.id)
  })

  it('clamps ratios into the usable band', () => {
    hydrate()
    const rootId = useDockStore.getState().layout.rootId
    useDockStore.getState().setRatio(rootId, 0.01)
    expect((useDockStore.getState().layout.byId[rootId] as { ratio: number }).ratio).toBeCloseTo(0.05)
    useDockStore.getState().setRatio(rootId, 0.99)
    expect((useDockStore.getState().layout.byId[rootId] as { ratio: number }).ratio).toBeCloseTo(0.95)
    useDockStore.getState().setRatio(rootId, 0.7)
    expect((useDockStore.getState().layout.byId[rootId] as { ratio: number }).ratio).toBeCloseTo(0.7)
  })

  it('closes the last tab together with its pane and collapses the split', () => {
    // 从仅锚点的布局开始，排除默认伴随窗格的干扰
    hydrate(buildLayoutFromSpec({ type: 'single' }))
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const paneId = useDockStore.getState().splitPane(anchor.id, 'row', 'terminal')
    expect(panes()).toHaveLength(2)
    const pane = useDockStore.getState().layout.byId[paneId] as Pane
    useDockStore.getState().closeTab(paneId, pane.tabs[0].id)
    expect(panes()).toHaveLength(1)
    expect(useDockStore.getState().layout.byId[paneId]).toBeUndefined()
    expect(findAnchorPane(useDockStore.getState().layout)!.id).toBe(anchor.id)
  })

  it('never closes the anchor pane or its tab', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const before = useDockStore.getState().layout
    useDockStore.getState().closeTab(anchor.id, anchor.tabs[0].id)
    useDockStore.getState().closePane(anchor.id)
    expect(useDockStore.getState().layout).toBe(before)
  })
})

describe('multi-instance panes', () => {
  it('opens two browser instances with numbered titles in one pane', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const paneId = useDockStore.getState().splitPane(anchor.id)
    const first = useDockStore.getState().openPanel(paneId, 'browser')
    const second = useDockStore.getState().openPanel(paneId, 'browser')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
    const pane = useDockStore.getState().layout.byId[paneId] as Pane
    expect(pane.tabs.map((t) => t.title)).toEqual(['浏览器 1', '浏览器 2'])
    expect(Object.values(useDockStore.getState().layout.instances).filter((i) => i.panelType === 'browser')).toHaveLength(2)
  })

  it('focuses the existing tab for single-instance panel types', () => {
    hydrate()
    const companion = paneByType('runtime')!
    const existing = companion.tabs[0].instanceId
    const again = useDockStore.getState().openPanel(companion.id, 'runtime')
    expect(again).toBe(existing)
    expect(companion.tabs).toHaveLength(1)
  })
})

describe('tab and pane moves', () => {
  it('moves a tab between panes, re-homing the instance, and collapses the emptied pane', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const runtimePane = paneByType('runtime')!
    const aId = useDockStore.getState().splitPane(anchor.id, 'row', 'browser')
    const aPane = useDockStore.getState().layout.byId[aId] as Pane
    const browserTabId = aPane.tabs[0].id
    const instanceId = aPane.tabs[0].instanceId!
    useDockStore.getState().moveTab(aId, runtimePane.id, browserTabId)
    const layout = useDockStore.getState().layout
    expect(layout.byId[aId]).toBeUndefined()
    const target = layout.byId[runtimePane.id] as Pane
    expect(target.tabs.some((t) => t.id === browserTabId)).toBe(true)
    expect(layout.instances[instanceId].paneId).toBe(runtimePane.id)
  })

  it('never moves the anchor chat tab out of the anchor pane', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const runtimePane = paneByType('runtime')!
    const before = useDockStore.getState().layout
    useDockStore.getState().moveTab(anchor.id, runtimePane.id, anchor.tabs[0].id)
    expect(useDockStore.getState().layout).toBe(before)
  })

  it('splits a tab out beside a target pane on the requested side', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const runtimePane = paneByType('runtime')!
    const aId = useDockStore.getState().splitPane(anchor.id, 'row', 'browser')
    const aPane = useDockStore.getState().layout.byId[aId] as Pane
    const tabId = aPane.tabs[0].id
    useDockStore.getState().splitBeside(runtimePane.id, { kind: 'tab', tabId, fromPaneId: aId }, 'bottom')
    const layout = useDockStore.getState().layout
    expect(layout.byId[aId]).toBeUndefined()
    const parent = Object.values(layout.byId).find((n) => isSplit(n) && n.children.includes(runtimePane.id))
    expect(parent).toBeDefined()
    if (!isSplit(parent)) return
    expect(parent.direction).toBe('col')
  })

  it('refuses to split the anchor chat tab out into a new pane', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const before = useDockStore.getState().layout
    useDockStore.getState().splitBeside(paneByType('runtime')!.id,
      { kind: 'tab', tabId: anchor.tabs[0].id, fromPaneId: anchor.id }, 'right')
    expect(useDockStore.getState().layout).toBe(before)
  })

  it('moves a whole pane beside another pane', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const runtimePane = paneByType('runtime')!
    const aId = useDockStore.getState().splitPane(anchor.id, 'row', 'browser')
    useDockStore.getState().movePaneBeside(aId, runtimePane.id)
    const layout = useDockStore.getState().layout
    // aId 不再是 anchor 的兄弟，而是 runtime 旁的新兄弟
    const parent = Object.values(layout.byId).find((n) => isSplit(n) && n.children.includes(aId))
    expect(parent).toBeDefined()
    if (!isSplit(parent)) return
    expect(parent.children).toContain(runtimePane.id)
  })

  it('swaps sibling panes in place', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const aId = useDockStore.getState().splitPane(anchor.id, 'row', 'browser')
    const bId = useDockStore.getState().splitPane(aId, 'row', 'terminal')
    const parent = Object.values(useDockStore.getState().layout.byId).find((n) => isSplit(n) && n.children.includes(aId))
    if (!isSplit(parent)) throw new Error('expected shared split parent')
    const orderBefore = [...parent.children]
    useDockStore.getState().swapPanes(aId, bId)
    const parentAfter = Object.values(useDockStore.getState().layout.byId).find((n) => isSplit(n) && n.children.includes(aId))
    if (!isSplit(parentAfter)) throw new Error('expected shared split parent')
    expect(parentAfter.children).toEqual([orderBefore[1], orderBefore[0]])
  })
})

describe('openPanelType and companion restore', () => {
  it('opens into an existing non-anchor pane, or splits a new one beside the anchor', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    useDockStore.getState().openPanelType('browser')
    const layout = useDockStore.getState().layout
    const browserPane = panes().find((p) => !p.anchor && p.tabs.some((t) => t.panelType === 'browser'))
    expect(browserPane).toBeDefined()
    expect(findAnchorPane(layout)!.id).toBe(anchor.id)
    // 再次打开 → 聚焦已有页签，不新开实例
    const before = Object.keys(layout.instances).length
    useDockStore.getState().openPanelType('browser')
    expect(Object.keys(useDockStore.getState().layout.instances)).toHaveLength(before)
  })

  it('restores the device Runtime companion pane when every pane was closed', () => {
    hydrate()
    const anchor = findAnchorPane(useDockStore.getState().layout)!
    const runtimePane = paneByType('runtime')!
    useDockStore.getState().closePane(runtimePane.id)
    expect(panes()).toHaveLength(1)
    useDockStore.getState().restoreCompanionPane()
    const layout = useDockStore.getState().layout
    const companion = panes().find((p) => !p.anchor)
    expect(companion).toBeDefined()
    expect(companion!.tabs.map((t) => t.panelType)).toEqual(['runtime'])
    expect(findAnchorPane(layout)!.id).toBe(anchor.id)
    // 幂等：已有非锚点窗格时不再新建
    useDockStore.getState().restoreCompanionPane()
    expect(panes()).toHaveLength(2)
  })
})

describe('drop side calculation', () => {
  it('maps relative drop points to split sides', () => {
    expect(sideFromPoint(0.1, 0.5)).toBe('left')
    expect(sideFromPoint(0.9, 0.5)).toBe('right')
    expect(sideFromPoint(0.5, 0.1)).toBe('top')
    expect(sideFromPoint(0.5, 0.9)).toBe('bottom')
    expect(sideFromPoint(0.49, 0.49)).toBe('top')
    expect(sideFromPoint(0.6, 0.49)).toBe('right')
    expect(sideFromPoint(0.35, 0.6)).toBe('left')
    expect(sideFromPoint(0.6, 0.75)).toBe('bottom')
  })
})

describe('layout presets', () => {
  it('offers exactly the eight original arrangements', () => {
    expect(LAYOUT_PRESETS.map((p) => p.id)).toEqual([
      'chat-only', 'tools-right', 'browser-right', 'tools-bottom',
      'bottom-row', 'right-stack', 'three-col', 'bottom-terminal'
    ])
  })

  it('builds every preset with exactly one chat anchor and its spec panes', () => {
    const expectedNonAnchorPanes: Record<string, number> = {
      'chat-only': 0, 'tools-right': 1, 'browser-right': 1, 'tools-bottom': 1,
      'bottom-row': 2, 'right-stack': 2, 'three-col': 2, 'bottom-terminal': 2
    }
    for (const preset of LAYOUT_PRESETS) {
      const layout = buildLayoutFromSpec(preset.spec)
      const anchorPanes = collectPanes(layout).filter((p) => p.anchor)
      expect(anchorPanes, preset.id).toHaveLength(1)
      const nonAnchor = collectPanes(layout).filter((p) => !p.anchor)
      expect(nonAnchor, preset.id).toHaveLength(expectedNonAnchorPanes[preset.id])
      // 每个实例都挂在合法窗格上，类型词汇只含原版集合
      for (const inst of Object.values(layout.instances)) {
        expect(layout.byId[inst.paneId], preset.id).toBeDefined()
        expect(['browser', 'terminal', 'files']).toContain(inst.panelType)
      }
    }
  })

  it('applies a preset and keeps the companion switch consistent with the layout', () => {
    hydrate()
    useUIStore.getState().setCompanionPanesVisible(true)
    applyPreset('chat-only')
    expect(useUIStore.getState().companionPanesVisible).toBe(false)
    applyPreset('tools-right')
    expect(useUIStore.getState().companionPanesVisible).toBe(true)
    const layout = useDockStore.getState().layout
    expect(panes().filter((p) => !p.anchor)).toHaveLength(1)
    expect(paneByType('browser')).toBeDefined()
    expect(findAnchorPane(layout)).not.toBeNull()
  })
})

describe('device-local persistence', () => {
  it('round-trips the layout through localStorage and stays account-independent', () => {
    hydrate()
    const layout = useDockStore.getState().layout
    saveLayout(layout)
    const restored = loadLayout()
    expect(restored).not.toBeNull()
    expect(restored!.rootId).toBe(layout.rootId)
    expect(Object.keys(restored!.byId).sort()).toEqual(Object.keys(layout.byId).sort())
    // 键是设备级常量，不含账号/项目维度
    expect(backingStore.has('ideer.dock.layout.v1')).toBe(true)
  })

  it('strips volatile instance state and keeps the saved version pinned', () => {
    hydrate()
    const layout = useDockStore.getState().layout
    const instanceId = Object.keys(layout.instances)[0]
    layout.instances[instanceId].sessionId = 'pty-session'
    layout.instances[instanceId].url = 'https://example.invalid'
    saveLayout(layout)
    const restored = loadLayout()!
    expect(restored.instances[instanceId].sessionId).toBeUndefined()
    expect(restored.instances[instanceId].url).toBeUndefined()
    expect(restored.version).toBe(1)
  })

  it('rejects corrupt or foreign persisted payloads and repairs a missing anchor', () => {
    backingStore.set('ideer.dock.layout.v1', '{not json')
    expect(loadLayout()).toBeNull()
    backingStore.set('ideer.dock.layout.v1', JSON.stringify({ version: 2, rootId: 'x', byId: {} }))
    expect(loadLayout()).toBeNull()
    backingStore.set('ideer.dock.layout.v1', JSON.stringify({ version: 1, rootId: 'pane-x', byId: {
      'pane-x': { id: 'pane-x', kind: 'pane', tabs: [{ id: 'tab-x', panelType: 'browser', title: '浏览器 1' }], activeTabId: 'tab-x' }
    }, instances: {} }))
    const repaired = loadLayout()
    expect(repaired).not.toBeNull()
    expect(findAnchorPane(repaired!)).not.toBeNull()
  })
})

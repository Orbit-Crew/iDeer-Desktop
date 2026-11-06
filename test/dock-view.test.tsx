// Issue 71: restored dock rendering — static markup acceptance of the entry
// layer: chat anchor, device Runtime pane, honest placeholders, eight preset
// arrangements and the multi-instance tab strip.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import App from '../src/renderer/src/App'
import DockWorkspace from '../src/renderer/src/dock/DockWorkspace'
import PaneFrame from '../src/renderer/src/dock/PaneFrame'
import LayoutPresetDropdown, { LayoutPresetList } from '../src/renderer/src/dock/LayoutPresetDropdown'
import AddPanelPicker from '../src/renderer/src/dock/AddPanelPicker'
import ExternalPanePlaceholder from '../src/renderer/src/dock/panels/externalPanes'
import { LAYOUT_PRESETS } from '../src/renderer/src/dock/layoutPresets'
import { PANEL_REGISTRY, getRegisteredPanel } from '../src/renderer/src/dock/panelRegistry'
import { PANEL_META } from '../src/renderer/src/dock/panelMeta'
import type { Pane } from '../src/renderer/src/dock/types'

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

describe('restored dock on startup', () => {
  it('shows the chat anchor, the device Runtime pane and the layout entry', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('请先在系统浏览器登录并绑定设备')
    expect(html).toContain('设备连接：')
    expect(html).toContain('尚未配置设备时，任务不可用')
    expect(html).toContain('切换窗口排布')
    expect(html).toContain('退出应用')
    // 默认布局不开未接入的窗格
    expect(html).not.toContain('浏览器窗格未接入')
    // 原版残留业务不得出现
    expect(html).not.toMatch(/办公室|DeepSeek|Ollama|API Key/)
    expect(html).not.toMatch(/<textarea|type="submit"/)
  })

  it('renders the default split tree with an adjustable divider', () => {
    const html = renderToStaticMarkup(<DockWorkspace />)
    expect(html).toContain('拖拽调整大小')
    expect(html).toContain('平台聊天与历史')
    expect(html).toContain('本机 Runtime')
  })
})

describe('wired pane columns', () => {
  it('keeps the terminal column position hosting the wired human terminal pane', () => {
    // Issue 110 接线 terminal 后，占位清单不再包含它：栏位保留，页签条承载
    // 真实人工终端实例（同一缝的如实状态从占位文案移到已接线窗格）。
    const pane: Pane = {
      id: 'pane-t',
      kind: 'pane',
      tabs: [{ id: 'tab-1', panelType: 'terminal', title: '终端 1', instanceId: 'inst-1' }],
      activeTabId: 'tab-1'
    }
    const html = renderToStaticMarkup(<PaneFrame pane={pane} />)
    expect(html).toContain('终端 1')
    expect(html).toContain('关闭页签')
    expect(html).not.toContain('终端窗格未接入')
  })

  it('renders one tab per instance in the pane tab strip', () => {
    // zustand v4 的服务端快照是 store 初始状态，静态渲染用构造好的窗格验证页签条
    const pane: Pane = {
      id: 'pane-x',
      kind: 'pane',
      tabs: [
        { id: 'tab-1', panelType: 'browser', title: '浏览器 1', instanceId: 'inst-1' },
        { id: 'tab-2', panelType: 'browser', title: '浏览器 2', instanceId: 'inst-2' }
      ],
      activeTabId: 'tab-1'
    }
    const html = renderToStaticMarkup(<PaneFrame pane={pane} />)
    expect(html).toContain('浏览器 1')
    expect(html).toContain('浏览器 2')
    expect(html).toContain('关闭页签')
  })
})

describe('layout arrangements', () => {
  it('lists the eight original arrangements in the picker', () => {
    // Popover 内容只在展开时挂载，静态验收直接渲染列表本体
    const html = renderToStaticMarkup(<LayoutPresetList />)
    for (const preset of LAYOUT_PRESETS) expect(html).toContain(preset.title)
    // 工作区入口按钮始终存在
    expect(renderToStaticMarkup(<LayoutPresetDropdown />)).toContain('切换窗口排布')
  })
})

describe('panel registry vocabulary', () => {
  it('keeps every original column except the never-delivered sql pane', () => {
    const registered = PANEL_REGISTRY.map((p) => p.id)
    // Issue 84 adds the `templates` plaza as a new native column beyond the
    // original vocabulary.
    expect(registered.sort()).toEqual([
      'browser', 'chat', 'field', 'files', 'kb', 'notifications', 'runtime', 'synapse', 'templates', 'terminal', 'viewer3d'
    ])
    expect(getRegisteredPanel('sql')).toBeUndefined()
    expect(PANEL_META.sql.title).toBe('数据')
  })

  it('offers all non-anchor panels in the add picker', () => {
    const html = renderToStaticMarkup(<AddPanelPicker paneId="pane-x" inline />)
    expect(html).toContain('本机 Runtime')
    expect(html).toContain('浏览器')
    expect(html).toContain('终端')
    expect(html).toContain('文件')
    expect(html).toContain('知识库')
    expect(html).toContain('三维模型')
    expect(html).toContain('仿真结果')
    expect(html).toContain('会话地图')
    expect(html).toContain('通知中心')
    // 锚点对话不进添加列表
    expect(html).not.toContain('>对话<')
  })
})

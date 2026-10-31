// Reduced from linz uiStore: no persisted workspace, model or tool state.
// Issue 71 restores the dock companion-pane switch with device-local
// persistence: the flag lives in localStorage under a constant key, so it
// follows the device, never the account or the project.
import { create } from 'zustand'
import { useDockStore } from '../dock/dockStore'

// 伴随窗格显示状态持久化（配合 dock 布局一同记忆，重启后恢复用户选定的排布）。
// Desktop 首启默认展开：设备连接与任务状态是桌面主入口（原版 linz 默认隐藏，
// 桌面默认布局的伴随窗格是"本机 Runtime"，隐藏它等于隐藏登录与设备绑定）。
const COMPANION_VISIBLE_KEY = 'ideer.ui.companion.visible.v1'
function loadCompanionVisible(): boolean {
  try {
    const raw = localStorage.getItem(COMPANION_VISIBLE_KEY)
    if (raw === null) return true
    return raw === '1'
  } catch {
    return true
  }
}

function saveCompanionVisible(visible: boolean): void {
  try {
    localStorage.setItem(COMPANION_VISIBLE_KEY, visible ? '1' : '0')
  } catch {
    // 忽略（localStorage 不可用）
  }
}

interface UIState {
  leftPanelOpen: boolean
  /** Dock 工作区：是否显示伴随窗格（对话锚点之外的本机 Runtime 等窗格） */
  companionPanesVisible: boolean

  toggleLeftPanel(): void
  setCompanionPanesVisible(v: boolean): void
  toggleCompanionPanes(): void
}

export const useUIStore = create<UIState>((set, get) => ({
  leftPanelOpen: true,
  companionPanesVisible: loadCompanionVisible(),

  toggleLeftPanel: () => set((state) => ({ leftPanelOpen: !state.leftPanelOpen })),

  setCompanionPanesVisible: (v) => {
    // 显示前确保 dock 布局里有可展示的窗格；否则曾关闭过的伴随窗格会"点了没反应"
    if (v) useDockStore.getState().restoreCompanionPane()
    set({ companionPanesVisible: v })
    saveCompanionVisible(v)
  },
  toggleCompanionPanes: () => {
    const next = !get().companionPanesVisible
    // 打开时若布局中已无任何辅助窗格，先恢复默认伴随窗格（本机 Runtime）
    if (next) useDockStore.getState().restoreCompanionPane()
    set({ companionPanesVisible: next })
    saveCompanionVisible(next)
  }
}))

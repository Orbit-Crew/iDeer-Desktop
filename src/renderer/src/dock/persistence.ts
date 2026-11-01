// Device-local layout persistence (issue 71): the key is a constant, so the
// layout never follows the account or the project — it belongs to this device
// and survives restarts. Volatile per-instance session state is stripped on
// save, mirroring the pinned linz persistence contract.
import type { DockLayout } from './types'
import { ensureAnchorPane } from './defaultLayout'

const STORAGE_KEY = 'ideer.dock.layout.v1'

/** 持久化布局到 localStorage；实例上的易失会话状态（PTY/浏览器会话 id）在重启后失效，序列化时剥离 */
export function saveLayout(l: DockLayout): void {
  try {
    const clone: DockLayout = JSON.parse(JSON.stringify(l))
    for (const key of Object.keys(clone.instances)) {
      delete clone.instances[key].sessionId
      delete clone.instances[key].url
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...clone, version: 1 }))
  } catch {
    // 忽略（localStorage 不可用或超限）
  }
}

export function loadLayout(): DockLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DockLayout
    if (!parsed || parsed.version !== 1 || !parsed.rootId || !parsed.byId) return null
    return ensureAnchorPane(parsed)
  } catch {
    return null
  }
}

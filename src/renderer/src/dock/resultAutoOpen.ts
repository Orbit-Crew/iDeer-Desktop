// Issue 117: 结果自动开窗 — a completed task result whose file sits inside the
// CURRENT workspace grant auto-opens the pane that can render its kind. The
// authorization verdict is the Runtime's own per-snapshot classification
// (`workspace_state`, re-derived from the live grant): `outside`, `protected`
// or absent never auto-opens, and nothing here widens an authorization or the
// upload boundary — the pane later reads the file through the exact same
// guarded seams as a hand-typed path, and upload stays explicit. The mapping
// lives in panelMeta's RESULT_PANE_TYPES; unlisted kinds are ignored.
import { useEffect } from 'react'
import type { ChatSnapshot } from '../../../shared/desktop'
import { RESULT_PANE_TYPES } from './panelMeta'
import type { PanelTypeId } from './types'
import { useDockStore } from './dockStore'

/** Tasks whose result already auto-opened, once per renderer lifetime. A
 * task's result fact is immutable, so re-polling must not re-open it. Rows
 * that do not open (outside, unmapped) stay unmarked on purpose: the verdict
 * is per-snapshot, so a later snapshot with a renewed grant can still open
 * them instead of a first-seen miss fossilizing into a permanent refusal. */
const openedTasks = new Set<string>()

/** Lowercase-extension lookup against the extensible result→pane table. */
export function resultPaneTypeOf(name: string): PanelTypeId | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return RESULT_PANE_TYPES[name.slice(dot).toLowerCase()] ?? null
}

/** Consume one polled snapshot's local tasks; idempotent across polls. */
export function consumeResultAutoOpen(tasks: ChatSnapshot['localTasks'] | undefined): void {
  for (const task of tasks ?? []) {
    const result = task.localResult
    if (!result || openedTasks.has(task.task_id)) continue
    if (result.workspace_state !== 'inside') continue
    const paneType = resultPaneTypeOf(result.name)
    if (!paneType) continue
    openedTasks.add(task.task_id)
    const dock = useDockStore.getState()
    // Path first, then open: a freshly mounted pane must already see its
    // pending auto-load path in the same synchronous update.
    dock.requestAutoLoad(paneType, result.logical_path)
    dock.openPanelType(paneType)
  }
}

/** A pane consumes its pending auto-load path once its read seam can actually
 * serve it (workspace ready, no load in flight) — earlier than that the
 * guarded read can only refuse, so the path waits here instead of burning the
 * one shot on an honest refusal. The pane applies the path through its own
 * existing load channel; consuming clears the pending entry. */
export function useResultAutoLoad(panelType: PanelTypeId, ready: boolean, load: (path: string) => void): void {
  const pending = useDockStore((state) => state.autoLoad[panelType])
  const clearAutoLoad = useDockStore((state) => state.clearAutoLoad)
  useEffect(() => {
    if (!ready || !pending) return
    load(pending)
    clearAutoLoad(panelType)
  }, [ready, pending, load, clearAutoLoad, panelType])
}

/** Test seam: a fresh renderer lifetime starts with an empty opened set. */
export function resetResultAutoOpenForTests(): void {
  openedTasks.clear()
}

// Issue 117: 结果自动开窗 — a completed task result whose file sits inside the
// CURRENT workspace grant auto-opens the pane that can render its kind. The
// authorization verdict is the Runtime's own per-snapshot classification
// (`workspace_state`, re-derived from the live grant): `outside`, `protected`
// or absent never auto-opens, and nothing here widens an authorization or the
// upload boundary — the pane later reads the file through the exact same
// guarded seams as a hand-typed path, and upload stays explicit. The mapping
// lives in panelMeta's RESULT_PANE_TYPES; unlisted kinds are ignored.
import type { ChatSnapshot } from '../../../shared/desktop'
import { RESULT_PANE_TYPES } from './panelMeta'
import type { PanelTypeId } from './types'
import { useDockStore } from './dockStore'

/** Each task auto-opens once per renderer lifetime; a result fact is
 * immutable per task, so re-polling the same snapshot must not re-open. */
const handledTasks = new Set<string>()

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
    if (!result || handledTasks.has(task.task_id)) continue
    handledTasks.add(task.task_id)
    if (result.workspace_state !== 'inside') continue
    const paneType = resultPaneTypeOf(result.name)
    if (!paneType) continue
    const dock = useDockStore.getState()
    // Path first, then open: a freshly mounted pane must already see its
    // pending auto-load path in the same synchronous update.
    dock.requestAutoLoad(paneType, result.logical_path)
    dock.openPanelType(paneType)
  }
}

/** Test seam: a fresh renderer lifetime starts with an empty handled set. */
export function resetResultAutoOpenForTests(): void {
  handledTasks.clear()
}

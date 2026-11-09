// Issue 117: the auto-open trigger's bridge contract. A polled snapshot's
// local task rows are the only input: a result the Runtime classified
// `inside` the CURRENT workspace grant opens the pane its file kind maps to
// (panelMeta's extensible table) and parks the workspace-logical path for the
// pane to auto-load; `outside`/`protected`/absent verdicts and unmapped
// kinds never open anything, and each task opens at most once per renderer
// lifetime. Opening carries no authorization or upload side effect: it only
// exercises the dock store's own open path.
import { beforeEach, describe, expect, it } from 'vitest'
import { buildDefaultLayout } from '../src/renderer/src/dock/defaultLayout'
import { collectPanes, useDockStore } from '../src/renderer/src/dock/dockStore'
import { consumeResultAutoOpen, resetResultAutoOpenForTests, resultPaneTypeOf } from '../src/renderer/src/dock/resultAutoOpen'
import type { ChatSnapshot, LocalResultView } from '../src/shared/desktop'

type LocalTask = NonNullable<ChatSnapshot['localTasks']>[number]

function resultRow(over: Partial<LocalResultView>): LocalResultView {
  return { task_id: 'task-117', run_id: 'run-117', thread_id: 'thread-A',
    capability: 'local.files.write', logical_root: '/workspace/ws',
    logical_path: '/workspace/ws/parts/bracket.stl', name: 'bracket.stl',
    sha256: 'a'.repeat(64), bytes: 12, artifact_ref: '', uploaded_at: '',
    workspace_state: 'inside', ...over }
}

function taskRow(result: LocalResultView | null, over: Partial<LocalTask> = {}): LocalTask {
  return { task_id: result?.task_id ?? 'task-117', run_id: 'run-117', capability: 'local.files.write',
    logical_target: result?.logical_path ?? '', status: 'completed', localResult: result, ...over }
}

function hasTab(panelType: string): boolean {
  return collectPanes(useDockStore.getState().layout).some((p) =>
    p.tabs.some((t) => t.panelType === panelType))
}

beforeEach(() => {
  resetResultAutoOpenForTests()
  useDockStore.getState().hydrate(buildDefaultLayout())
  useDockStore.getState().clearAutoLoad('viewer3d')
  useDockStore.getState().clearAutoLoad('field')
})

describe('result auto-open trigger contract (#117)', () => {
  it('auto-opens the CAD pane with the pending path for an inside CAD result', () => {
    consumeResultAutoOpen([taskRow(resultRow({}))])
    expect(hasTab('viewer3d')).toBe(true)
    expect(useDockStore.getState().autoLoad.viewer3d).toBe('/workspace/ws/parts/bracket.stl')
  })

  it('auto-opens the field pane for an inside Tecplot result', () => {
    consumeResultAutoOpen([taskRow(resultRow({ logical_path: '/workspace/ws/results/slice.dat',
      name: 'slice.dat', workspace_state: 'inside' }))])
    expect(hasTab('field')).toBe(true)
    expect(useDockStore.getState().autoLoad.field).toBe('/workspace/ws/results/slice.dat')
  })

  it('never auto-opens an outside result (negative path)', () => {
    consumeResultAutoOpen([taskRow(resultRow({ workspace_state: 'outside' }))])
    expect(hasTab('viewer3d')).toBe(false)
    expect(useDockStore.getState().autoLoad.viewer3d).toBeUndefined()
  })

  it('never auto-opens a protected or unclassified result', () => {
    consumeResultAutoOpen([
      taskRow(resultRow({ task_id: 'task-p', workspace_state: 'protected' })),
      taskRow(resultRow({ task_id: 'task-u', workspace_state: undefined }))
    ])
    expect(hasTab('viewer3d')).toBe(false)
    expect(useDockStore.getState().autoLoad.viewer3d).toBeUndefined()
  })

  it('ignores kinds the mapping does not list', () => {
    consumeResultAutoOpen([taskRow(resultRow({ logical_path: '/workspace/ws/notes.txt',
      name: 'notes.txt', workspace_state: 'inside' }))])
    expect(hasTab('viewer3d')).toBe(false)
    expect(hasTab('field')).toBe(false)
    expect(useDockStore.getState().autoLoad).toEqual({})
  })

  it('auto-opens each task once; re-polled snapshots do not re-trigger', () => {
    const row = taskRow(resultRow({}))
    consumeResultAutoOpen([row])
    useDockStore.getState().clearAutoLoad('viewer3d')
    consumeResultAutoOpen([row])
    expect(useDockStore.getState().autoLoad.viewer3d).toBeUndefined()
    expect(collectPanes(useDockStore.getState().layout)
      .filter((p) => p.tabs.filter((t) => t.panelType === 'viewer3d').length).length).toBe(1)
  })

  it('handles a mixed snapshot: only inside mapped results open', () => {
    consumeResultAutoOpen([
      taskRow(resultRow({ task_id: 'task-out', workspace_state: 'outside',
        name: 'other.dat', logical_path: '/workspace/ws/other.dat' })),
      taskRow(resultRow({ task_id: 'task-in', name: 'model.step',
        logical_path: '/workspace/ws/model.step' }))
    ])
    expect(hasTab('viewer3d')).toBe(true)
    expect(hasTab('field')).toBe(false)
    expect(useDockStore.getState().autoLoad.viewer3d).toBe('/workspace/ws/model.step')
  })

  it('tolerates absent localTasks', () => {
    expect(() => consumeResultAutoOpen(undefined)).not.toThrow()
  })
})

describe('resultPaneTypeOf', () => {
  it('matches case-insensitively and reads the final extension only', () => {
    expect(resultPaneTypeOf('MODEL.STL')).toBe('viewer3d')
    expect(resultPaneTypeOf('bracket.STEP')).toBe('viewer3d')
    expect(resultPaneTypeOf('slice.Dat')).toBe('field')
    expect(resultPaneTypeOf('archive.tar.stl')).toBe('viewer3d')
  })

  it('returns null without a usable extension', () => {
    expect(resultPaneTypeOf('noext')).toBeNull()
    expect(resultPaneTypeOf('.gitignore')).toBeNull()
    expect(resultPaneTypeOf('')).toBeNull()
  })
})

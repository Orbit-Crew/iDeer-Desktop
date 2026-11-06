import { describe, expect, it, vi } from 'vitest'
import { explainProjectError, ProjectDirectoryController, type ProjectDirectoryView } from '../src/renderer/src/stores/projectDirectory'
import type { DesktopBridge, ProjectOperationView } from '../src/shared/desktop'

type ProjectsApi = Pick<DesktopBridge, 'projects'>

const projectView = (overrides: Partial<ProjectOperationView> = {}): ProjectOperationView => ({
  projects: [
    { id: 'proj-1', name: '工程项目', status: 'active', createdAt: '2026-10-30T08:00:00+00:00', updatedAt: '2026-10-31T07:00:00+00:00' },
    { id: 'proj-2', name: '归档项目', status: 'archived', createdAt: '2026-10-29T08:00:00+00:00', updatedAt: '2026-10-30T09:00:00+00:00' }
  ],
  permissions: { canWrite: true, canDelete: true },
  ...overrides
})

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('project directory controller (#91)', () => {
  it('publishes the Server project list and permissions after one load round', async () => {
    const pending = deferred<ProjectOperationView>()
    const views: ProjectDirectoryView[] = []
    const api: ProjectsApi = { projects: vi.fn(() => pending.promise) }
    const controller = new ProjectDirectoryController(api, (view) => views.push(view))
    const done = controller.load()
    expect(controller.snapshot().busy).toBe(true)
    pending.resolve(projectView())
    await done
    const final = controller.snapshot()
    expect(final.busy).toBe(false)
    expect(final.failed).toBe(false)
    expect(final.projects.map((row) => row.id)).toEqual(['proj-1', 'proj-2'])
    expect(final.permissions).toEqual({ canWrite: true, canDelete: true })
  })

  it('refuses every write locally when the account lacks the permission', async () => {
    const calls: unknown[] = []
    const api: ProjectsApi = { projects: vi.fn((command) => { calls.push(command); return Promise.resolve(projectView({ permissions: { canWrite: false, canDelete: false } })) }) }
    const controller = new ProjectDirectoryController(api, () => {})
    await controller.load()
    await controller.create('新项目')
    await controller.rename('proj-1', '改名')
    await controller.archive('proj-1')
    await controller.restore('proj-2')
    await controller.remove('proj-1')
    expect(calls).toEqual([{ action: 'list' }])
  })

  it('trims the name and rides the confirmed create round', async () => {
    const calls: unknown[] = []
    const api: ProjectsApi = { projects: vi.fn((command) => { calls.push(command); return Promise.resolve(projectView({ created: true, projects: projectView().projects.concat({ id: 'proj-3', name: '新项目', status: 'active', createdAt: '', updatedAt: '' }) })) }) }
    const controller = new ProjectDirectoryController(api, () => {})
    await controller.load()
    await controller.create('  新项目  ')
    expect(calls).toEqual([
      { action: 'list' },
      { action: 'create', name: '新项目' }
    ])
    expect(controller.snapshot().projects.map((row) => row.name)).toEqual(['工程项目', '归档项目', '新项目'])
    expect(controller.snapshot().failed).toBe(false)
  })

  it('explains the fixed platform rejection categories', async () => {
    const responses: ProjectOperationView[] = [projectView()]
    const api: ProjectsApi = { projects: vi.fn(() => responses.length
      ? Promise.resolve(responses.shift()!)
      : Promise.reject(new Error('CHAT_CONFLICT'))) }
    const controller = new ProjectDirectoryController(api, () => {})
    await controller.load()
    await controller.remove('proj-1')
    const final = controller.snapshot()
    expect(final.failed).toBe(true)
    expect(final.error).toBe('CHAT_CONFLICT')
    expect(explainProjectError('CHAT_CONFLICT')).toContain('被平台拒绝')
  })

  it('keeps a canceled confirmation dialog silent', async () => {
    const api: ProjectsApi = { projects: vi.fn(() => Promise.reject(new Error('PROJECTS_CANCELED'))) }
    const controller = new ProjectDirectoryController(api, () => {})
    await controller.load()
    await controller.remove('proj-1')
    const final = controller.snapshot()
    expect(final.failed).toBe(false)
    expect(final.error).toBe('')
    expect(final.busy).toBe(false)
  })

  it('retries a wire-busy round a bounded number of times instead of failing', async () => {
    vi.useFakeTimers()
    try {
      const calls: unknown[] = []
      const responses: (ProjectOperationView | Error)[] = [projectView(), new Error('PROJECTS_BUSY'), new Error('PROJECTS_BUSY'),
        projectView({ deleted: true, projects: [projectView().projects[0]] })]
      const api: ProjectsApi = { projects: vi.fn((command) => {
        calls.push(command)
        const next = responses.shift()
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next!)
      }) }
      const controller = new ProjectDirectoryController(api, () => {})
      await controller.load()
      const done = controller.remove('proj-2')
      await vi.advanceTimersByTimeAsync(400)
      await vi.advanceTimersByTimeAsync(400)
      await done
      const final = controller.snapshot()
      expect(final.failed).toBe(false)
      expect(final.projects.map((row) => row.id)).toEqual(['proj-1'])
      expect(calls.filter((command) => (command as { action: string }).action === 'delete')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the stale reply of a superseded round', async () => {
    const first = deferred<ProjectOperationView>()
    const second = deferred<ProjectOperationView>()
    const calls: unknown[] = []
    const api: ProjectsApi = { projects: vi.fn((command) => { calls.push(command); return calls.length === 1 ? first.promise : second.promise }) }
    const controller = new ProjectDirectoryController(api, () => {})
    const stale = controller.load()
    const fresh = controller.load()
    first.resolve(projectView())
    await stale
    second.resolve(projectView({ projects: [projectView().projects[0]] }))
    await fresh
    const final = controller.snapshot()
    expect(final.projects.map((row) => row.id)).toEqual(['proj-1'])
    expect(final.failed).toBe(false)
  })
})

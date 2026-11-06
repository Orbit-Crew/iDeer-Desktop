// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ScheduledTasksPanel from '../src/renderer/src/components/ScheduledTasksPanel'
import { ScheduledTasksController, explainScheduleError, localTimezone, useScheduledTasks, emptyScheduledTasksView } from '../src/renderer/src/stores/scheduledTasks'
import type { DesktopBridge, ScheduleRunView, ScheduleTaskView } from '../src/shared/desktop'

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})
afterEach(() => { cleanup(); useScheduledTasks.setState({ view: emptyScheduledTasksView(), controller: null }) })

const task = (overrides: Partial<ScheduleTaskView> = {}): ScheduleTaskView => ({
  id: 'task-a', title: '每日报表', prompt: '生成昨天的报表', status: 'enabled',
  scheduleType: 'cron', scheduleSpec: { cron: '0 9 * * *' }, timezone: 'Asia/Shanghai',
  assistantId: 'report-agent', contextMode: 'fresh_thread_per_run', threadId: '',
  nextRunAt: '2026-03-02T01:00:00+00:00', createdAt: '2026-03-01T00:00:00+00:00',
  updatedAt: '2026-03-01T00:00:00+00:00', skipOnMissed: false,
  missedMarks: [{ plannedAt: '2026-03-01T01:00:00+00:00', status: 'caught_up',
    reason: 'missed while away; caught up once on device online', error: '', markedAt: '2026-03-01T09:00:00+00:00' }],
  ...overrides
})

const mount = (schedules: DesktopBridge['schedules']): void => {
  ;(window as unknown as { ideer: unknown }).ideer = { schedules }
  useScheduledTasks.getState().attach(new ScheduledTasksController({ schedules } satisfies Pick<DesktopBridge, 'schedules'>))
}

describe('scheduled tasks management card (#85)', () => {
  it('renders the platform rows with schedule summary, local-time next run, and 补跑 marks', async () => {
    const schedules = vi.fn().mockResolvedValue({ action: 'list', tasks: [task()] })
    mount(schedules)
    render(<ScheduledTasksPanel />)
    await screen.findByText('每日报表')
    expect(schedules).toHaveBeenCalledWith({ action: 'list' })
    const body = document.body
    expect(body.textContent).toContain('cron 0 9 * * *')
    expect(body.textContent).toContain('Asia/Shanghai')
    expect(body.textContent).toContain('report-agent')
    // 补跑 marking is device display truth for the missed planned point.
    expect(body.textContent).toContain('补跑')
    // nextRunAt renders as a viewer-local wall clock, never the raw estimate.
    const nextRun = new Date('2026-03-02T01:00:00+00:00').toLocaleString()
    expect(body.textContent).toContain(nextRun)
    expect(body.textContent).not.toContain('2026-03-02T01:00:00')
  })

  it('dispatches pause and immediate trigger against the pinned bridge', async () => {
    const schedules = vi.fn()
      .mockResolvedValueOnce({ action: 'list', tasks: [task()] })
      .mockResolvedValueOnce({ action: 'pause', task: task({ status: 'paused' }) })
      .mockResolvedValueOnce({ action: 'trigger', taskId: 'task-a', triggered: true })
      .mockResolvedValue({ action: 'list', tasks: [task({ status: 'paused' })] })
    mount(schedules)
    render(<ScheduledTasksPanel />)
    await screen.findByText('每日报表')
    fireEvent.click(screen.getByLabelText('暂停 每日报表'))
    await waitFor(() => expect(schedules).toHaveBeenCalledWith({ action: 'pause', taskId: 'task-a' }))
    fireEvent.click(screen.getByLabelText('立即执行 每日报表'))
    await waitFor(() => expect(schedules).toHaveBeenCalledWith({ action: 'trigger', taskId: 'task-a' }))
    // The id-only replies re-read the platform's own list.
    expect(schedules).toHaveBeenCalledWith({ action: 'list' })
  })

  it('toggles the per-task skip-on-missed policy and reflects the echo', async () => {
    const schedules = vi.fn()
      .mockResolvedValueOnce({ action: 'list', tasks: [task()] })
      .mockResolvedValueOnce({ action: 'set-skip', taskId: 'task-a', skipOnMissed: true })
    mount(schedules)
    render(<ScheduledTasksPanel />)
    await screen.findByText('每日报表')
    fireEvent.click(screen.getByLabelText('错过跳过 每日报表'))
    await waitFor(() => expect(schedules).toHaveBeenCalledWith({ action: 'set-skip', taskId: 'task-a', skipOnMissed: true }))
    await waitFor(() => expect(screen.getByLabelText('错过跳过 每日报表').getAttribute('aria-checked')).toBe('true'))
  })

  it('loads execution records on demand and shows the catch-up fact', async () => {
    const run: ScheduleRunView = { id: 'run-1', status: 'succeeded', plannedFor: '2026-03-01T01:00:00+00:00',
      trigger: 'schedule', threadId: 'thread-A', createdAt: '2026-03-01T01:05:00+00:00', error: '',
      catchUp: { plannedAt: '2026-03-01T01:00:00+00:00', status: 'caught_up',
        reason: 'missed while away; caught up once on device online', error: '', markedAt: '2026-03-01T09:00:00+00:00' } }
    const schedules = vi.fn()
      .mockResolvedValueOnce({ action: 'list', tasks: [task()] })
      .mockResolvedValueOnce({ action: 'runs', runs: [run] })
    mount(schedules)
    render(<ScheduledTasksPanel />)
    await screen.findByText('每日报表')
    fireEvent.click(screen.getByLabelText('执行记录 每日报表'))
    await waitFor(() => expect(schedules).toHaveBeenCalledWith({ action: 'runs', taskId: 'task-a', limit: 50, offset: 0 }))
    await screen.findByLabelText('执行记录列表')
    expect(document.body.textContent).toContain('补跑')
    expect(document.body.textContent).toContain('会话 thread-A')
  })

  it('opens the create form with the device-local timezone and dispatches the draft', async () => {
    const schedules = vi.fn()
      .mockResolvedValueOnce({ action: 'list', tasks: [] })
      .mockResolvedValueOnce({ action: 'create', task: task({ id: 'task-new' }) })
    mount(schedules)
    render(<ScheduledTasksPanel />)
    await screen.findByText(/还没有定时任务/)
    fireEvent.click(screen.getByLabelText('新建定时任务'))
    await screen.findByText('新建定时任务')
    // The timezone field defaults to the device's own IANA name (decision 3).
    expect((screen.getByLabelText('时区') as HTMLInputElement).value).toBe(localTimezone())
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '周报' } })
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '汇总本周进展' } })
    fireEvent.click(screen.getByRole('button', { name: '创 建' }))
    await waitFor(() => expect(schedules).toHaveBeenCalledWith({
      action: 'create',
      task: {
        title: '周报', prompt: '汇总本周进展', scheduleType: 'cron',
        scheduleSpec: { cron: '0 9 * * *' }, timezone: localTimezone(),
        assistantId: '', contextMode: 'fresh_thread_per_run', threadId: ''
      }
    }))
  })

  it('renders a fixed-category explanation instead of a raw code', async () => {
    const schedules = vi.fn()
      .mockResolvedValueOnce({ action: 'list', tasks: [task()] })
      .mockRejectedValueOnce(new Error('SCHEDULES_CONFLICT'))
    mount(schedules)
    render(<ScheduledTasksPanel />)
    await screen.findByText('每日报表')
    fireEvent.click(screen.getByLabelText('暂停 每日报表'))
    await screen.findByText(explainScheduleError('SCHEDULES_CONFLICT'))
  })
})

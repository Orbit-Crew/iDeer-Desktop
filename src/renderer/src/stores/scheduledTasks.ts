// Issue 85: the scheduled-tasks management controller. Every view belongs to
// one current user operation (generation-fenced, like the session sidebar);
// every reply is the Server's own post-action row or the device's own ledger
// echo — no client-side merge or optimistic write exists. The platform owns
// timing, cron previews and execution records; 补跑/跳过 facts are device-local
// display truth keyed by the planned point.
import { create } from 'zustand'
import type { DesktopBridge, SchedulePreviewView, ScheduleRunView, ScheduleTaskView } from '../../../shared/desktop'

export interface ScheduledTasksView {
  tasks: ScheduleTaskView[]
  busy: boolean
  failed: boolean
  error: string
  /** One task's execution records, loaded on demand. */
  runs: { taskId: string; rows: ScheduleRunView[] } | null
  runsBusy: boolean
  /** The form's cron preview — the platform's own occurrences. */
  preview: SchedulePreviewView | null
  previewBusy: boolean
}

export const emptyScheduledTasksView = (): ScheduledTasksView => ({
  tasks: [], busy: false, failed: false, error: '', runs: null, runsBusy: false,
  preview: null, previewBusy: false
})

/** Fixed wire categories the card can explain in Chinese; anything else reads
 * as a generic platform failure with the category shown. */
const errorExplanations: Record<string, string> = {
  SCHEDULES_UNAUTHENTICATED: '请先登录平台后再管理定时任务',
  SCHEDULES_FORBIDDEN: '当前账号没有执行该操作的权限',
  SCHEDULES_NOT_FOUND: '平台已找不到该任务，列表已刷新',
  SCHEDULES_CONFLICT: '该任务有执行正在进行，平台拒绝了这次操作，请稍后重试',
  SCHEDULES_RESOURCE_UNAVAILABLE: '平台拒绝了该计划：请检查 cron 表达式、间隔或开始时间',
  SCHEDULES_SERVER_UNAVAILABLE: '平台暂时不可用，请检查网络或稍后重试',
  SCHEDULES_SERVER_ERROR: '平台处理该操作时出错，请稍后重试',
  SCHEDULES_IDENTITY_CHANGED: '登录身份已变化，请重新打开任务列表',
  SCHEDULES_COMMAND_INVALID: '请求被拒绝：任务参数无效',
  SCHEDULES_STORAGE_UNAVAILABLE: '本机的补跑记录存储不可用，无法保存该设置',
  SCHEDULES_BUSY: '上一个操作还在进行，请稍候',
  SCHEDULES_TIMEOUT: '任务操作超时，结果以平台状态为准，请刷新核对',
  SCHEDULES_CANCELED: '已取消',
  RUNTIME_UNAVAILABLE: '本机 Runtime 未运行，请先连接设备'
}

export const explainScheduleError = (message: string): string =>
  errorExplanations[message] || `定时任务管理不可用：${message}`

interface ScheduledTasksState {
  view: ScheduledTasksView
  /** App-lifetime controller; the pane acts through it. */
  controller: ScheduledTasksController | null
  attach(controller: ScheduledTasksController | null): void
}

export const useScheduledTasks = create<ScheduledTasksState>((set) => ({
  view: emptyScheduledTasksView(),
  controller: null,
  attach: (controller) => set({ controller })
}))

/** The device's local timezone name, per decision #63-3; Chromium resolves it
 * without any extra dependency. Unknown → UTC as the last resort. */
export const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Human schedule summary from the platform's own spec — display only. */
export function describeSchedule(task: Pick<ScheduleTaskView, 'scheduleType' | 'scheduleSpec'>): string {
  const spec = task.scheduleSpec
  if (task.scheduleType === 'cron' && spec.cron) return `cron ${spec.cron}`
  if (task.scheduleType === 'interval' && typeof spec.everySeconds === 'number') {
    return spec.everySeconds % 3600 === 0 ? `每 ${spec.everySeconds / 3600} 小时` : `每 ${spec.everySeconds} 秒`
  }
  if (task.scheduleType === 'once' && spec.runAt) return `一次 · ${spec.runAt}`
  return '计划未命名'
}

export class ScheduledTasksController {
  private generation = 0
  constructor(private readonly api: Pick<DesktopBridge, 'schedules'>) {}

  snapshot(): ScheduledTasksView {
    return useScheduledTasks.getState().view
  }

  private apply(change: Partial<ScheduledTasksView>): void {
    useScheduledTasks.setState({ view: { ...useScheduledTasks.getState().view, ...change } })
  }

  private patchTask(task: ScheduleTaskView): void {
    const tasks = this.snapshot().tasks
    const index = tasks.findIndex((row) => row.id === task.id)
    const next = index >= 0
      ? tasks.map((row, at) => (at === index ? task : row))
      : [task, ...tasks]
    this.apply({ tasks: next.slice(0, 200), busy: false, failed: false, error: '' })
  }

  /** One management round-trip; task-row replies patch the authoritative row
   * into the list, id-only replies re-read the platform's own list. */
  private async run(command: Parameters<DesktopBridge['schedules']>[0],
                    options: { patch?: (view: ScheduledTasksView) => Partial<ScheduledTasksView>; retried?: number } = {}): Promise<void> {
    this.generation += 1
    const generation = this.generation
    this.apply({ busy: true, failed: false, error: '', ...(options.patch ? options.patch(this.snapshot()) : {}) })
    try {
      const outcome = await this.api.schedules(command)
      if (generation !== this.generation) return
      if (outcome.action === 'list') {
        this.apply({ tasks: outcome.tasks.slice(0, 200), busy: false, failed: false, error: '' })
      } else if ('task' in outcome) {
        this.patchTask(outcome.task)
      } else if (outcome.action === 'trigger') {
        await this.load()
      } else if (outcome.action === 'delete') {
        const tasks = this.snapshot().tasks.filter((row) => row.id !== outcome.taskId)
        this.apply({ tasks, busy: false, failed: false, error: '' })
      } else if (outcome.action === 'set-skip') {
        const tasks = this.snapshot().tasks.map((row) => (row.id === outcome.taskId ? { ...row, skipOnMissed: outcome.skipOnMissed } : row))
        this.apply({ tasks, busy: false, failed: false, error: '' })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      if (message === 'SCHEDULES_CANCELED') { this.apply({ busy: false, failed: false, error: '' }); return }
      if (message === 'SCHEDULES_BUSY' && (options.retried ?? 0) < 3) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        if (generation !== this.generation) return
        return this.run(command, { ...options, retried: (options.retried ?? 0) + 1 })
      }
      this.apply({ busy: false, failed: true, error: message })
    }
  }

  load(): Promise<void> { return this.run({ action: 'list' }) }

  create(task: Extract<Parameters<DesktopBridge['schedules']>[0], { action: 'create' }>['task']): Promise<void> {
    return this.run({ action: 'create', task })
  }

  update(taskId: string, task: Extract<Parameters<DesktopBridge['schedules']>[0], { action: 'update' }>['task']): Promise<void> {
    return this.run({ action: 'update', taskId, task })
  }

  pause(taskId: string): Promise<void> { return this.run({ action: 'pause', taskId }) }
  resume(taskId: string): Promise<void> { return this.run({ action: 'resume', taskId }) }
  trigger(taskId: string): Promise<void> { return this.run({ action: 'trigger', taskId }) }
  remove(taskId: string): Promise<void> { return this.run({ action: 'delete', taskId }) }

  setSkip(taskId: string, skipOnMissed: boolean): Promise<void> {
    return this.run({ action: 'set-skip', taskId, skipOnMissed })
  }

  /** The execution records of one task, on demand; the reply is bounded and
   * the previous view is replaced, never merged. */
  async openRuns(taskId: string): Promise<void> {
    this.generation += 1
    const generation = this.generation
    this.apply({ runsBusy: true, runs: null, failed: false, error: '' })
    try {
      const outcome = await this.api.schedules({ action: 'runs', taskId, limit: 50, offset: 0 })
      if (generation !== this.generation) return
      if (outcome.action !== 'runs') return
      this.apply({ runs: { taskId, rows: outcome.runs }, runsBusy: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      this.apply({ runsBusy: false, failed: true, error: message })
    }
  }

  closeRuns(): void {
    this.generation += 1
    this.apply({ runs: null })
  }

  /** The platform's own cron preview; the timezone is the device's local one
   * unless the form says otherwise. */
  async preview(cron: string, timezone: string, count = 5): Promise<void> {
    this.generation += 1
    const generation = this.generation
    this.apply({ previewBusy: true, preview: null })
    try {
      const outcome = await this.api.schedules({ action: 'preview', cron, timezone, count })
      if (generation !== this.generation) return
      if (outcome.action !== 'preview') return
      this.apply({ preview: { cron: outcome.cron, timezone: outcome.timezone, occurrences: outcome.occurrences }, previewBusy: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation !== this.generation) return
      this.apply({ previewBusy: false, failed: true, error: message })
    }
  }

  clearPreview(): void {
    this.generation += 1
    this.apply({ preview: null })
  }
}

// Issue 85: the scheduled-tasks management card. The platform owns timing,
// cron previews and execution records; this surface only names actions and
// renders the platform's own rows. nextRunAt is an exact platform instant
// shown in the viewer's local timezone (an exact conversion, never an
// estimation); preview occurrences are the platform's own wall clocks in the
// task's timezone, shown verbatim. 补跑/跳过 marks are device-local display
// truth keyed by the planned point (contract gap #85, decision #63-2/5).
import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Empty, Input, InputNumber, Modal, Radio, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { ClockCircleOutlined, CloudUploadOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { ScheduledTasksController, useScheduledTasks, describeSchedule, explainScheduleError, localTimezone, type ScheduledTasksView } from '../stores/scheduledTasks'
import type { ScheduleDraftCommand, ScheduleMarkView, ScheduleRunView, ScheduleTaskView } from '../../../shared/desktop'

const STATUS_LABELS: Record<string, string> = {
  enabled: '已启用', paused: '已暂停', running: '执行中', completed: '已完成',
  failed: '已失败', cancelled: '已取消', unknown: '未知'
}

const RUN_STATUS_COLORS: Record<string, string> = {
  succeeded: 'green', failed: 'red', running: 'blue', queued: 'gold',
  launching: 'gold', cancelled: 'default', skipped: 'default'
}

const STATUS_COLORS: Record<string, string> = {
  enabled: 'green', paused: 'gold', running: 'blue', completed: 'default',
  failed: 'red', cancelled: 'default', unknown: 'default'
}

const shortTime = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso || ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/** nextRunAt is an exact instant from the platform: convert, never estimate. */
const localTime = (iso: string): string => {
  if (!iso) return '—'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString()
}

function MarkTags({ marks }: { marks: ScheduleMarkView[] }): JSX.Element | null {
  if (!marks.length) return null
  return <span className="ml-1 inline-flex gap-1 align-middle">
    {marks.slice(0, 3).map((mark) => (
      <Tooltip key={mark.plannedAt} title={`${mark.status === 'skipped' ? '已跳过' : '已补跑'} · 计划点 ${localTime(mark.plannedAt)} · ${mark.reason}${mark.error ? ` · ${mark.error}` : ''}`}>
        <Tag color={mark.status === 'skipped' ? 'default' : 'orange'} style={{ marginInlineEnd: 0 }}>
          {mark.status === 'skipped' ? '跳过' : '补跑'}
        </Tag>
      </Tooltip>
    ))}
  </span>
}

/** One task row: the platform's own facts plus the device's 补跑 marks and the
 * per-row actions. A row list, like the notification center — no grid table. */
function TaskRow({ task, controller, busy, runsBusy, onEdit }: {
  task: ScheduleTaskView
  controller: ScheduledTasksController | null
  busy: boolean
  runsBusy: boolean
  onEdit: (task: ScheduleTaskView) => void
}): JSX.Element {
  const act = (action: Promise<void>): void => { void action.catch(() => {}) }
  return <li className="px-3 py-2 border-b border-line-light">
    <div className="flex items-center gap-2">
      <Tag color={STATUS_COLORS[task.status] || 'default'} className="flex-shrink-0">{STATUS_LABELS[task.status] || task.status}</Tag>
      <span className="text-sm text-gray-800 truncate">{task.title}</span>
      <MarkTags marks={task.missedMarks} />
      <span className="ml-auto text-xs text-gray-400 flex-shrink-0">
        {task.assistantId || '平台默认'} · {localTime(task.nextRunAt)}
      </span>
    </div>
    <div className="text-xs text-gray-500 mt-0.5">
      {describeSchedule(task)} · {task.timezone || '—'}
      <span className="ml-2 inline-flex items-center gap-1">
        错过跳过
        <Switch size="small" checked={task.skipOnMissed} aria-label={`错过跳过 ${task.title}`}
          disabled={!controller || busy}
          onChange={(checked) => act(controller!.setSkip(task.id, checked))} />
      </span>
    </div>
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      {task.status === 'enabled'
        ? <Button size="small" icon={<PauseCircleOutlined />} aria-label={`暂停 ${task.title}`}
            disabled={!controller || busy} onClick={() => act(controller!.pause(task.id))}>暂停</Button>
        : <Button size="small" icon={<PlayCircleOutlined />} aria-label={`恢复 ${task.title}`}
            disabled={!controller || busy} onClick={() => act(controller!.resume(task.id))}>恢复</Button>}
      <Button size="small" icon={<ThunderboltOutlined />} aria-label={`立即执行 ${task.title}`}
        disabled={!controller || busy} onClick={() => act(controller!.trigger(task.id))}>立即执行</Button>
      <Button size="small" icon={<CloudUploadOutlined />} aria-label={`执行记录 ${task.title}`}
        disabled={!controller || runsBusy} onClick={() => act(controller!.openRuns(task.id))}>记录</Button>
      <Button size="small" aria-label={`编辑 ${task.title}`}
        disabled={!controller || busy} onClick={() => onEdit(task)}>编辑</Button>
      <Button size="small" danger aria-label={`删除 ${task.title}`}
        disabled={!controller || busy} onClick={() => act(controller!.remove(task.id))}>删除</Button>
    </div>
  </li>
}

function RunsPanel({ view, onClose }: { view: NonNullable<ScheduledTasksView['runs']>; onClose: () => void }): JSX.Element {
  return <Card size="small" className="mt-3" title={`执行记录 · 任务 ${view.taskId.slice(0, 18)}${view.taskId.length > 18 ? '…' : ''}`}
    extra={<Button type="text" size="small" onClick={onClose} aria-label="关闭执行记录">关闭</Button>}>
    {view.rows.length === 0
      ? <Empty description={<Typography.Text type="secondary">该任务还没有执行记录。</Typography.Text>} />
      : <ul className="-mx-3 max-h-72 overflow-auto" aria-label="执行记录列表">
          {view.rows.map((row) => (
            <li key={row.id} className="px-3 py-2 border-b border-line-light">
              <div className="flex items-center gap-2 text-sm">
                <Tag color={RUN_STATUS_COLORS[row.status] || 'default'}>{row.status}</Tag>
                <span className="text-gray-700">{row.createdAt ? shortTime(row.createdAt) : '时间未知'}</span>
                <span className="ml-auto text-xs text-gray-400">{row.trigger || ''}</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {row.plannedFor ? `计划点 ${localTime(row.plannedFor)}` : '平台未标注计划点'}
                {row.threadId ? ` · 会话 ${row.threadId.slice(0, 18)}${row.threadId.length > 18 ? '…' : ''}` : ''}
                {row.error ? ` · ${row.error}` : ''}
              </div>
              {row.catchUp && <div className="text-xs mt-0.5">
                <Tag color={row.catchUp.status === 'skipped' ? 'default' : 'orange'}>
                  {row.catchUp.status === 'skipped' ? '已跳过' : '补跑'}
                </Tag>
                <span className="text-gray-500">{row.catchUp.reason}{row.catchUp.error ? ` · ${row.catchUp.error}` : ''}</span>
              </div>}
            </li>
          ))}
        </ul>}
  </Card>
}

interface DraftForm {
  title: string
  prompt: string
  scheduleType: 'cron' | 'interval' | 'once'
  cron: string
  everySeconds: number
  runAt: string
  timezone: string
  assistantId: string
  contextMode: 'fresh_thread_per_run' | 'reuse_thread'
  threadId: string
}

const emptyDraft = (): DraftForm => ({
  title: '', prompt: '', scheduleType: 'cron', cron: '0 9 * * *', everySeconds: 3600,
  runAt: '', timezone: localTimezone(), assistantId: '', contextMode: 'fresh_thread_per_run', threadId: ''
})

const draftCommand = (form: DraftForm): ScheduleDraftCommand => ({
  title: form.title.trim(), prompt: form.prompt, scheduleType: form.scheduleType,
  scheduleSpec: form.scheduleType === 'cron' ? { cron: form.cron.trim() }
    : form.scheduleType === 'interval' ? { everySeconds: form.everySeconds }
    : { runAt: form.runAt.trim() },
  timezone: form.timezone, assistantId: form.assistantId.trim(),
  contextMode: form.contextMode, threadId: form.contextMode === 'reuse_thread' ? form.threadId.trim() : ''
})

function DraftModal({ editing, open, busy, onClose, onSubmit, onPreview, preview, previewBusy }: {
  editing: ScheduleTaskView | null
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (task: ScheduleDraftCommand) => void
  onPreview: (cron: string, timezone: string) => void
  preview: ScheduledTasksView['preview']
  previewBusy: boolean
}): JSX.Element {
  const [form, setForm] = useState<DraftForm>(emptyDraft)
  const previousOpen = useRef(false)
  useEffect(() => {
    if (open && !previousOpen.current) {
      setForm(editing ? {
        title: editing.title, prompt: editing.prompt, scheduleType: (editing.scheduleType in { cron: 1, interval: 1, once: 1 } ? editing.scheduleType : 'cron') as DraftForm['scheduleType'],
        cron: editing.scheduleSpec.cron ?? '0 9 * * *', everySeconds: editing.scheduleSpec.everySeconds ?? 3600,
        runAt: editing.scheduleSpec.runAt ?? '', timezone: editing.timezone || localTimezone(),
        assistantId: editing.assistantId, contextMode: editing.contextMode === 'reuse_thread' ? 'reuse_thread' : 'fresh_thread_per_run',
        threadId: editing.threadId
      } : emptyDraft())
    }
    previousOpen.current = open
  }, [open, editing])
  const set = (change: Partial<DraftForm>): void => setForm((current) => ({ ...current, ...change }))
  const valid = form.title.trim().length > 0 && form.prompt.trim().length > 0 &&
    (form.scheduleType !== 'cron' || form.cron.trim()) &&
    (form.scheduleType !== 'once' || form.runAt.trim()) &&
    (form.contextMode !== 'reuse_thread' || form.threadId.trim())
  return <Modal open={open} title={editing ? '编辑定时任务' : '新建定时任务'} onCancel={onClose}
    okText={editing ? '保存' : '创建'} cancelText="取消"
    okButtonProps={{ disabled: !valid || busy }}
    onOk={() => onSubmit(draftCommand(form))} width={560}>
    <div className="mt-2 flex flex-col gap-3">
      <div>
        <Typography.Text className="text-xs">任务名称 *</Typography.Text>
        <Input value={form.title} maxLength={200} onChange={(event) => set({ title: event.target.value })}
          placeholder="例如：每日报表" aria-label="任务名称" />
      </div>
      <div>
        <Typography.Text className="text-xs">提示词（每次执行发送给 Agent 的内容） *</Typography.Text>
        <Input.TextArea value={form.prompt} rows={3} maxLength={16000} onChange={(event) => set({ prompt: event.target.value })}
          placeholder="例如：生成昨天的报表" aria-label="提示词" />
      </div>
      <div>
        <Typography.Text className="text-xs">Agent（修复项：此配置会真实传入每次执行）</Typography.Text>
        <Input value={form.assistantId} maxLength={128} onChange={(event) => set({ assistantId: event.target.value })}
          placeholder="留空使用平台默认 lead_agent，例如 report-agent" aria-label="Agent 配置" />
      </div>
      <div>
        <Typography.Text className="text-xs">计划方式 *</Typography.Text>
        <div className="mt-1">
          <Radio.Group value={form.scheduleType} onChange={(event) => set({ scheduleType: event.target.value })}>
            <Radio.Button value="cron">按 cron</Radio.Button>
            <Radio.Button value="interval">按间隔</Radio.Button>
            <Radio.Button value="once">单次</Radio.Button>
          </Radio.Group>
        </div>
      </div>
      {form.scheduleType === 'cron' && <div>
        <Typography.Text className="text-xs">cron 表达式（用户本地时区） *</Typography.Text>
        <Space.Compact className="w-full mt-1">
          <Input value={form.cron} maxLength={256} onChange={(event) => set({ cron: event.target.value })}
            placeholder="分 时 日 月 周，例如 0 9 * * *" aria-label="cron 表达式" />
          <Button icon={<ClockCircleOutlined />} disabled={!form.cron.trim()}
            onClick={() => onPreview(form.cron.trim(), form.timezone)}>预览</Button>
        </Space.Compact>
      </div>}
      {form.scheduleType === 'interval' && <div>
        <Typography.Text className="text-xs">间隔（秒，至少 60） *</Typography.Text>
        <InputNumber className="w-full mt-1" min={60} max={2592000} step={60} value={form.everySeconds}
          onChange={(value) => set({ everySeconds: typeof value === 'number' ? value : 3600 })}
          aria-label="间隔秒数" />
      </div>}
      {form.scheduleType === 'once' && <div>
        <Typography.Text className="text-xs">执行时间（本地时区，如 2026-03-02 09:00） *</Typography.Text>
        <Input className="mt-1" value={form.runAt} onChange={(event) => set({ runAt: event.target.value })}
          placeholder="例如 2026-03-02 09:00" aria-label="执行时间" />
      </div>}
      <div>
        <Typography.Text className="text-xs">时区</Typography.Text>
        <Input value={form.timezone} maxLength={128} onChange={(event) => set({ timezone: event.target.value })}
          placeholder={localTimezone()} aria-label="时区" />
      </div>
      <div>
        <Typography.Text className="text-xs">会话来源</Typography.Text>
        <div className="mt-1">
          <Radio.Group value={form.contextMode} onChange={(event) => set({ contextMode: event.target.value })}>
            <Radio.Button value="fresh_thread_per_run">每次新建会话</Radio.Button>
            <Radio.Button value="reuse_thread">复用会话</Radio.Button>
          </Radio.Group>
        </div>
        {form.contextMode === 'reuse_thread' &&
          <Input className="mt-2" value={form.threadId} maxLength={128}
            onChange={(event) => set({ threadId: event.target.value })}
            placeholder="要复用的会话 ID" aria-label="复用会话 ID" />}
      </div>
      {(previewBusy || preview) && <div className="rounded border border-line-light p-2 mb-2" aria-live="polite">
        <Typography.Text type="secondary" className="text-xs">
          {previewBusy ? '正在向平台请求预览…' : preview
            ? `平台预览（${preview.timezone} 本地时间）：${preview.occurrences.map((row) => row.localTime.replace('T', ' ')).join('；')}`
            : ''}
        </Typography.Text>
      </div>}
      <Typography.Paragraph type="secondary" className="text-xs mb-0">
        时间由平台服务计算与发起；预览与执行记录使用同一套 cron 语义。错过时点上线后补跑一次并标记，
        也可在列表中把单个任务设为“错过即跳过”。
      </Typography.Paragraph>
    </div>
  </Modal>
}

export default function ScheduledTasksPanel(): JSX.Element {
  const view = useScheduledTasks((state) => state.view)
  const controller = useScheduledTasks((state) => state.controller)
  const [draftOpen, setDraftOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduleTaskView | null>(null)
  useEffect(() => { void controller?.load() }, [controller])
  const act = (action: Promise<void>): void => { void action.catch(() => {}) }
  const busyRow = (taskId: string): boolean => view.busy && view.tasks.some((row) => row.id === taskId)
  return <Card title={<span>定时任务 <Badge count={view.tasks.length} size="small" overflowCount={99} /></span>}
    extra={<Space>
      <Tooltip title="刷新（平台为准）">
        <Button type="text" size="small" icon={<ReloadOutlined />} aria-label="刷新定时任务"
          disabled={!controller || view.busy} onClick={() => act(controller!.load())} />
      </Tooltip>
      <Button type="primary" size="small" icon={<PlusOutlined />} aria-label="新建定时任务"
        disabled={!controller} onClick={() => { setEditing(null); setDraftOpen(true) }}>新建</Button>
    </Space>}>
    <Alert className="mb-3" type="info" showIcon message="任务存平台、由平台计时与发起；换电脑任务跟账号走。设备上线后错过的计划点补跑一次并标记，也可按任务设为跳过。" />
    {view.failed && view.error &&
      <Alert className="mb-3" type="error" showIcon message={explainScheduleError(view.error)} />}
    {view.tasks.length === 0
      ? <Empty description={<Typography.Text type="secondary">
          还没有定时任务。登录后点击「新建」创建一个，平台会按计划在本地时区发起执行。
        </Typography.Text>} />
      : <ul className="-mx-4" aria-label="定时任务列表">
          {view.tasks.map((task) => (
            <TaskRow key={task.id} task={task} controller={controller} busy={busyRow(task.id)}
              runsBusy={view.runsBusy} onEdit={(row) => { setEditing(row); setDraftOpen(true) }} />
          ))}
        </ul>}
    {view.runs && <RunsPanel view={view.runs} onClose={() => controller?.closeRuns()} />}
    <DraftModal editing={editing} open={draftOpen} busy={view.busy}
      onClose={() => setDraftOpen(false)}
      onSubmit={(task) => {
        act(editing ? controller!.update(editing.id, {
          title: task.title, prompt: task.prompt, scheduleType: task.scheduleType,
          scheduleSpec: task.scheduleSpec, timezone: task.timezone, assistantId: task.assistantId,
          contextMode: task.contextMode, threadId: task.threadId
        }) : controller!.create(task))
        setDraftOpen(false)
      }}
      onPreview={(cron, timezone) => act(controller!.preview(cron, timezone))}
      preview={view.preview} previewBusy={view.previewBusy} />
    <Typography.Paragraph type="secondary" className="mt-3 text-xs mb-0">
      每次执行会话可在平台的会话列表中查看（会话关联）；执行记录按计划点幂等，不会重复执行。
    </Typography.Paragraph>
  </Card>
}

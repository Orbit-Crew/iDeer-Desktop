// Issue 111: the Agent-controlled terminal pane — a read-only projection of
// the Runtime's own recorded command history and in-flight tails. The
// platform Agent addresses the terminal through the `local.terminal`
// capability; this surface offers no input, no PTY and no fabricated
// activity: every row is a device-recorded fact with its honest end state,
// and a stopped/timed-out/interrupted command renders 结果待核实 and is
// never re-run. Output is escaped text (pre-wrap), never a terminal
// emulator, so untrusted output cannot drive this pane.
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Tag, Tooltip, Typography } from 'antd'
import { StopOutlined } from '@ant-design/icons'
import type { AgentTerminalEntryView } from '../../../../shared/desktop'
import { AgentTerminalController, type AgentTerminalView } from '../../stores/agentTerminal'

const STATUS_VIEWS: Record<AgentTerminalEntryView['status'], { label: string; color: string }> = {
  running: { label: '运行中', color: 'processing' },
  completed: { label: '已完成', color: 'success' },
  failed: { label: '已失败', color: 'error' },
  cancelled: { label: '已停止', color: 'warning' },
  timed_out: { label: '已超时', color: 'warning' },
  interrupted: { label: '已中断', color: 'warning' },
  refused: { label: '已拒绝', color: 'default' }
}

const BASIS_LABELS: Record<string, string> = {
  'consent:allow_once': '逐条询问通过',
  'consent:stored': '逐条询问通过',
  'tier:full': '完全模式',
  policy: '策略拒绝',
  policy_denied: '策略拒绝'
}

function basisLabel(basis: string): string {
  const named = BASIS_LABELS[basis]
  if (named) return named
  if (basis.startsWith('tier:')) return `档位 ${basis.slice(5)}`
  return basis || '—'
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString()
}

function Entry({ row, stopping, onStop }: {
  row: AgentTerminalEntryView
  stopping: boolean
  onStop: (runId: string) => void
}): JSX.Element {
  const view = STATUS_VIEWS[row.status]
  return <div role="listitem" aria-label={`命令：${row.command}`}
    className="mb-3 border border-gray-200 bg-white" style={{ borderRadius: 8 }}>
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2">
      <span aria-label="命令行" className="font-mono text-sm text-gray-900" style={{ overflowWrap: 'anywhere' }}>
        <span className="mr-1 select-none text-gray-400">$</span>{row.command}
      </span>
      <Tag aria-label={`状态 ${view.label}`} color={view.color} className="mr-0">{view.label}</Tag>
      {row.status === 'failed' && row.exitCode != null &&
        <Tag aria-label="退出码" color="error" className="mr-0">退出码 {row.exitCode}</Tag>}
      {row.effectsUncertain && <Tooltip title="停止、超时或中断的命令无法证明其文件效果是否完成；结果待核实，且不会自动重跑。">
        <Tag aria-label="效果待核实" color="warning" className="mr-0">效果待核实</Tag>
      </Tooltip>}
      {row.status === 'running' && row.runId &&
        <Button size="small" danger icon={<StopOutlined />} loading={stopping}
          onClick={() => onStop(row.runId)}>停止</Button>}
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 text-xs text-gray-500">
      <span>目录 {row.workingRoot || '—'}</span>
      <span>授权 {basisLabel(row.authorizationBasis)}</span>
      {row.startedAt && <span>开始 {formatTime(row.startedAt)}</span>}
      {row.finishedAt && <span>结束 {formatTime(row.finishedAt)}</span>}
    </div>
    {(row.stdoutTail || row.stderrTail) &&
      <div className="px-3 pb-3 pt-1">
        {row.stdoutTail && <pre aria-label="标准输出" className="m-0 whitespace-pre-wrap font-mono text-xs text-gray-800" style={{ overflowWrap: 'anywhere' }}>{row.stdoutTail}</pre>}
        {row.stderrTail && <pre aria-label="标准错误" className="m-0 mt-2 whitespace-pre-wrap font-mono text-xs text-red-700" style={{ overflowWrap: 'anywhere' }}>{row.stderrTail}</pre>}
      </div>}
  </div>
}

/** The pure view: exactly what the Runtime recorded, or an explicit
 * unavailable/empty state — never a fabricated command or a fake process. */
export function AgentTerminalViewComponent({ view, stopping, onStop }: {
  view: AgentTerminalView
  stopping: boolean
  onStop: (runId: string) => void
}): JSX.Element {
  const runtimeRunning = view.status?.runtime.process === 'running'
  const storageError = view.status?.runtime.agentTerminalStorageError
  const running = view.commands.filter((row) => row.status === 'running')
  return <div className="h-full w-full overflow-auto p-4" style={{ background: 'var(--pane-bg, #F4F6FA)' }}>
    <div className="mb-1 flex items-center gap-2">
      <span className="text-sm font-medium text-gray-800">受控终端</span>
      <span className="text-xs text-gray-500">Agent 命令历史 · 只读观察</span>
    </div>
    <Typography.Paragraph type="secondary" className="mb-3 text-xs">
      命令由平台 Agent 经受控通道下发，由本机 Runtime 在授权文件夹内承载并逐条审批；
      本窗格不提供人工输入，也不接管人工终端。停止只会请求中止当前命令，
      已停止或超时的命令标记「效果待核实」，不会自动重跑。
    </Typography.Paragraph>
    {!runtimeRunning
      ? <Alert type="warning" showIcon message="本机 Runtime 未运行" description="Agent 命令历史与运行状态不可读；启动 Runtime 后自动恢复。" />
      : storageError
        ? <Alert type="error" showIcon message="终端历史存储不可读" description="命令历史暂无法读取（TERMINAL_STORAGE_UNAVAILABLE）；运行中的命令不受影响。" />
        : view.failed
          ? <Alert type="warning" showIcon message="读取失败" description="本机 Runtime 未响应命令历史读取，请稍后重试。" />
          : view.commands.length === 0
            ? <Empty description="本账户在本机还没有受控终端命令记录" />
            : <div role="list">
              {running.length > 0 &&
                <Alert className="mb-3" type="info" showIcon
                  message={`正在运行 ${running.length} 条命令`} description="输出为实时尾部，停止只作用于当前命令。" />}
              {[...view.commands].reverse().map((row) =>
                <Entry key={row.taskId} row={row} stopping={stopping} onStop={onStop} />)}
            </div>}
  </div>
}

export default function AgentTerminalPane(): JSX.Element {
  const [view, setView] = useState<AgentTerminalView>(() => ({ status: null, commands: [], failed: false }))
  const [stopping, setStopping] = useState(false)
  const controller = useRef<AgentTerminalController | null>(null)
  if (controller.current === null) {
    controller.current = new AgentTerminalController(window.ideer, setView)
  }
  useEffect(() => {
    const current = controller.current!
    void current.refresh()
    const timer = setInterval(() => void current.refresh(), 1000)
    return () => { clearInterval(timer); current.invalidate() }
  }, [])
  const runStop = (runId: string) => {
    setStopping(true)
    void controller.current!.stop(runId)
      .catch(() => undefined)
      .finally(() => setStopping(false))
  }
  return <AgentTerminalViewComponent view={view} stopping={stopping} onStop={runStop} />
}

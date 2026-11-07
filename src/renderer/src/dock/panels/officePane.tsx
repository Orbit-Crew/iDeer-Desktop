// Issue 112: the office pane returns as the read-only visualization of the
// platform's Run/subagent events — the #95 office exclusion narrows to
// exactly this surface. Every station is one platform-reported sub-agent:
// who started (task_started), who is busy (task_running), who finished
// (task_completed/failed/cancelled/timed_out), folded by the Runtime into
// the chat snapshot's `subagents` ledger. The pane subscribes to nothing of
// its own: it performs the same read-only `state` read the conversation
// already performs on the trusted chat bridge, renders exactly the pushed
// states in the platform's arrival order, and offers no control surface, no
// local message bus and no second engine — when the platform pushed nothing,
// it says so instead of inventing activity.
import { useEffect, useRef, useState } from 'react'
import { Alert, Empty, Tag, Typography } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import type { ChatSnapshot, ChatSubagent } from '../../../../shared/desktop'
import { SUBAGENT_STATUS_VIEWS } from '../../../../shared/desktop'

function Station({ row }: { row: ChatSubagent }): JSX.Element {
  const view = SUBAGENT_STATUS_VIEWS[row.status]
  const label = view.label
  return <div role="listitem" aria-label={`工位：${row.description || '（平台未提供描述）'}`}
    className="mb-2 flex items-start gap-3 border border-gray-200 bg-white px-3 py-2" style={{ borderRadius: 8 }}>
    <span aria-label={`小人 ${label}`} className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500">
      <UserOutlined />
    </span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-800" style={{ overflowWrap: 'anywhere' }}>
          {row.description || '（平台未提供描述）'}
        </span>
        <Tag aria-label={`子代理状态 ${label}`} color={view.color} className="mr-0">{label}</Tag>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
        {row.agent && <span>类型：{row.agent}</span>}
        {row.model && <span>模型：{row.model}</span>}
        {row.step != null && row.totalSteps != null && <span>步骤：{row.step}/{row.totalSteps}</span>}
      </div>
      {row.error && <Typography.Paragraph type="warning" className="mb-0 mt-1 text-xs" style={{ overflowWrap: 'anywhere' }}>
        {row.error}{row.errorTruncated ? '…（已截断）' : ''}
      </Typography.Paragraph>}
      {row.result && <Typography.Paragraph className="mb-0 mt-1 text-xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {row.result}{row.resultTruncated ? '…（已截断，完整结果见会话消息）' : ''}
      </Typography.Paragraph>}
    </div>
  </div>
}

/** The pure view: exactly what the platform pushed, or an explicit
 * unavailable/empty state — never a fabricated figure. */
export function OfficeView({ failed, subagents }: { failed: boolean; subagents: ChatSubagent[] }): JSX.Element {
  return <div className="h-full w-full overflow-auto p-4" style={{ background: 'var(--pane-bg, #F4F6FA)' }}>
    <div className="mb-1 flex items-center gap-2">
      <span className="text-sm font-medium text-gray-800">办公室</span>
      <span className="text-xs text-gray-500">平台 Run / 子代理事件 · 只读</span>
    </div>
    <Typography.Paragraph type="secondary" className="mb-3 text-xs">
      小人与工位只按平台真实推送的子代理事件呈现（谁开工、在忙、完工）；本页无任何控制操作，动态不由本机生成。
    </Typography.Paragraph>
    {failed
      ? <Alert type="warning" showIcon message="平台未连接，办公室动态不可用"
          description="读取平台会话状态失败；连接恢复后这里会显示平台派发的子代理动态。" />
      : subagents.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无子代理动态" />
        : <div role="list" aria-label="子代理工位">{subagents.map((row) => <Station key={row.taskId} row={row} />)}</div>}
  </div>
}

/** The pane: a slow read-only poll of the same snapshot the conversation
 * reads. It writes no store, sends no command and mutates no session state —
 * the office observes; the conversation owns the session. */
export default function OfficePane(): JSX.Element {
  const [state, setState] = useState<ChatSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    // 1s cadence: an observer, not the conversation's own 500ms loop; the
    // platform's task_* events land in the ledger either way.
    const poll = async (): Promise<void> => {
      if (!inFlight.current) {
        inFlight.current = true
        try {
          const next = await window.ideer.chat({ action: 'state' })
          if (mounted.current) { setState(next); setFailed(false) }
        } catch { if (mounted.current) { setState(null); setFailed(true) } }
        finally { inFlight.current = false }
      }
      if (mounted.current) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [])
  return <OfficeView failed={failed} subagents={state?.subagents ?? []} />
}

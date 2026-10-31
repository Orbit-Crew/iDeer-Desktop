// Issue 77: the notification center pane — one native surface over the
// main-process ledger. Rows show identity facts only, jump back to their
// session through the same sidebar handshake, and settle (read/clear) on the
// trusted main process. Later tickets reuse the same list; nothing here is
// chat-specific except the kind labels.
import { BellOutlined, CheckOutlined, ClearOutlined } from '@ant-design/icons'
import { Badge, Button, Empty, Tooltip, Typography } from 'antd'
import { useNotificationCenter } from '../../stores/notificationCenter'
import type { NotificationRecordView } from '../../../../shared/desktop'

const kindLabels: Record<NotificationRecordView['kind'], string> = {
  'run-finished': '会话完成',
  'approval-required': '等待审批'
}

const statusLabels: Record<string, string> = {
  success: '成功', error: '出错', failed: '失败', interrupted: '已中断'
}

const approvalLabels: Record<string, string> = {
  'file-write': '文件写入', 'skill-script': 'Skill 脚本', 'knowledge-material': '知识取材'
}

const shortTime = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

function NotificationRow({ row, onOpen }: { row: NotificationRecordView; onOpen: (row: NotificationRecordView) => void }): JSX.Element {
  const subject = row.title || `会话 ${row.threadId.slice(0, 12)}`
  const outcome = row.kind === 'run-finished'
    ? (statusLabels[row.status] || row.status)
    : (approvalLabels[row.approval || ''] || row.approval || '')
  const detail = row.kind === 'approval-required' && row.summary ? `${outcome} · ${row.summary}` : outcome
  return <li className={`px-3 py-2 border-b border-line-light ${row.read ? '' : 'bg-primary/5'}`}>
    <button onClick={() => onOpen(row)} disabled={!onOpen} className="w-full text-left"
      title={`打开会话 ${subject}`} aria-label={`${kindLabels[row.kind]}：${subject}，点击跳回会话`}>
      <div className="flex items-center gap-2">
        {!row.read && <span aria-label="未读" className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
        <span className="text-sm text-gray-800 truncate">{subject}</span>
        <span className="ml-auto text-xs text-gray-400 flex-shrink-0">{shortTime(row.createdAt)}</span>
      </div>
      <div className="text-xs text-gray-500 mt-0.5">
        {kindLabels[row.kind]}{detail ? ` · ${detail}` : ''}
      </div>
    </button>
  </li>
}

export default function NotificationsPane(): JSX.Element {
  const view = useNotificationCenter((state) => state.view)
  const controller = useNotificationCenter((state) => state.controller)
  // 静态启动或控制器未挂载时保持只读展示；主进程的推送会带来真实视图。
  const open = (row: NotificationRecordView): void => { void controller?.open(row.id, row.threadId) }
  return <div className="h-full w-full overflow-auto p-4" style={{ background: 'var(--pane-bg, #F4F6FA)' }}>
    <div className="flex items-center gap-2 mb-3">
      <span className="text-sm text-gray-500">后台会话通知</span>
      <Badge count={view.unread} size="small" overflowCount={99} />
      <span className="ml-auto flex items-center gap-1">
        <Tooltip title="全部标为已读">
          <Button type="text" size="small" icon={<CheckOutlined />} aria-label="全部标为已读"
            disabled={!controller || view.notifications.length === 0}
            onClick={() => void controller?.markAllRead()} />
        </Tooltip>
        <Tooltip title="清空通知">
          <Button type="text" size="small" icon={<ClearOutlined />} aria-label="清空通知"
            disabled={!controller || view.notifications.length === 0}
            onClick={() => void controller?.clear()} />
        </Tooltip>
      </span>
    </div>
    {view.notifications.length === 0
      ? <Empty description={<Typography.Text type="secondary">暂无通知。切走的会话完成或等待审批时会出现在这里。</Typography.Text>} />
      : <ul className="-mx-4" aria-label="通知列表">
          {view.notifications.map((row) => <NotificationRow key={row.id} row={row} onOpen={open} />)}
        </ul>}
    <Typography.Paragraph type="secondary" className="mt-4 text-xs">
      点击通知跳回对应会话。切走的会话任务会继续执行，不受窗口切换影响。
    </Typography.Paragraph>
  </div>
}

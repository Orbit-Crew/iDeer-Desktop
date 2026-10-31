// Issue 72: the session sidebar's full management — search, rename, delete and
// recency ordering, all riding the platform's own Thread API. The list is the
// Server's own post-action reply; nothing local is kept, and deleting a thread
// never clears this device's unconfirmed receipts.
import { DeleteOutlined, EditOutlined, DoubleLeftOutlined, RocketOutlined, SearchOutlined, UndoOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Popconfirm, Typography } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { explainThreadError, SessionSidebarController, emptySessionSidebarView, type SessionSidebarView } from '../../stores/sessionSidebar'
import type { ThreadRowView } from '../../../../shared/desktop'

const statusLabels: Record<string, string> = { idle: '空闲', busy: '进行中', interrupted: '已中断', error: '异常' }

const shortTime = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

function ThreadRow({ row, active, canRename, canDelete, busy, onOpen, onRename, onDelete }: {
  row: ThreadRowView
  active: boolean
  canRename: boolean
  canDelete: boolean
  busy: boolean
  onOpen: () => void
  onRename: (title: string) => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.title)
  const renameReason = canRename ? '' : '当前账号缺少 threads:write 权限，无法重命名会话'
  const deleteReason = canDelete ? '' : '当前账号缺少 threads:delete 权限，无法删除会话'
  if (editing) {
    return <li className="px-3 py-2">
      <Input aria-label={`重命名会话 ${row.title}`} value={draft} maxLength={200} autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onPressEnter={() => { const next = draft.trim(); if (next && next !== row.title) onRename(next); setEditing(false) }}
        suffix={<Typography.Link role="button" aria-label="确认重命名" onClick={() => {
          const next = draft.trim()
          if (next && next !== row.title) onRename(next)
          setEditing(false)
        }}>确定</Typography.Link>} />
    </li>
  }
  return <li className={`px-3 py-2 flex items-center gap-1 hover:bg-gray-50 ${active ? 'bg-primary/5' : ''}`}>
    <button onClick={onOpen} disabled={busy}
      className="flex-1 min-w-0 text-left" title={`打开会话 ${row.title}`} aria-label={`打开会话 ${row.title}`}>
      <div className="text-sm text-gray-800 truncate">{row.title}</div>
      <div className="text-xs text-gray-500">
        {statusLabels[row.status] || row.status}{row.updatedAt ? ` · ${shortTime(row.updatedAt)}` : ''}
      </div>
    </button>
    <span className="flex items-center">
      {renameReason
        ? <span title={renameReason}><Button type="text" size="small" icon={<EditOutlined />} disabled
            aria-label={`重命名会话 ${row.title}（不可用：${renameReason}）`} /></span>
        : <Button type="text" size="small" icon={<EditOutlined />} disabled={busy}
            aria-label={`重命名会话 ${row.title}`} title="重命名会话"
            onClick={() => { setDraft(row.title); setEditing(true) }} />}
    </span>
    <Popconfirm title="删除该平台会话？" description="将移除平台上的对话历史，不可恢复；本机未确认回执保留可查。"
      okText="删除" cancelText="取消" onConfirm={onDelete} disabled={busy || !canDelete}>
      {deleteReason
        ? <span title={deleteReason}><Button type="text" size="small" danger icon={<DeleteOutlined />} disabled
            aria-label={`删除会话 ${row.title}（不可用：${deleteReason}）`} /></span>
        : <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={busy}
            aria-label={`删除会话 ${row.title}`} title="删除平台会话（本机未确认回执保留）" />}
    </Popconfirm>
  </li>
}

function SessionSidebar({ view, activeThreadId, onOpenThread, onSearch, onLoad, onRename, onDelete }: {
  view: SessionSidebarView
  activeThreadId: string
  onOpenThread: (threadId: string) => void
  onSearch: (query: string) => void
  onLoad: () => void
  onRename: (threadId: string, title: string) => void
  onDelete: (threadId: string) => void
}): JSX.Element {
  const query = view.query
  const [draftQuery, setDraftQuery] = useState(query)
  useEffect(() => { setDraftQuery(query) }, [query])
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleSearch = (value: string): void => {
    setDraftQuery(value)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => onSearch(value.trim()), 300)
  }
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])
  const readOnly = !view.permissions.canRename && !view.permissions.canDelete
  const rows = useMemo(() => view.threads.filter((row) => !draftQuery.trim() ||
    row.title.toLowerCase().includes(draftQuery.trim().toLowerCase()) ||
    row.id.toLowerCase().includes(draftQuery.trim().toLowerCase())), [view.threads, draftQuery])
  // The Server already returns the authoritative post-action list, recency
  // ordered; the live draft filter is display-only between rounds.
  const ordered = useMemo(() => [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [rows])
  return <>
    <div className="py-2 flex items-center gap-2">
      <span className="text-sm text-gray-500">会话</span>
      <Button type="text" size="small" icon={<UndoOutlined />} disabled={view.busy} aria-label="刷新会话列表"
        onClick={onLoad} title="从平台刷新会话列表" />
    </div>
    <Input allowClear prefix={<SearchOutlined />} aria-label="搜索平台会话" placeholder="搜索平台会话"
      value={draftQuery} maxLength={128} disabled={view.busy}
      onChange={(event) => scheduleSearch(event.target.value)} />
    {view.failed && <Alert type="error" showIcon className="mt-2" message={explainThreadError(view.error)} />}
    {!view.failed && !view.threads.length && !view.busy &&
      <p className="mt-3 text-xs text-gray-500">暂无平台会话。在聊天面板新建会话后，这里会显示平台返回的列表。</p>}
    {view.failed && !view.threads.length ? null : (
      readOnly && view.threads.length ? <p className="mt-2 text-xs text-gray-400">当前账号为只读，重命名与删除不可用。</p> : null)}
    <ul className="mt-1 -mx-3 overflow-auto" aria-label="平台会话列表">
      {ordered.map((row) => <ThreadRow key={row.id} row={row} active={row.id === activeThreadId} busy={view.busy}
        canRename={view.permissions.canRename} canDelete={view.permissions.canDelete}
        onOpen={() => onOpenThread(row.id)}
        onRename={(title) => onRename(row.id, title)}
        onDelete={() => onDelete(row.id)} />)}
    </ul>
    {!view.failed && view.threads.length > 0 && ordered.length === 0 &&
      <p className="mt-2 text-xs text-gray-500">没有匹配「{draftQuery.trim()}」的平台会话。</p>}
  </>
}

export default function Sidebar(): JSX.Element {
  const toggleLeftPanel = useUIStore((state) => state.toggleLeftPanel)
  const requestOpen = useSessionStore((state) => state.requestOpen)
  const activeThreadId = useSessionStore((state) => state.activeThreadId)
  const [view, setView] = useState<SessionSidebarView>(emptySessionSidebarView)
  const controllerRef = useRef<SessionSidebarController | null>(null)
  // Static startup markup renders without a preload bridge; the sidebar then
  // shows its empty state and only manages sessions once the bridge exists.
  const bridge = typeof window !== 'undefined' ? window.ideer : undefined
  if (!controllerRef.current && bridge) {
    controllerRef.current = new SessionSidebarController(bridge, setView)
  }
  const controller = controllerRef.current
  useEffect(() => {
    if (!controller) return
    void controller.load()
    return () => controller.invalidate()
  }, [controller])
  return (
    <aside className="w-[260px] min-w-[260px] h-full flex flex-col border-r border-line bg-white text-gray-700">
      <div className="px-5 py-4 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-card">
          <RocketOutlined className="text-white text-base" />
        </div>
        <span className="text-base font-semibold text-gray-900">iDeer Desktop</span>
        <button onClick={toggleLeftPanel} className="ml-auto p-1.5 text-gray-400 rounded"
          title="隐藏侧边栏" aria-label="隐藏侧边栏">
          <DoubleLeftOutlined style={{ fontSize: 12 }} />
        </button>
      </div>
      <div className="px-5 pb-4 flex-1 min-h-0 flex flex-col">
        <SessionSidebar view={view} activeThreadId={activeThreadId}
          onOpenThread={requestOpen}
          onSearch={(query) => void controller?.search(query)}
          onLoad={() => void controller?.load()}
          onRename={(threadId, title) => void controller?.rename(threadId, title)}
          onDelete={(threadId) => void controller?.remove(threadId)} />
      </div>
      <div className="px-5 py-4 border-t border-line-light text-xs text-gray-500">
        <p className="mb-3">版本 0.1.0</p>
        <Button block onClick={() => void window.ideer.quit()}>退出应用</Button>
      </div>
    </aside>
  )
}

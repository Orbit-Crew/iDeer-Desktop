// Adapted from the pinned linz Sidebar. Business navigation is not enabled.
// Issue 73: the original bottom settings entry restored; the modal carries
// the model settings surface only (no provider or credential section).
// Issue 72: the session sidebar's full management — search, rename, delete and
// recency ordering, all riding the platform's own Thread API. The list is the
// Server's own post-action reply; nothing local is kept, and deleting a thread
// never clears this device's unconfirmed receipts.
// Issue 91: platform project management lands in the same place — the
// sidebar's project directory (create/switch/rename/archive/delete via the
// Server's own Project API), the 散会话 bucket, move-into-project and
// per-project grouping, all projected from the Server's own replies.
import { BellOutlined, DeleteOutlined, EditOutlined, DoubleLeftOutlined, FolderOutlined, FolderAddOutlined, RocketOutlined, SearchOutlined, SettingOutlined, UndoOutlined } from '@ant-design/icons'
import { Alert, Badge, Button, Dropdown, Input, Popconfirm, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore, type ProjectSelection } from '../../stores/sessionStore'
import { useNotificationCenter } from '../../stores/notificationCenter'
import { useDockStore } from '../../dock/dockStore'
import { explainThreadError, SessionSidebarController, emptySessionSidebarView, type SessionSidebarView } from '../../stores/sessionSidebar'
import { explainProjectError, ProjectDirectoryController, emptyProjectDirectoryView, type ProjectDirectoryView } from '../../stores/projectDirectory'
import ModelSettingsModal from './ModelSettingsModal'
import ProjectManageModal from './ProjectManageModal'
import type { ThreadRowView } from '../../../../shared/desktop'

const statusLabels: Record<string, string> = { idle: '空闲', busy: '进行中', interrupted: '已中断', error: '异常' }

const shortTime = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

function ThreadRow({ row, active, canRename, canDelete, busy, moveTargets, onOpen, onRename, onDelete, onMove }: {
  row: ThreadRowView
  active: boolean
  canRename: boolean
  canDelete: boolean
  busy: boolean
  moveTargets: { key: string; label: string }[]
  onOpen: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onMove: (projectId: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.title)
  const renameReason = canRename ? '' : '当前账号缺少 threads:write 权限，无法重命名会话'
  const deleteReason = canDelete ? '' : '当前账号缺少 threads:delete 权限，无法删除会话'
  const moveReason = canRename ? '' : '当前账号缺少 threads:write 权限，无法移入项目'
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
      {moveReason || !moveTargets.length
        ? <span title={moveReason || '没有可移入的项目，先在项目管理里创建一个'}><Button type="text" size="small" icon={<FolderAddOutlined />} disabled
            aria-label={`移入项目 ${row.title}（不可用）`} /></span>
        : <Dropdown menu={{ items: moveTargets, onClick: ({ key }) => onMove(key) }} trigger={['click']}>
            <Button type="text" size="small" icon={<FolderAddOutlined />} disabled={busy}
              aria-label={`移入项目 ${row.title}`} title="移入项目" />
          </Dropdown>}
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

/** Issue 91: the sidebar's grouping is a display projection of the Server's
 * own rows — membership rides each row's platform stamp, so no local roster
 * exists and a deleted or foreign project id can only ever fall back to the
 * 散会话 bucket, never invent a group. */
function groupRows(rows: ThreadRowView[], projectNames: Map<string, string>, selection: ProjectSelection):
  { key: string; label: string; rows: ThreadRowView[] }[] {
  const loose = rows.filter((row) => !row.projectId || !projectNames.has(row.projectId))
  const projectRows = (projectId: string): ThreadRowView[] => rows.filter((row) => row.projectId === projectId)
  if (selection.kind === 'loose') return loose.length ? [{ key: 'loose', label: '散会话', rows: loose }] : []
  if (selection.kind === 'project') return projectRows(selection.projectId).length
    ? [{ key: selection.projectId, label: projectNames.get(selection.projectId) || '项目会话', rows: projectRows(selection.projectId) }]
    : []
  const groups: { key: string; label: string; rows: ThreadRowView[] }[] = []
  for (const [projectId, name] of projectNames) {
    const members = projectRows(projectId)
    if (members.length) groups.push({ key: projectId, label: name, rows: members })
  }
  if (loose.length) groups.push({ key: 'loose', label: '散会话', rows: loose })
  return groups
}

function SessionSidebar({ view, projects, activeThreadId, onOpenThread, onSearch, onLoad, onRename, onDelete, onMove }: {
  view: SessionSidebarView
  projects: ProjectDirectoryView
  activeThreadId: string
  onOpenThread: (threadId: string) => void
  onSearch: (query: string) => void
  onLoad: () => void
  onRename: (threadId: string, title: string) => void
  onDelete: (threadId: string) => void
  onMove: (threadId: string, projectId: string) => void
}): JSX.Element {
  const projectSelection = useSessionStore((state) => state.projectSelection)
  const setProjectSelection = useSessionStore((state) => state.setProjectSelection)
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
  // The Server's reply is the authoritative post-action list, recency
  // ordered and already narrowed by the query — the project grouping below is
  // a display projection of that same reply, never a merge of local state.
  const rows = view.threads
  const projectNames = new Map(projects.projects.map((row) => [row.id, row.name]))
  const activeProjects = projects.projects.filter((row) => row.status === 'active')
  const groups = groupRows(rows, projectNames, projectSelection)
  return <>
    <div className="py-2 flex items-center gap-2">
      <span className="text-sm text-gray-500">会话</span>
      <Button type="text" size="small" icon={<UndoOutlined />} disabled={view.busy} aria-label="刷新会话列表"
        onClick={onLoad} title="从平台刷新会话列表" />
    </div>
    <div className="flex flex-col gap-0.5" role="tablist" aria-label="项目视图">
      <div className="flex gap-1">
        <Button size="small" type={projectSelection.kind === 'all' ? 'primary' : 'default'} aria-label="查看全部会话"
          onClick={() => setProjectSelection({ kind: 'all' })}>全部会话</Button>
        <Button size="small" type={projectSelection.kind === 'loose' ? 'primary' : 'default'} aria-label="查看散会话"
          onClick={() => setProjectSelection({ kind: 'loose' })}>散会话</Button>
      </div>
      {activeProjects.map((project) =>
        <Button key={project.id} size="small" className="justify-start"
          type={projectSelection.kind === 'project' && projectSelection.projectId === project.id ? 'primary' : 'default'}
          aria-label={`切换到项目 ${project.name}`} title={`项目 ${project.name}`}
          onClick={() => setProjectSelection({ kind: 'project', projectId: project.id })}>
          <span className="truncate">{project.name}</span>
        </Button>)}
    </div>
    <Input allowClear prefix={<SearchOutlined />} aria-label="搜索平台会话" placeholder="搜索平台会话"
      value={draftQuery} maxLength={128} disabled={view.busy}
      onChange={(event) => scheduleSearch(event.target.value)} />
    {view.failed && <Alert type="error" showIcon className="mt-2" message={explainThreadError(view.error)} />}
    {projects.failed && <Alert type="error" showIcon className="mt-2" message={explainProjectError(projects.error)} />}
    {!view.failed && !rows.length && !view.busy &&
      <p className="mt-3 text-xs text-gray-500">暂无平台会话。在聊天面板新建会话后，这里会显示平台返回的列表。</p>}
    {!view.failed && rows.length && readOnly &&
      <p className="mt-2 text-xs text-gray-400">当前账号为只读，重命名与删除不可用。</p>}
    <ul className="mt-1 -mx-3 overflow-auto" aria-label="平台会话列表">
      {groups.map((group) => <li key={group.key}>
        {(projectSelection.kind !== 'project') &&
          <div className="px-3 pt-2 pb-1 text-xs text-gray-400" aria-label={`分组 ${group.label}`}>{group.label}</div>}
        {group.rows.map((row) => <ThreadRow key={row.id} row={row} active={row.id === activeThreadId} busy={view.busy}
          canRename={view.permissions.canRename} canDelete={view.permissions.canDelete}
          moveTargets={activeProjects.filter((project) => project.id !== row.projectId)
            .map((project) => ({ key: project.id, label: project.name }))}
          onOpen={() => onOpenThread(row.id)}
          onRename={(title) => onRename(row.id, title)}
          onDelete={() => onDelete(row.id)}
          onMove={(projectId) => onMove(row.id, projectId)} />)}
      </li>)}
    </ul>
    {!view.failed && !rows.length && view.query.trim() &&
      <p className="mt-2 text-xs text-gray-500">没有匹配「{view.query.trim()}」的平台会话。</p>}
  </>
}

export default function Sidebar(): JSX.Element {
  const toggleLeftPanel = useUIStore((state) => state.toggleLeftPanel)
  const requestOpen = useSessionStore((state) => state.requestOpen)
  const activeThreadId = useSessionStore((state) => state.activeThreadId)
  // Issue 78: a successful branch changes the Server's own session set under
  // this list; the bump is the one signal that re-reads it.
  const sessionsVersion = useSessionStore((state) => state.sessionsVersion)
  const unreadNotifications = useNotificationCenter((state) => state.view.unread)
  // Issue 73: the model settings modal rides the restored bottom entry.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [view, setView] = useState<SessionSidebarView>(emptySessionSidebarView)
  const [projectView, setProjectView] = useState<ProjectDirectoryView>(emptyProjectDirectoryView)
  const controllerRef = useRef<SessionSidebarController | null>(null)
  const projectControllerRef = useRef<ProjectDirectoryController | null>(null)
  const loadedVersion = useRef(0)
  // Static startup markup renders without a preload bridge; the sidebar then
  // shows its empty state and only manages sessions once the bridge exists.
  useEffect(() => {
    let active = true
    const current = new SessionSidebarController(window.ideer, (next) => { if (active) setView(next) })
    controllerRef.current = current
    const projectController = new ProjectDirectoryController(window.ideer, (next) => { if (active) setProjectView(next) })
    projectControllerRef.current = projectController
    void (async () => {
      // The chat poll records the session scope the Runtime reports; align
      // the first load with it instead of failing on a cold start.
      for (let attempt = 0; attempt < 4; attempt++) {
        await current.load()
        if (!active) return
        const { error, threads } = current.snapshot()
        if (error !== 'CHAT_IDENTITY_CHANGED' || threads.length || attempt === 3) return
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (!active) return
      }
    })()
    void projectController.load()
    loadedVersion.current = useSessionStore.getState().sessionsVersion
    return () => { active = false; current.invalidate(); projectController.invalidate(); if (controllerRef.current === current) controllerRef.current = null }
  }, [])
  useEffect(() => {
    // The mount effect consumes the version it started with; only a bump
    // after mount (a branch this session performed) triggers one reload.
    if (sessionsVersion === loadedVersion.current) return
    loadedVersion.current = sessionsVersion
    void controllerRef.current?.load()
  }, [sessionsVersion])
  // A project view that the Server no longer serves as active (deleted, or
  // archived from another device) falls back to the full list instead of
  // pointing new chats at a project the Server would refuse.
  const projectSelection = useSessionStore((state) => state.projectSelection)
  useEffect(() => {
    if (projectSelection.kind !== 'project') return
    if (projectView.projects.some((row) => row.status === 'active' && row.id === projectSelection.projectId)) return
    useSessionStore.getState().setProjectSelection({ kind: 'all' })
  }, [projectSelection, projectView.projects])
  const controller = controllerRef.current
  const projectController = projectControllerRef.current
  return (
    <aside className="w-[260px] min-w-[260px] h-full flex flex-col border-r border-line bg-white text-gray-700">
      <div className="px-5 py-4 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-card">
          <RocketOutlined className="text-white text-base" />
        </div>
        <span className="text-base font-semibold text-gray-900">iDeer Desktop</span>
        <span className="ml-auto flex items-center gap-1">
          {/* Issue 77: the notification center entry; the badge rides the
              same main-process ledger every later ticket reuses. */}
          <Badge count={unreadNotifications} size="small" overflowCount={99}>
            <Button type="text" size="small" icon={<BellOutlined />} aria-label="打开通知中心"
              title="通知中心" onClick={() => useDockStore.getState().openPanelType('notifications')} />
          </Badge>
          <button onClick={toggleLeftPanel} className="p-1.5 text-gray-400 rounded"
            title="隐藏侧边栏" aria-label="隐藏侧边栏">
            <DoubleLeftOutlined style={{ fontSize: 12 }} />
          </button>
        </span>
      </div>
      <div className="px-5 pb-4 flex-1 min-h-0 flex flex-col">
        <SessionSidebar view={view} projects={projectView} activeThreadId={activeThreadId}
          onOpenThread={requestOpen}
          onSearch={(query) => void controller?.search(query)}
          onLoad={() => void controller?.load()}
          onRename={(threadId, title) => void controller?.rename(threadId, title)}
          onDelete={(threadId) => void controller?.remove(threadId)}
          onMove={(threadId, projectId) => void controller?.move(threadId, projectId)} />
      </div>
      <div className="px-5 py-4 border-t border-line-light text-xs text-gray-500">
        <p className="mb-3">版本 0.1.0</p>
        <Button block icon={<FolderOutlined />} className="mb-2"
          onClick={() => setProjectsOpen(true)}>项目管理</Button>
        <Button block icon={<SettingOutlined />} className="mb-2"
          onClick={() => setSettingsOpen(true)}>设置</Button>
        <Button block onClick={() => void window.ideer.quit()}>退出应用</Button>
      </div>
      <ModelSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {projectController &&
        <ProjectManageModal open={projectsOpen} onClose={() => setProjectsOpen(false)}
          view={projectView} controller={projectController} />}
    </aside>
  )
}

// Issue 91: platform project management, restored to the session sidebar's
// directory. Projects exist only as platform Projects — the list is the
// Server's own post-action reply, follows the account across devices, and no
// second local roster is built. Deleting or archiving a project never touches
// local files or directory grants; the Server clears Thread membership
// itself, and a delete is confirmed twice (here, then in the trusted
// main-process dialog) like a session delete.
// Issue 92: each row also shows the device-local folder binding — the bound
// path with this device's attribution, or 未绑定（原设备绑定不迁移）. Bind
// opens the trusted main process's native folder dialog (the renderer names
// the project only), unbind is local cleanup; both ride the family round.
import { DeleteOutlined, EditOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Popconfirm, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { explainProjectError, type ProjectDirectoryController, type ProjectDirectoryView } from '../../stores/projectDirectory'
import type { ProjectBindingView, ProjectView } from '../../../../shared/desktop'

function ProjectRow({ project, binding, canWrite, canDelete, busy, onRename, onArchive, onRestore, onDelete, onBind, onUnbind }: {
  project: ProjectView
  binding: ProjectBindingView | undefined
  canWrite: boolean
  canDelete: boolean
  busy: boolean
  onRename: (name: string) => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  onBind: () => void
  onUnbind: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const renameReason = canWrite ? '' : '当前账号缺少 projects:write 权限，无法重命名项目'
  if (editing) {
    return <li className="px-2 py-2">
      <Input aria-label={`重命名项目 ${project.name}`} value={draft} maxLength={128} autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onPressEnter={() => { const next = draft.trim(); if (next && next !== project.name) onRename(next); setEditing(false) }}
        suffix={<Typography.Link role="button" aria-label="确认重命名" onClick={() => {
          const next = draft.trim()
          if (next && next !== project.name) onRename(next)
          setEditing(false)
        }}>确定</Typography.Link>} />
    </li>
  }
  return <li className="px-2 py-2 flex items-center gap-1 hover:bg-gray-50">
    <div className="flex-1 min-w-0" title={project.name}>
      <div className="text-sm text-gray-800 truncate">{project.name}</div>
      <div className="text-xs text-gray-500">{project.status === 'archived' ? '已归档' : '进行中'}</div>
      {binding
        ? <div className="text-xs text-gray-500 truncate" title={binding.path}>
            已绑定：{binding.path}（本设备：{binding.deviceName || '本机'}）
          </div>
        : <div className="text-xs text-gray-400">未绑定（原设备绑定不迁移）</div>}
    </div>
    <span className="flex items-center">
      {binding
        ? <Button type="text" size="small" disabled={busy} aria-label={`解除项目文件夹绑定 ${project.name}`}
            title="解除绑定（不删除本机文件，可随时重新绑定）" onClick={onUnbind}>解除绑定</Button>
        : <Button type="text" size="small" icon={<FolderOpenOutlined />} disabled={busy}
            aria-label={`绑定项目文件夹 ${project.name}`} title="绑定本机工作文件夹（按项目+设备记录）"
            onClick={onBind}>绑定文件夹</Button>}
    </span>
    <span className="flex items-center">
      {renameReason
        ? <span title={renameReason}><Button type="text" size="small" icon={<EditOutlined />} disabled
            aria-label={`重命名项目 ${project.name}（不可用：${renameReason}）`} /></span>
        : <Button type="text" size="small" icon={<EditOutlined />} disabled={busy}
            aria-label={`重命名项目 ${project.name}`} title="重命名项目"
            onClick={() => { setDraft(project.name); setEditing(true) }} />}
    </span>
    {project.status === 'active'
      ? <Button type="text" size="small" disabled={busy || !canWrite} aria-label={`归档项目 ${project.name}`}
          title={canWrite ? '归档项目（可随时恢复）' : '当前账号缺少 projects:write 权限，无法归档项目'}
          onClick={onArchive}>归档</Button>
      : <Button type="text" size="small" disabled={busy || !canWrite} aria-label={`恢复项目 ${project.name}`}
          title={canWrite ? '恢复项目' : '当前账号缺少 projects:write 权限，无法恢复项目'}
          onClick={onRestore}>恢复</Button>}
    <Popconfirm title="删除该平台项目？" okText="删除" cancelText="取消"
      description="项目删除后不可恢复；项目内的会话保留并回到散会话。本机文件与目录授权不受影响。"
      onConfirm={onDelete} disabled={busy || !canDelete}>
      <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={busy || !canDelete}
        aria-label={`删除项目 ${project.name}`}
        title={canDelete ? '删除平台项目（本机文件与授权不受影响）' : '当前账号缺少 projects:delete 权限，无法删除项目'} />
    </Popconfirm>
  </li>
}

export function ProjectManageBody({ view, controller }: {
  view: ProjectDirectoryView
  controller: ProjectDirectoryController
}): JSX.Element {
  const [draftName, setDraftName] = useState('')
  const submitCreate = (): void => {
    const next = draftName.trim()
    if (!next || view.busy || !view.permissions.canWrite) return
    setDraftName('')
    void controller.create(next)
  }
  const active = view.projects.filter((row) => row.status === 'active')
  const archived = view.projects.filter((row) => row.status === 'archived')
  const bindingFor = (projectId: string): ProjectBindingView | undefined =>
    view.bindings.find((row) => row.projectId === projectId)
  return <Space direction="vertical" size="middle" className="w-full">
    <Typography.Text type="secondary">
      项目只有一种：平台项目。列表跟账号走、换设备一致；删除或归档项目不会动本机文件与目录授权，项目内的会话由平台收回为散会话。
      文件夹绑定按“项目+设备”记录在本机，可随时补绑或解绑，换设备不迁移。
    </Typography.Text>
    {view.failed && <Alert type="error" showIcon message={explainProjectError(view.error)} />}
    <Input aria-label="新项目名称" placeholder="新项目名称" value={draftName} maxLength={128}
      disabled={view.busy || !view.permissions.canWrite}
      onChange={(event) => setDraftName(event.target.value)}
      onPressEnter={submitCreate}
      suffix={<Button type="text" size="small" icon={<PlusOutlined />} disabled={view.busy || !view.permissions.canWrite || !draftName.trim()}
        aria-label="创建项目" title="创建项目" onClick={submitCreate} />} />
    {!view.projects.length && !view.busy && !view.failed &&
      <Typography.Text type="secondary">还没有平台项目。输入名称创建第一个，或在平台上已有的项目会自动出现在这里。</Typography.Text>}
    {view.permissions.canWrite === false && !view.failed &&
      <Typography.Text type="secondary">当前账号没有 projects:write / projects:delete 权限，仅可查看项目列表。</Typography.Text>}
    <ul className="-mx-2" aria-label="平台项目列表">
      {active.map((row) => <ProjectRow key={row.id} project={row} binding={bindingFor(row.id)}
        canWrite={view.permissions.canWrite}
        canDelete={view.permissions.canDelete} busy={view.busy}
        onRename={(name) => void controller.rename(row.id, name)}
        onArchive={() => void controller.archive(row.id)}
        onRestore={() => void controller.restore(row.id)}
        onDelete={() => void controller.remove(row.id)}
        onBind={() => void controller.bindFolder(row.id)}
        onUnbind={() => void controller.unbindFolder(row.id)} />)}
      {archived.length > 0 && active.length > 0 && <li className="px-2 pt-2"><Typography.Text type="secondary">已归档</Typography.Text></li>}
      {archived.map((row) => <ProjectRow key={row.id} project={row} binding={bindingFor(row.id)}
        canWrite={view.permissions.canWrite}
        canDelete={view.permissions.canDelete} busy={view.busy}
        onRename={(name) => void controller.rename(row.id, name)}
        onArchive={() => void controller.archive(row.id)}
        onRestore={() => void controller.restore(row.id)}
        onDelete={() => void controller.remove(row.id)}
        onBind={() => void controller.bindFolder(row.id)}
        onUnbind={() => void controller.unbindFolder(row.id)} />)}
    </ul>
  </Space>
}

export default function ProjectManageModal({ open, onClose, view, controller }: {
  open: boolean
  onClose: () => void
  view: ProjectDirectoryView
  controller: ProjectDirectoryController
}): JSX.Element {
  useEffect(() => {
    // Re-read the Server's own list whenever the surface opens; the reply is
    // the authoritative roster and nothing local is merged into it.
    if (open) void controller.load()
  }, [open, controller])
  return <Modal title="平台项目" open={open} onCancel={onClose} footer={null} width={560}>
    <ProjectManageBody view={view} controller={controller} />
  </Modal>
}

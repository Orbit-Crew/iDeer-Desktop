// Issue 118: the one-time migration wizard (GLOSSARY 迁移向导). It lists the
// old linz install's workspaces read-only and, per workspace the user
// explicitly confirms here (确认归属), creates one platform project and
// binds one local folder through the trusted main process's dialogs. It is
// never an automatic mover: 旧聊天记录/模型密钥/批准记忆/执行状态一律不迁，
// 旧数据原处保留 — the notice below states it and the Runtime's whitelist
// scan enforces it structurally. After a migration the wizard points at the
// real re-import entries (知识库/表格/技能/模板); an entry that does not
// exist yet (Agent 配置导入) is stated honestly instead of faked (ADR 0001).
import { DatabaseOutlined, FileDoneOutlined, ImportOutlined, ReloadOutlined, TableOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Input, Modal, Space, Switch, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useDockStore } from '../../dock/dockStore'
import type { PanelTypeId } from '../../dock/types'
import { explainMigrationError, type MigrationController, type MigrationWizardView } from '../../stores/migration'
import type { LegacyWorkspaceView, MigrationLedgerView } from '../../../../shared/desktop'

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const evidenceSummary = (workspace: LegacyWorkspaceView): string => {
  const labels = { data: '文档数据', kb: '知识库', tables: '表格库' } as const
  return (Object.keys(labels) as Array<keyof typeof labels>).map((key) => {
    const stat = workspace.files[key]
    return `${labels[key]} ${stat.present ? formatSize(stat.size) : '未见到'}`
  }).join(' · ')
}

function MigrationRow({ workspace, ledgerRow, busy, onMigrate }: {
  workspace: LegacyWorkspaceView
  ledgerRow: MigrationLedgerView | undefined
  busy: boolean
  onMigrate: (name: string, bind: boolean) => void
}): JSX.Element {
  const [confirmed, setConfirmed] = useState(false)
  const [draft, setDraft] = useState(workspace.name || ledgerRow?.projectName || workspace.id)
  const [bind, setBind] = useState(Boolean(workspace.folder || ledgerRow?.folder))
  const migrated = ledgerRow?.status === 'migrated'
  const failed = ledgerRow?.status === 'failed'
  const migratedHint = `已迁移：平台项目「${ledgerRow?.projectName || draft}」${ledgerRow?.folder ? `，本机绑定 ${ledgerRow.folder}` : '，未绑定文件夹'}`
  return <li className="px-2 py-3 border border-line-light rounded-lg">
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-800 truncate">
          {workspace.name || '未命名工作区'}
          {workspace.orphan && <Tag className="ml-2">名册缺失</Tag>}
          {workspace.current && !workspace.orphan && <Tag color="blue" className="ml-2">旧版当前工作区</Tag>}
        </div>
        <div className="text-xs text-gray-500 mt-0.5" aria-label={`旧工作区文件证据 ${workspace.name || workspace.id}`}>
          {evidenceSummary(workspace)}
        </div>
        {workspace.folder && !migrated &&
          <div className="text-xs text-gray-400 truncate" title={workspace.folder}>旧版绑定文件夹：{workspace.folder}</div>}
      </div>
      {migrated
        ? <Tag color="success" aria-label={`迁移完成 ${workspace.name || workspace.id}`}>{migratedHint}</Tag>
        : failed
          ? <Button size="small" type="primary" danger disabled={busy} aria-label={`重试迁移 ${workspace.name || workspace.id}`}
              onClick={() => onMigrate(draft, bind)}>重试迁移</Button>
          : <Button size="small" type="primary" disabled={busy || !confirmed} aria-label={`迁移工作区 ${workspace.name || workspace.id}`}
              title={confirmed ? '在受信任的主进程确认后创建平台项目' : '先勾选“确认归属”才能迁移'}
              onClick={() => onMigrate(draft, bind)}>迁移</Button>}
    </div>
    {failed && ledgerRow &&
      <Alert className="mt-2" type="error" showIcon
        message={explainMigrationError(ledgerRow.errorCode)}
        description={ledgerRow.projectId
          ? `平台项目「${ledgerRow.projectName}」已创建但未能完成绑定；重试只会补做绑定，不会重复创建项目。`
          : '未创建任何平台项目；处理后可重试。'} />}
    {!migrated && !failed &&
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <Checkbox checked={confirmed} disabled={busy} aria-label={`确认归属 ${workspace.name || workspace.id}`}
          onChange={(event) => setConfirmed(event.target.checked)}>
          确认归属：这是我的工作区
        </Checkbox>
        <span className="flex items-center gap-1 text-xs text-gray-500">
          绑定本机文件夹 <Switch size="small" checked={bind} disabled={busy} aria-label={`绑定文件夹开关 ${workspace.name || workspace.id}`}
            onChange={setBind} />
        </span>
        <Input size="small" className="w-48" aria-label={`平台项目名称 ${workspace.name || workspace.id}`}
          value={draft} maxLength={128} disabled={busy}
          onChange={(event) => setDraft(event.target.value)} />
      </div>}
    {!migrated && !failed && confirmed &&
      <div className="text-xs text-gray-400 mt-1">点击「迁移」后，受信任的主进程会再弹一次确认，并可选择要绑定的文件夹。</div>}
  </li>
}

const reImportEntries: Array<{ key: string; icon: JSX.Element; label: string; hint: string; pane?: PanelTypeId; paneLabel?: string }> = [
  { key: 'kb', icon: <FileDoneOutlined />, label: '文档库导入', hint: '原文件重新导入为知识库，并确认账号与范围', pane: 'kb', paneLabel: '打开知识库' },
  { key: 'tables', icon: <TableOutlined />, label: '表格导入', hint: 'XLSX/CSV 在本机 Runtime 面板的「表格数据集」区重新导入', pane: 'runtime', paneLabel: '打开本机 Runtime' },
  { key: 'skills', icon: <ImportOutlined />, label: 'Skill ZIP 导入', hint: '完整技能包在本机 Runtime 面板的「技能包导入」区重新导入并重评环境', pane: 'runtime', paneLabel: '打开本机 Runtime' },
  { key: 'templates', icon: <DatabaseOutlined />, label: '提示词模板', hint: '在模板广场新建或管理；文件级导入导出入口尚未提供', pane: 'templates', paneLabel: '打开模板广场' }
]

export function MigrationWizardBody({ view, controller, onOpenPane }: {
  view: MigrationWizardView
  controller: MigrationController
  onOpenPane?: (id: PanelTypeId) => void
}): JSX.Element {
  const openPane = onOpenPane ?? ((id: PanelTypeId) => useDockStore.getState().openPanelType(id))
  const scan = view.scan
  const ledgerFor = (workspaceId: string): MigrationLedgerView | undefined =>
    view.ledger.find((row) => row.workspaceId === workspaceId)
  return <Space direction="vertical" size="middle" className="w-full">
    <Typography.Text type="secondary">
      这是一次性辅助流程：列出旧版 linz 的工作区，逐个确认归属后创建平台项目（可选绑定本机文件夹），再把文档、表格、技能与模板指路到各重导入入口。不做整体搬运，迁移完成不等于导入完成。
    </Typography.Text>
    <Alert type="warning" showIcon aria-label="永不迁移清单"
      message="只做归属迁移，以下内容一律不迁移"
      description="旧聊天记录、模型密钥、批准记忆与执行状态永不迁移；旧版 linz 的数据原处保留、不做任何修改。扫描只读取工作区名册与文件大小，不打开任何旧数据库。" />
    {view.failed && view.error && <Alert type="error" showIcon message={explainMigrationError(view.error)} />}
    <div className="flex items-center gap-2">
      <Button icon={<ReloadOutlined />} size="small" disabled={view.busy} aria-label="重新扫描旧版工作区"
        onClick={() => void controller.rescan()}>重新扫描</Button>
      {scan && <Typography.Text type="secondary" className="text-xs">扫描位置：{scan.root}</Typography.Text>}
    </div>
    {scan && scan.configError &&
      <Alert type="warning" showIcon message="旧版名册读取失败，以下仅显示磁盘上发现的工作区文件夹" />}
    {scan && scan.workspaces.length === 0 && !view.busy &&
      <Typography.Text type="secondary">
        未发现旧版 linz 工作区。若旧版装在其他位置，本向导不会去猜测路径；确认旧版已安装并至少打开过一次后再试。
      </Typography.Text>}
    {scan && scan.workspaces.length > 0 &&
      <ul className="space-y-2" aria-label="旧版工作区列表">
        {scan.workspaces.map((row) => <MigrationRow key={row.id} workspace={row}
          ledgerRow={ledgerFor(row.id)} busy={view.busy}
          onMigrate={(name, bind) => void controller.migrate(row.id, name, bind, row.folder || undefined)} />)}
      </ul>}
    <div>
      <Typography.Title level={5} className="!mt-0">重导入指路（迁移 ≠ 导入完成）</Typography.Title>
      <ul className="space-y-1.5" aria-label="重导入入口列表">
        {reImportEntries.map((entry) => <li key={entry.key} className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">{entry.icon}</span>
          <span className="w-28 text-gray-700">{entry.label}</span>
          <span className="flex-1 text-xs text-gray-500">{entry.hint}</span>
          {entry.pane && entry.paneLabel &&
            <Button size="small" type="link" aria-label={`${entry.paneLabel}（${entry.label}）`}
              onClick={() => openPane(entry.pane as PanelTypeId)}>{entry.paneLabel}</Button>}
        </li>)}
        <li className="flex items-center gap-2 text-sm">
          <span className="text-gray-500"><ImportOutlined /></span>
          <span className="w-28 text-gray-700">Agent 配置导入</span>
          <span className="flex-1 text-xs text-gray-500">入口尚未提供：桌面暂无 Agent 配置的文件级导入入口，不在此虚设入口</span>
        </li>
      </ul>
    </div>
  </Space>
}

export default function MigrationWizardModal({ open, onClose, view, controller, onOpenPane }: {
  open: boolean
  onClose: () => void
  view: MigrationWizardView
  controller: MigrationController
  onOpenPane?: (id: PanelTypeId) => void
}): JSX.Element {
  useEffect(() => {
    // Opening the wizard is the explicit act that authorizes one read-only
    // scan; nothing reads the legacy install outside this surface.
    if (open) void controller.rescan()
  }, [open, controller])
  return <Modal title="旧版迁移向导" open={open} onCancel={onClose} footer={null} width={640}>
    <MigrationWizardBody view={view} controller={controller} onOpenPane={onOpenPane} />
  </Modal>
}

import { Alert, Button, Card, Select, Space, Typography } from 'antd'
import { useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import type { DatasetCommand, DatasetView, RuntimeStatus } from '../../../shared/desktop'

export interface DatasetSectionProps {
  runtime?: RuntimeStatus
  busy: boolean
  error: string
  /** The import reply's honest outcome line (duplicate / recorded failure). */
  notice: string
  onCommand: (command: DatasetCommand) => void
}

const categoryHints: Record<string, string> = {
  DATASETS_COMMAND_INVALID: '命令不完整或包含不支持的参数，请刷新后重试',
  DATASETS_IDENTITY_CHANGED: '登录身份或目录绑定已变化，请刷新后重试',
  DATASETS_UNAUTHENTICATED: '需要已认证的桌面会话',
  DATASETS_FILE_UNREADABLE: '所选文件不可读，请核对文件是否仍然存在',
  DATASETS_FILE_TOO_LARGE: '文件超过 50MB 的导入上限，已如实记为失败',
  DATASETS_FORMAT_UNSUPPORTED: '仅支持真实解析的 .xlsx 与 .csv；旧版二进制 .xls 不在此范围',
  DATASETS_PARSE_FAILED: '文件损坏或不是可解析的 XLSX/CSV，已如实记为失败',
  DATASETS_NOT_FOUND: '该数据集登记不存在或已被删除',
  DATASETS_STORAGE_UNAVAILABLE: '数据集登记存储不可用，状态显示可能不完整',
  DATASETS_CANCELED: '已取消，本机未改动'
}

/**
 * Issue 102 表格数据集入口：把本机一个 XLSX/CSV 文件在设备侧真实解析为
 * 数据集登记（多工作表、逐列类型识别、内容指纹），关联会话侧当前选中的
 * 平台项目。原件留在本机不上传，登记仅含元数据；重复导入按内容指纹去重，
 * 失败如实记为失败；删除只移除登记记录，不删除原件。文件定位与确认都在
 * 受信任的主进程完成。
 */
export function DatasetSection({ runtime, busy, error, notice, onCommand }: DatasetSectionProps): JSX.Element {
  const projectSelection = useSessionStore((state) => state.projectSelection)
  const projectId = projectSelection.kind === 'project' ? projectSelection.projectId : ''
  const rows: DatasetView[] = runtime?.datasets ?? []
  const hint = categoryHints[error] || '导入未完成：需要已认证会话，且所选文件必须是可解析的 XLSX/CSV'
  // Issue 101: 一套版本规矩 — the import may bind the doc-library revision it
  // accompanies (决策票 62). The binding is optional and explicit; the device
  // records it with the row as a display fact.
  const [revisionBinding, setRevisionBinding] = useState<string>('')
  const revisions = (runtime?.knowledgeImports ?? []).filter(row => row.status === 'registered')
  const chosenBinding = revisions.find(row => row.id === revisionBinding) ?? null
  return <Space direction="vertical" className="w-full">
    <Typography.Paragraph>
      把本机的一个 XLSX/CSV 表格文件导入为真实数据集：设备侧解析全部工作表（CSV 为单表），
      逐列识别类型（数字/布尔/日期时间/文本），并按文件内容指纹去重。数据集登记关联当前选中的
      平台项目，原件留在本机不上传；删除只移除登记记录，不删原件。
    </Typography.Paragraph>
    <Typography.Text type="secondary">
      导入将关联项目：{projectId || '当前未选中平台项目（登记为未关联）'}
    </Typography.Text>
    <Space align="center" className="w-full">
      <Typography.Text type="secondary">绑定知识版本（可选）：</Typography.Text>
      <Select aria-label="绑定知识版本" placeholder="不绑定" className="min-w-64" value={revisionBinding}
        allowClear disabled={busy || !revisions.length}
        onChange={(value) => setRevisionBinding(value ?? '')}
        options={revisions.map(row => ({
          value: row.id, label: `R${row.revisionNo} · ${row.revisionId.slice(0, 8)}…（${row.documentCount} 个文件）` }))} />
    </Space>
    <Button
      type="primary"
      loading={busy}
      disabled={busy || !runtime || runtime.process !== 'running'}
      onClick={() => onCommand({
        action: 'import', projectId,
        ...(chosenBinding ? { revision: { kbId: chosenBinding.kbId, revisionId: chosenBinding.revisionId, revisionNo: chosenBinding.revisionNo } } : {})
      })}
    >导入表格数据集…</Button>
    {notice && <Alert type="info" message={notice} />}
    {error && <Alert type="error" message={hint} />}
    {runtime?.datasetsStorageError && <Alert type="error" message={categoryHints[runtime.datasetsStorageError] ?? '数据集登记存储不可用'} />}
    {!rows.length && <Typography.Text type="secondary">当前账号与设备尚无数据集登记。</Typography.Text>}
    {rows.map(row => <Card key={row.id} size="small">
      <Typography.Paragraph>
        {row.status === 'ready'
          ? `${row.filename}（${row.format === 'xlsx' ? `XLSX · ${row.sheets.length} 个工作表` : 'CSV'}，共 ${row.rowCount} 行）`
          // A failed row may never have recognized a format (format '') —
          // the label states the format only when one was actually known.
          : row.format === 'xlsx' ? `导入失败（XLSX）：${row.errorCode}`
          : row.format === 'csv' ? `导入失败（CSV）：${row.errorCode}`
          : `导入失败：${row.errorCode}`}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        关联项目 {row.projectId || '未关联'} · 设备 {row.deviceId} · {row.createdAt}
        {row.revision && ` · 绑定版本 R${row.revision.revisionNo}（${row.revision.revisionId.slice(0, 8)}…）`}
      </Typography.Paragraph>
      {row.status === 'ready' && row.sheets.map(sheet => <Typography.Paragraph key={`${sheet.name}:${sheet.fingerprint}`} type="secondary">
        工作表「{sheet.name}」：{sheet.rowCount} 行 × {sheet.colCount} 列 · {sheet.schema}
        {sheet.columnsTruncated ? '（列已截断）' : ''}{sheet.truncated ? '（已截断）' : ''}
      </Typography.Paragraph>)}
      {row.status === 'ready' && <Typography.Paragraph copyable className="!mb-2">内容指纹：{row.fileSha256}</Typography.Paragraph>}
      {row.status === 'ready' && <Typography.Paragraph type="secondary">原件：{row.sourcePath}（留在本机，未被移动或上传）</Typography.Paragraph>}
      <Button
        danger
        disabled={busy || !runtime || runtime.process !== 'running'}
        onClick={() => onCommand({ action: 'delete', datasetId: row.id })}
      >删除此登记（保留原件）…</Button>
    </Card>)}
  </Space>
}

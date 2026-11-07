// Doc library pane (issue 96): the dock's `kb` pane wired as the 项目文档库
// 管理页. Records and the one background folder import are the Runtime status
// snapshot's own display facts (1s poll, RuntimePanelController idiom); every
// action rides the trusted desktop:knowledge:* family, whose file picking and
// confirmations stay in the trusted main process. Originals stay local: the
// page only ever shows workspace-logical display facts, never physical paths.
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Empty, Input, Space, Typography } from 'antd'
import type { KnowledgeFolderJobView, KnowledgeImportView } from '../../../../shared/desktop'
import { DocLibraryController, emptyDocLibraryView, explainDocLibraryError, type DocLibraryView } from '../../stores/docLibrary'
import type { PanelTypeId } from '../types'

/** One honest sentence per record: 已完成 with its frozen revision, or 失败
 * with the real fixed category. */
export function describeRecordStatus(record: KnowledgeImportView): string {
  return record.status === 'registered'
    ? `已完成：已登记版本 R${record.revisionNo} · ${record.documentCount} 个文件`
    : `失败：${record.errorCode}`
}

const JOB_STATE: Record<KnowledgeFolderJobView['state'], string> = {
  running: '后台导入进行中', completed: '后台导入已完成', canceled: '后台导入已取消', failed: '后台导入失败'
}

function FolderJobCard({ job, busy, onCancel }: { job: KnowledgeFolderJobView; busy: boolean; onCancel: () => void }): JSX.Element {
  return (
    <Card size="small" className="mt-2" title={JOB_STATE[job.state]} data-testid="doc-library-job">
      <Typography.Paragraph>
        已处理 {job.processedFiles} / {job.totalFiles} 个文件{job.state === 'running' ? ' · 导入在后台进行，可随时取消' : ''}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        已登记 {job.registeredBatches} 批 / {job.registeredDocuments} 个文件
        {job.failedBatches > 0 ? ` · 失败 ${job.failedBatches} 批` : ''}
        {job.skippedUnsupported > 0 ? ` · 跳过不支持类型 ${job.skippedUnsupported} 个` : ''}
        {job.skippedLinks > 0 ? ` · 跳过链接 ${job.skippedLinks} 个` : ''}
      </Typography.Paragraph>
      {/* 重复文件按内容指纹自动去重并提示：the dedup counts are the prompt. */}
      {job.skippedDuplicates > 0 && <Typography.Paragraph>
        按内容指纹去重：跳过 {job.skippedDuplicates} 个重复文件（与已导入或本批已见内容相同）
      </Typography.Paragraph>}
      {job.truncated && <Alert type="warning" showIcon
        message="已达到单次导入的文件数上限，超出部分未导入；可分批选择子文件夹继续导入。" />}
      {job.failures.map((failure, index) => (
        <Typography.Paragraph key={`${failure.filename}-${index}`} type="secondary">
          {failure.filename}：{failure.errorCode}
        </Typography.Paragraph>
      ))}
      {job.state === 'failed' && <Alert type="error" showIcon message={`导入失败：${job.error}`} />}
      {job.state === 'running' && <Button loading={busy} onClick={onCancel}>取消后台导入</Button>}
    </Card>
  )
}

export default function DocLibraryPane({ instanceId, panelType }: {
  instanceId: string
  panelType: PanelTypeId
}): JSX.Element {
  // instanceId 保持未用：窗格状态在控制器里，签名与面板注册表保持一致。
  void panelType
  const [view, setView] = useState(emptyDocLibraryView)
  const [kbId, setKbId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const controller = useRef<DocLibraryController | null>(null)
  useEffect(() => {
    let active = true
    const current = new DocLibraryController(window.ideer, next => { if (active) setView(next) })
    controller.current = current
    void current.refresh()
    const timer = setInterval(() => void current.refresh(), 1000)
    return () => { active = false; current.invalidate(); clearInterval(timer) }
  }, [])
  const runtime = view.runtime
  const ready = !!runtime && runtime.process === 'running' &&
    runtime.login?.state === 'authenticated' && runtime.workspace?.state === 'ready'
  const records = runtime?.knowledgeImports ?? []
  const job = runtime?.knowledgeFolderImport ?? null
  const selectedRows = records.filter(record => selected.includes(record.id))
  const selectedFailed = selectedRows.filter(record => record.status === 'failed')
  const toggle = (recordId: string, checked: boolean): void =>
    setSelected(current => checked ? [...current, recordId] : current.filter(id => id !== recordId))
  const run = (action: () => Promise<void>, after?: () => void): void => {
    void action().then(after).catch(() => {})
  }
  return (
    <div className="h-full w-full overflow-auto p-4" style={{ background: 'var(--pane-bg, #F4F6FA)' }} data-testid="doc-library-pane">
      <Typography.Title level={5}>文档库管理</Typography.Title>
      <Typography.Paragraph>
        把工作目录中的文件夹递归导入为当前账号的平台知识库版本：设备侧按内容指纹自动去重并提示，
        导入在后台进行、可随时取消，失败的文件如实标注原因。目录登记在平台项目下可见，原件与本机索引不上传。
      </Typography.Paragraph>
      <Space className="w-full mb-2" align="center">
        <Input aria-label="平台知识库 UUID" placeholder="平台知识库 UUID（资源页可创建并复制）" value={kbId} maxLength={36}
          onChange={(event) => setKbId(event.target.value)} className="max-w-md" disabled={view.busy} />
        <Button type="primary" aria-label="选择文件夹并导入" loading={view.busy}
          disabled={!ready || !kbId || view.busy}
          onClick={() => run(() => controller.current!.startFolderImport(kbId))}>选择文件夹并导入</Button>
      </Space>
      {!ready && <Typography.Paragraph type="secondary">
        {runtime?.process !== 'running' ? '本机 Runtime 未运行，导入与批量操作不可用' : '需要已登录平台账号与已确认的工作目录'}
      </Typography.Paragraph>}
      {view.error && <Alert type="error" showIcon className="mb-2" message={explainDocLibraryError(view.error)} />}
      {runtime?.knowledgeImportStorageError && <Alert type="error" showIcon className="mb-2"
        message="导入记录存储不可用，状态显示可能不完整" />}
      {job && <FolderJobCard job={job} busy={view.busy}
        onCancel={() => run(() => controller.current!.cancelFolderImport())} />}
      <Typography.Title level={5} className="mt-5">导入记录</Typography.Title>
      <Typography.Paragraph type="secondary">
        此处最多显示最近 20 条记录；删除仅移除本机导入记录（显示事实），不影响平台知识库与已登记版本。
      </Typography.Paragraph>
      <Space className="mb-2">
        <Button danger aria-label="删除所选记录" loading={view.busy}
          disabled={!selected.length || view.busy}
          onClick={() => run(() => controller.current!.deleteRecords(selected), () => setSelected([]))}>删除所选记录</Button>
        <Button aria-label="重试所选失败记录" loading={view.busy}
          disabled={!selectedFailed.length || view.busy}
          onClick={() => {
            // One retry per command (each is one ordinary import round-trip);
            // the renderer runs a multi-selection sequentially and every
            // failure is aggregated, none erased by the next attempt.
            void controller.current!.retryRecords(selectedFailed.map(record => record.id))
          }}>重试所选失败记录</Button>
      </Space>
      {!records.length && <Empty description={view.failed ? '无法读取 Runtime 状态' : '当前账号与设备尚无导入记录'} />}
      <ul role="list" aria-label="导入记录列表" className="list-none p-0">
        {records.map(record => <li key={record.id}>
          <Card size="small" className="mb-2">
            <Space align="start">
              <Checkbox aria-label={`选择导入记录 ${record.id}`} disabled={view.busy}
                checked={selected.includes(record.id)}
                onChange={(event) => toggle(record.id, event.target.checked)} />
              <div>
                <Typography.Paragraph className="mb-1">{describeRecordStatus(record)}</Typography.Paragraph>
                <Typography.Paragraph type="secondary" className="mb-1">
                  平台项目 {record.projectId || '—'} · 知识库 {record.kbId}
                  {record.status === 'registered' ? ` · 版本 ${record.revisionId.slice(0, 8)}…（R${record.revisionNo}）` : ''}
                  {record.source ? ` · 来源文件夹 ${record.source.folder}（${record.source.pathCount} 个文件）` : ''}
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary" className="mb-0">
                  {record.createdAt} · {record.documents.map(document => document.filename).join('、')}
                </Typography.Paragraph>
              </div>
            </Space>
          </Card>
        </li>)}
      </ul>
    </div>
  )
}

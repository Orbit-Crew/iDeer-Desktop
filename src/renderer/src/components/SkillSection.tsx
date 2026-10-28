import { Alert, Button, Card, Space, Typography } from 'antd'
import type { RuntimeStatus, SkillCommand, SkillImportView } from '../../../shared/desktop'

const originNames: Record<string, string> = { markdown: 'Markdown', zip: 'ZIP', directory: '目录' }
const statusNames: Record<SkillImportView['status'], string> = {
  imported: '已导入为私有草稿',
  published: '已发布版本副本',
  failed: '失败'
}

export interface SkillSectionProps {
  runtime?: RuntimeStatus
  busy: boolean
  error: string
  onCommand: (command: SkillCommand) => void
}

/**
 * Issue 120 Skill 入口：把本机的一个 Markdown、ZIP 或目录技能包显式导入为
 * 本人私有的平台技能草稿。设备侧预览展示正文、脚本与引用的完整上传范围，
 * 取消则什么都不上传；确认后按包指纹绑定上传为私有草稿，发布走平台既有的
 * 草稿校验与发布流程取得版本副本。内置技能只读，任何修改都产生新的草稿或
 * 版本；本地草稿不会成为独立可执行渠道，执行始终由平台编排。
 */
export function SkillSection({ runtime, busy, error, onCommand }: SkillSectionProps): JSX.Element {
  const rows = runtime?.skillImports ?? []
  const publish = (row: SkillImportView) =>
    onCommand({ action: 'publish', resourceId: row.resourceId, expectedDraftRevision: row.revision })
  return <Card className="max-w-3xl mt-2" size="small" title="技能包导入">
    <Typography.Paragraph>
      选择一个 Markdown、ZIP 或目录技能包：先在设备侧预览正文、脚本、引用与指纹，确认后才上传为你的私有平台技能草稿；发布版本需再次确认，走平台既有的草稿校验与发布流程。取消或未确认的包不会上传，本地草稿也不会在设备上执行。
    </Typography.Paragraph>
    <Space className="mb-2">
      <Button aria-label="导入Markdown技能" disabled={busy}
        onClick={() => onCommand({ action: 'import', kind: 'markdown' })}>导入 Markdown 技能…</Button>
      <Button aria-label="导入ZIP技能" disabled={busy}
        onClick={() => onCommand({ action: 'import', kind: 'zip' })}>导入 ZIP 技能…</Button>
      <Button aria-label="导入目录技能" disabled={busy}
        onClick={() => onCommand({ action: 'import', kind: 'directory' })}>导入目录技能…</Button>
    </Space>
    {error && <Alert type="error" message={`技能导入未完成：${error}`} />}
    {runtime?.skillImportStorageError && <Alert type="error" message="技能导入记录存储不可用，状态显示可能不完整" />}
    {!rows.length && <Typography.Text type="secondary">当前账号与设备尚无技能导入记录。</Typography.Text>}
    {rows.map(row => <Card key={row.id} size="small" className="mt-2">
      <Typography.Paragraph>
        {row.status === 'failed' ? `导入失败：${row.errorCode}` : `${row.slug || row.resourceId} · ${statusNames[row.status]}`}
        {row.status !== 'failed' && ` · ${row.fileCount} 个文件（${originNames[row.origin] || row.origin}）`}
      </Typography.Paragraph>
      {row.status === 'published' && <Typography.Paragraph>
        平台版本副本：V{row.version} · <Typography.Text copyable>指纹 {row.contentHash}</Typography.Text>
      </Typography.Paragraph>}
      {row.status === 'imported' && <Typography.Paragraph>
        私有草稿 R{row.revision} · <Typography.Text copyable>包指纹 {row.contentHash}</Typography.Text>
      </Typography.Paragraph>}
      <Typography.Paragraph type="secondary">账号绑定 · {row.createdAt}</Typography.Paragraph>
      {row.status === 'imported' && <Button
        aria-label={`发布技能 ${row.slug || row.resourceId}`}
        disabled={busy}
        onClick={() => publish(row)}>发布此草稿为版本副本…</Button>}
      {row.status === 'failed' && <Typography.Paragraph type="secondary">失败后可重新导入；未上传的内容不会保留在平台上。</Typography.Paragraph>}
    </Card>)}
  </Card>
}

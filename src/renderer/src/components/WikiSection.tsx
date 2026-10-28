import { Alert, Button, Card, Space, Typography } from 'antd'
import type { RuntimeStatus, WikiCommand, WikiPage, WikiView } from '../../../shared/desktop'

const statusNames: Record<WikiView['status'], string> = {
  not_generated: '尚未生成',
  completed: '生成完成',
  partial: '部分完成',
  failed: '生成失败'
}

const pageStatusName = (row: { status: string; errorCode: string }): string =>
  row.status === 'completed' ? '可阅读' : row.status === 'skipped' ? `已跳过：${row.errorCode}` : row.status === 'failed' ? `失败：${row.errorCode}` : row.status === 'not_generated' ? '未生成' : row.status

export interface WikiSectionProps {
  runtime?: RuntimeStatus
  wiki: WikiView | null
  page: WikiPage | null
  busy: boolean
  error: string
  onCommand: (command: WikiCommand) => void
}

/**
 * Issue 118 Wiki 入口：当前账号已登记的版本可以查看页面列表、正文、进度
 * 与来源。页面由 Server 统一编排生成并始终绑定冻结的 KB/Revision 与文档
 * 指纹；进度、跳过和部分失败如实展示，跨账号或其他范围的版本不会出现在
 * 这里，越界的页面读取由 Server 拒绝。
 */
export function WikiSection({ runtime, wiki, page, busy, error, onCommand }: WikiSectionProps): JSX.Element {
  const registered = (runtime?.knowledgeImports ?? []).filter(row => row.status === 'registered')
  return <Card className="max-w-3xl mt-2" size="small" title="知识 Wiki">
    <Typography.Paragraph>针对已登记的知识库版本，由平台统一编排生成 Wiki 页面；页面与来源始终绑定冻结版本与文档指纹，进度、跳过和部分失败如实展示。跨账号或其他范围的版本不会显示。</Typography.Paragraph>
    {error && <Alert type="error" message={`Wiki 操作未完成：${error}`} />}
    {!registered.length && <Typography.Text type="secondary">当前账号与设备尚无可查看 Wiki 的已登记版本。</Typography.Text>}
    {registered.map(row => <Space key={row.id} className="mt-2">
      <Typography.Text>R{row.revisionNo} · {row.kbId}</Typography.Text>
      <Button aria-label={`查看Wiki R${row.revisionNo}`} disabled={busy}
        onClick={() => onCommand({ action: 'view', kbId: row.kbId, revisionId: row.revisionId })}>查看Wiki</Button>
      <Button aria-label={`生成Wiki R${row.revisionNo}`} disabled={busy}
        onClick={() => onCommand({ action: 'generate', kbId: row.kbId, revisionId: row.revisionId })}>生成Wiki</Button>
    </Space>)}
    {wiki && <>
      <Typography.Paragraph className="mt-3">
        版本 R{wiki.revisionNo} · {statusNames[wiki.status]} · 成功 {wiki.generated} · 失败 {wiki.failed} · 跳过 {wiki.skipped}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" copyable>清单指纹：{wiki.manifestHash}</Typography.Paragraph>
      {wiki.status === 'partial' && <Alert type="warning" message="部分页面未生成：缺失的页面不代表完整 Wiki" />}
      <Typography.Title level={5} className="mt-3">页面列表</Typography.Title>
      {!wiki.pages.length && <Typography.Text type="secondary">尚未生成任何页面。</Typography.Text>}
      {wiki.pages.map(row => <Card key={row.documentId} size="small" className="mt-2">
        <Typography.Paragraph>
          {row.title || row.filename} · {pageStatusName(row)}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" copyable>来源 {row.filename} · 文档指纹：{row.contentHash}</Typography.Paragraph>
        {row.status === 'completed' && <Button aria-label={`阅读页面 ${row.filename}`} disabled={busy}
          onClick={() => onCommand({ action: 'read', kbId: wiki.kbId, revisionId: wiki.revisionId, documentId: row.documentId })}>阅读此页</Button>}
      </Card>)}
      {page && page.revisionId === wiki.revisionId && <>
        <Typography.Title level={5} className="mt-3">页面正文</Typography.Title>
        {page.status === 'completed'
          ? <Card size="small">
            <Typography.Title level={5}>{page.title || page.filename}</Typography.Title>
            <Typography.Paragraph type="secondary">来源 {page.filename} · 指纹 {page.contentHash.slice(0, 12)}…</Typography.Paragraph>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{page.body}</Typography.Paragraph>
          </Card>
          : <Alert type="warning" message={`此页不可阅读：${pageStatusName(page)}`} />}
      </>}
    </>}
  </Card>
}

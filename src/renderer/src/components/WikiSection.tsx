import { Alert, Button, Card, Space, Typography } from 'antd'
import type { RuntimeStatus, WikiCommand, WikiLink, WikiNavigation, WikiPage, WikiPageSummary, WikiView } from '../../../shared/desktop'

const statusNames: Record<WikiView['status'], string> = {
  not_generated: '尚未生成',
  completed: '生成完成',
  partial: '部分完成',
  failed: '生成失败'
}

const pageStatusName = (row: { status: string; errorCode: string }): string =>
  row.status === 'completed' ? '可阅读' : row.status === 'skipped' ? `已跳过：${row.errorCode}` : row.status === 'failed' ? `失败：${row.errorCode}` : row.status === 'not_generated' ? '未生成' : row.status

/** A link row carries no error code; its status names the target honestly. */
const linkStatusName = (status: WikiPageSummary['status']): string =>
  status === 'completed' ? '可阅读' : status === 'skipped' ? '已跳过' : status === 'failed' ? '生成失败' : '未生成'

export interface WikiSectionProps {
  runtime?: RuntimeStatus
  wiki: WikiView | null
  navigation: WikiNavigation | null
  page: WikiPage | null
  busy: boolean
  error: string
  onCommand: (command: WikiCommand) => void
}

/**
 * Issue 118/119 Wiki 入口：当前账号已登记的版本可以查看页面列表、正文、进度
 * 与来源，也可以打开导航索引：由 Server 从同一冻结版本自身的产物确定性推导
 * 页面链接、反链与关联图。链接只解析到本版本内的文档，缺失目标如实标注为
 * 不可访问，跳过和失败的目标只显示状态；点击可读的链接或反链即阅读该页，
 * 回到相应来源。页面与来源始终绑定冻结的 KB/Revision 与文档指纹；跨账号或
 * 其他范围的版本不会出现在这里，越界的页面读取由 Server 拒绝。
 */
export function WikiSection({ runtime, wiki, navigation, page, busy, error, onCommand }: WikiSectionProps): JSX.Element {
  const registered = (runtime?.knowledgeImports ?? []).filter(row => row.status === 'registered')
  const readPage = (kbId: string, revisionId: string, documentId: string) =>
    onCommand({ action: 'read', kbId, revisionId, documentId })
  const linkRow = (link: WikiLink, label: string, kbId: string, revisionId: string): JSX.Element =>
    link.status === 'completed'
      ? <Button key={link.documentId} className="ml-1" size="small" disabled={busy} aria-label={`${label} ${link.title || link.documentId}`}
          onClick={() => readPage(kbId, revisionId, link.documentId)}>{link.title || link.documentId}（可阅读）</Button>
      : <Typography.Text key={link.documentId} type="secondary" className="ml-1">{link.title || link.documentId}（{linkStatusName(link.status)}）</Typography.Text>
  return <Card className="max-w-3xl mt-2" size="small" title="知识 Wiki">
    <Typography.Paragraph>针对已登记的知识库版本，由平台统一编排生成 Wiki 页面；页面与来源始终绑定冻结版本与文档指纹，进度、跳过和部分失败如实展示。导航索引、链接反链与关联图均由该冻结版本自身的产物推导，缺失目标如实标注，不会伪造可访问页面。跨账号或其他范围的版本不会显示。</Typography.Paragraph>
    {error && <Alert type="error" message={`Wiki 操作未完成：${error}`} />}
    {!registered.length && <Typography.Text type="secondary">当前账号与设备尚无可查看 Wiki 的已登记版本。</Typography.Text>}
    {registered.map(row => <Space key={row.id} className="mt-2">
      <Typography.Text>R{row.revisionNo} · {row.kbId}</Typography.Text>
      <Button aria-label={`查看Wiki R${row.revisionNo}`} disabled={busy}
        onClick={() => onCommand({ action: 'view', kbId: row.kbId, revisionId: row.revisionId })}>查看Wiki</Button>
      <Button aria-label={`生成Wiki R${row.revisionNo}`} disabled={busy}
        onClick={() => onCommand({ action: 'generate', kbId: row.kbId, revisionId: row.revisionId })}>生成Wiki</Button>
      <Button aria-label={`导航Wiki R${row.revisionNo}`} disabled={busy}
        onClick={() => onCommand({ action: 'navigate', kbId: row.kbId, revisionId: row.revisionId })}>导航索引</Button>
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
          onClick={() => readPage(wiki.kbId, wiki.revisionId, row.documentId)}>阅读此页</Button>}
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
    {navigation && <>
      <Typography.Paragraph className="mt-3">
        版本 R{navigation.revisionNo} · 导航索引 · {statusNames[navigation.status]} · 成功 {navigation.generated} · 失败 {navigation.failed} · 跳过 {navigation.skipped}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" copyable>清单指纹：{navigation.manifestHash}</Typography.Paragraph>
      {navigation.status === 'partial' && <Alert type="warning" message="部分页面未生成：缺失的页面不代表完整 Wiki" />}
      <Typography.Title level={5} className="mt-3">关联图</Typography.Title>
      <Typography.Paragraph>
        {statusNames[navigation.associations.status]} · 生成 {navigation.associations.generated} · 失败 {navigation.associations.failed} · 实体 {navigation.associations.entities.length} · 关系 {navigation.associations.relations.length}
      </Typography.Paragraph>
      {navigation.associations.sources.map(row => <Typography.Paragraph key={row.documentId} type="secondary">
        来源 {row.filename} · {pageStatusName(row)} · 文档指纹：{row.contentHash}
      </Typography.Paragraph>)}
      <Typography.Title level={5} className="mt-3">页面索引</Typography.Title>
      {!navigation.pages.length && <Typography.Text type="secondary">尚未生成任何页面。</Typography.Text>}
      {navigation.pages.map(row => <Card key={row.documentId} size="small" className="mt-2">
        <Typography.Paragraph>{row.title || row.filename} · {pageStatusName(row)}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">来源 {row.filename} · 文档指纹：{row.contentHash}</Typography.Paragraph>
        {row.status === 'completed' && <Button aria-label={`阅读页面 ${row.filename}`} disabled={busy}
          onClick={() => readPage(navigation.kbId, navigation.revisionId, row.documentId)}>阅读此页</Button>}
        {!!row.links.length && <Typography.Paragraph className="mt-2">
          链接：{row.links.map(link => linkRow(link, '前往', navigation.kbId, navigation.revisionId))}
        </Typography.Paragraph>}
        {!!row.missingLinks.length && <Typography.Paragraph type="warning" className="mt-2">
          缺失目标：{row.missingLinks.join('、')}（未在此冻结版本中登记或生成，不可访问）
        </Typography.Paragraph>}
        {!!row.backlinks.length && <Typography.Paragraph className="mt-2">
          反链：{row.backlinks.map(link => linkRow(link, '返回', navigation.kbId, navigation.revisionId))}
        </Typography.Paragraph>}
      </Card>)}
      {page && page.revisionId === navigation.revisionId && <>
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

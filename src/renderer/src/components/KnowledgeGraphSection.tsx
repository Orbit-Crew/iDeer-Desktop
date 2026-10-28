import { Alert, Button, Card, Space, Typography } from 'antd'
import type { KnowledgeGraphCommand, KnowledgeGraphSourceLocation, KnowledgeGraphView, KnowledgeImportView, RuntimeStatus } from '../../../shared/desktop'

const statusNames: Record<KnowledgeGraphView['status'], string> = {
  not_generated: '尚未生成',
  completed: '生成完成',
  partial: '部分完成',
  failed: '生成失败'
}

export interface KnowledgeGraphSectionProps {
  runtime?: RuntimeStatus
  graph: KnowledgeGraphView | null
  located: Record<string, KnowledgeGraphSourceLocation>
  busy: boolean
  error: string
  onCommand: (command: KnowledgeGraphCommand) => void
}

/**
 * Issue 116 图谱入口：当前账号已登记的版本可以查看实体、关系与来源，
 * 并把来源定位回本机工作区。数据始终绑定冻结的 KB/Revision，
 * 跨账号或其他范围的版本不会出现在这里。
 */
export function KnowledgeGraphSection({ runtime, graph, located, busy, error, onCommand }: KnowledgeGraphSectionProps): JSX.Element {
  const registered = (runtime?.knowledgeImports ?? []).filter(row => row.status === 'registered')
  return <Card className="max-w-3xl mt-2" size="small" title="知识图谱">
    <Typography.Paragraph>针对已登记的知识库版本，由平台统一编排生成实体与关系；来源始终绑定冻结版本与文档指纹，可定位回本机授权来源。跨账号或其他范围的版本不会显示。</Typography.Paragraph>
    {error && <Alert type="error" message={`图谱操作未完成：${error}`} />}
    {!registered.length && <Typography.Text type="secondary">当前账号与设备尚无可查看图谱的已登记版本。</Typography.Text>}
    {registered.map(row => <Space key={row.id} className="mt-2">
      <Typography.Text>R{row.revisionNo} · {row.kbId}</Typography.Text>
      <Button aria-label={`查看图谱 R${row.revisionNo}`} disabled={busy}
        onClick={() => onCommand({ action: 'view', kbId: row.kbId, revisionId: row.revisionId })}>查看图谱</Button>
      <Button aria-label={`生成图谱 R${row.revisionNo}`} disabled={busy}
        onClick={() => onCommand({ action: 'generate', kbId: row.kbId, revisionId: row.revisionId })}>生成图谱</Button>
    </Space>)}
    {graph && <>
      <Typography.Paragraph className="mt-3">
        版本 R{graph.revisionNo} · {statusNames[graph.status]} · 成功 {graph.generated} · 失败 {graph.failed}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" copyable>清单指纹：{graph.manifestHash}</Typography.Paragraph>
      {graph.status === 'partial' && <Alert type="warning" message="部分文档生成失败：缺失的关系不代表完整图谱" />}
      <Typography.Title level={5} className="mt-3">关系</Typography.Title>
      {!graph.relations.length && <Typography.Text type="secondary">暂无已生成关系。</Typography.Text>}
      {graph.relations.map((relation, index) => <Typography.Paragraph key={`${relation.documentId}-${index}`}>
        {relation.source} —[{relation.relation}]→ {relation.target}
        <Typography.Text type="secondary"> · 来源：{relation.filename}</Typography.Text>
      </Typography.Paragraph>)}
      <Typography.Title level={5} className="mt-3">实体</Typography.Title>
      {!graph.entities.length && <Typography.Text type="secondary">暂无已生成实体。</Typography.Text>}
      {graph.entities.map((entity, index) => <Typography.Paragraph key={`${entity.documentId}-${index}`}>
        {entity.name}（{entity.type || '未分类'}）
        <Typography.Text type="secondary"> · 来源：{entity.filename}</Typography.Text>
      </Typography.Paragraph>)}
      <Typography.Title level={5} className="mt-3">来源</Typography.Title>
      {graph.sources.map(source => <Card key={source.documentId} size="small" className="mt-2">
        <Typography.Paragraph>
          {source.filename} · {source.status === 'completed' ? '已生成' : source.status === 'failed' ? `失败：${source.errorCode}` : '未生成'}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" copyable>文档指纹：{source.contentHash}</Typography.Paragraph>
        {located[source.documentId] && (located[source.documentId].logicalPath
          ? <Typography.Paragraph>本机位置：{located[source.documentId].logicalPath}</Typography.Paragraph>
          : <Alert type="warning" message={`来源暂不可定位：${located[source.documentId].reason || 'document_unavailable'}`} />)}
        <Button aria-label={`定位来源 ${source.filename}`} disabled={busy}
          onClick={() => onCommand({ action: 'locate', kbId: graph.kbId, revisionId: graph.revisionId, documentId: source.documentId })}>定位本机来源</Button>
      </Card>)}
    </>}
  </Card>
}

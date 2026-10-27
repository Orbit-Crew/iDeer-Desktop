import { Alert, Button, Card, Checkbox, Input, Space, Typography } from 'antd'
import { useState } from 'react'
import type { KnowledgeGraphAskResult, KnowledgeGraphCommand, KnowledgeGraphQueryResult, KnowledgeGraphSourceLocation, KnowledgeGraphView, KnowledgeImportView, RuntimeStatus } from '../../../shared/desktop'

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
  queryResult: KnowledgeGraphQueryResult | null
  askResult: KnowledgeGraphAskResult | null
  selection: Record<string, boolean>
  busy: boolean
  error: string
  onSelection: (documentId: string, checked: boolean) => void
  onCommand: (command: KnowledgeGraphCommand) => void
}

/**
 * Issue 117: the selected frozen-document scope — every source stays
 * selected unless explicitly unchecked, so narrowing can only shrink the
 * Server-visible scope and never silently widens it.
 */
export function selectedScope(sources: KnowledgeGraphView['sources'], selection: Record<string, boolean>): string[] {
  return sources.filter((source) => selection[source.documentId] !== false).map((source) => source.documentId)
}

/**
 * Issue 116 图谱入口：当前账号已登记的版本可以查看实体、关系与来源，
 * 并把来源定位回本机工作区。数据始终绑定冻结的 KB/Revision，
 * 跨账号或其他范围的版本不会出现在这里。
 * Issue 117 范围问答：在所选文档内检索实体/关系或提问，答案与检索结果
 * 均由 Server 编排并携带可核对的文档来源；资料缺失或部分失败时明确展示
 * 失败类别，不生成没有依据的结论。
 */
export function KnowledgeGraphSection({ runtime, graph, located, queryResult, askResult, selection, busy, error, onSelection, onCommand }: KnowledgeGraphSectionProps): JSX.Element {
  const registered = (runtime?.knowledgeImports ?? []).filter(row => row.status === 'registered')
  const [searchText, setSearchText] = useState('')
  const [question, setQuestion] = useState('')
  const scope = graph ? selectedScope(graph.sources, selection) : []
  const scopeNames = graph ? graph.sources.filter((source) => scope.includes(source.documentId)).map((source) => source.filename) : []
  const scopedCommand = (action: 'search' | 'ask', query: string): KnowledgeGraphCommand | null =>
    graph && query.trim() && scope.length ? { action, kbId: graph.kbId, revisionId: graph.revisionId, documentIds: scope, query: query.trim() } : null
  const runScoped = (command: KnowledgeGraphCommand | null) => {
    if (command) onCommand(command)
  }
  const scopeStatusName = (row: { status: string; errorCode: string }): string =>
    row.status === 'completed' ? '已读' : row.status === 'failed' ? `失败：${row.errorCode}` : row.status === 'not_generated' ? '未生成' : row.status
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
      <Typography.Title level={5} className="mt-3">问答范围</Typography.Title>
      <Typography.Paragraph type="secondary">检索与提问只作用于勾选的文档；范围随勾选实时缩小或扩大，提交给平台的始终是这份明确的文档清单。</Typography.Paragraph>
      {graph.sources.map(source => <Checkbox key={source.documentId} aria-label={`选择范围 ${source.filename}`}
        checked={selection[source.documentId] !== false}
        disabled={busy}
        onChange={(event) => onSelection(source.documentId, event.target.checked)}>
        {source.filename}
      </Checkbox>)}
      <Typography.Paragraph className="mt-2">当前范围：{scope.length ? `${scope.length} 个文档（${scopeNames.join('、')}）` : '未选文档'}</Typography.Paragraph>
      <Space.Compact className="w-full max-w-xl">
        <Input aria-label="检索实体与关系" placeholder="在所选文档中检索实体或关系" value={searchText} maxLength={512}
          disabled={busy} onChange={(event) => setSearchText(event.target.value)} />
        <Button aria-label="在所选文档中检索" disabled={busy || !searchText.trim() || !scope.length}
          onClick={() => runScoped(scopedCommand('search', searchText))}>检索</Button>
      </Space.Compact>
      <Input.TextArea aria-label="范围问答" placeholder="只依据所选文档提问" value={question} maxLength={4000}
        autoSize={{ minRows: 2, maxRows: 6 }} disabled={busy} className="mt-2 max-w-xl"
        onChange={(event) => setQuestion(event.target.value)} />
      <Button aria-label="在所选文档中提问" className="mt-2" disabled={busy || !question.trim() || !scope.length}
        onClick={() => runScoped(scopedCommand('ask', question))}>范围问答</Button>
      {queryResult && <>
        <Typography.Title level={5} className="mt-3">检索结果</Typography.Title>
        <Typography.Paragraph type="secondary">
          版本 R{queryResult.revisionNo} · {statusNames[queryResult.status]} · 范围 {queryResult.scope.length} 个文档
          {queryResult.query ? ` · 关键词“${queryResult.query}”` : ''}
        </Typography.Paragraph>
        {!queryResult.entities.length && !queryResult.relations.length && <Typography.Text type="secondary">所选范围内没有匹配的实体或关系。</Typography.Text>}
        {queryResult.relations.map((relation, index) => <Typography.Paragraph key={`r-${relation.documentId}-${index}`}>
          {relation.source} —[{relation.relation}]→ {relation.target}
          <Typography.Text type="secondary"> · 来源：{relation.filename} · 指纹 {relation.contentHash.slice(0, 12)}…</Typography.Text>
        </Typography.Paragraph>)}
        {queryResult.entities.map((entity, index) => <Typography.Paragraph key={`e-${entity.documentId}-${index}`}>
          {entity.name}（{entity.type || '未分类'}）
          <Typography.Text type="secondary"> · 来源：{entity.filename} · 指纹 {entity.contentHash.slice(0, 12)}…</Typography.Text>
        </Typography.Paragraph>)}
      </>}
      {askResult && <>
        <Typography.Title level={5} className="mt-3">范围问答</Typography.Title>
        <Typography.Paragraph type="secondary">
          版本 R{askResult.revisionNo} · 范围 {askResult.scope.length} 个文档 · 提问：{askResult.question}
        </Typography.Paragraph>
        {askResult.answerAvailable
          ? <Card size="small"><Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{askResult.answer}</Typography.Paragraph></Card>
          : <Alert type="warning" message="未能给出有依据的回答：所选资料不完整或服务未完成" />}
        {askResult.scope.map(row => <Typography.Paragraph key={row.documentId} className="mt-1">
          来源 {row.filename} · {scopeStatusName(row)}
          {row.contentHash && <Typography.Text type="secondary"> · 指纹 {row.contentHash.slice(0, 12)}…</Typography.Text>}
        </Typography.Paragraph>)}
        {!askResult.answerAvailable && !!askResult.errorCode && <Typography.Text type="warning">失败类别：{askResult.errorCode}</Typography.Text>}
      </>}
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

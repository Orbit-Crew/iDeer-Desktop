import { Segmented, Typography } from 'antd'
import { ApartmentOutlined, NodeIndexOutlined } from '@ant-design/icons'
import { useState } from 'react'
import type { WikiNavigation } from '../../../shared/desktop'
import { WikiGraphCanvas } from './WikiGraphCanvas'
import { buildWikiGraph, wikiSourceLine, type WikiGraphMode } from './wikiGraphModel'

const statusNames: Record<string, string> = {
  completed: '可阅读',
  skipped: '已跳过',
  failed: '生成失败',
  not_generated: '未生成'
}

const LEGEND: Array<[string, string]> = [
  ['completed', '可阅读'],
  ['skipped', '已跳过'],
  ['failed', '生成失败'],
  ['not_generated', '未生成']
]

const STATUS_DOT: Record<string, string> = {
  completed: '#1E6FCC',
  skipped: '#FA8C16',
  failed: '#CF1322',
  not_generated: '#8C8C8C'
}

export interface WikiGraphPanelProps {
  navigation: WikiNavigation
  busy: boolean
  onCommand: (command: { action: 'read'; kbId: string; revisionId: string; documentId: string }) => void
}

/**
 * Issue #100: the overview / neighborhood graph navigation over one
 * revision's wiki index. The picture is derived deterministically from the
 * Server's own navigation projection — nothing here generates, resolves,
 * or invents content. Clicking a node selects it; a completed page is read
 * through the same per-page read seam as the text index, a skipped or
 * failed page only becomes the selection (its status stays visible in the
 * legend and the page list, never a body). 邻域 re-centers the two-hop
 * closure on the selected page, like the original overview/ego switch.
 */
export function WikiGraphPanel({ navigation, busy, onCommand }: WikiGraphPanelProps): JSX.Element {
  const [mode, setMode] = useState<WikiGraphMode>('overview')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const graph = buildWikiGraph(navigation, mode, selectedId)
  const selected = graph.nodes.find(node => node.id === selectedId) ?? null
  const selectedRow = selected ? navigation.pages.find(row => row.documentId === selected.id) ?? null : null
  const readNode = (documentId: string) => {
    setSelectedId(documentId)
    const row = navigation.pages.find(candidate => candidate.documentId === documentId)
    if (row?.status === 'completed') onCommand({ action: 'read', kbId: navigation.kbId, revisionId: navigation.revisionId, documentId })
  }
  return <div className="mt-3">
    <div className="flex flex-wrap items-center gap-3">
      <Typography.Title level={5} className="!mt-0 !mb-0">wiki 图导航</Typography.Title>
      <Segmented
        size="small"
        value={mode}
        onChange={value => setMode(value as WikiGraphMode)}
        options={[
          { label: '概览', value: 'overview', icon: <ApartmentOutlined /> },
          { label: '邻域', value: 'neighborhood', icon: <NodeIndexOutlined /> }
        ]}
      />
      <Typography.Text type="secondary">
        {mode === 'neighborhood' ? '邻域：以选中页面为中心的两跳页面。' : '概览：本冻结版本的全部页面。'}
        点击节点选中页面；可阅读的页面同时打开正文。缺失目标在下方页面索引如实标注，图中不画。
      </Typography.Text>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-3" aria-label="wiki 图例">
      {LEGEND.map(([status, name]) => <span key={status} className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-full" style={{ background: STATUS_DOT[status] }} />
        <Typography.Text type="secondary">{name}</Typography.Text>
      </span>)}
      <Typography.Text type="secondary">节点大小 = 图中可见关系数</Typography.Text>
    </div>
    <div className={busy ? 'pointer-events-none mt-2 opacity-60' : 'mt-2'}>
      <WikiGraphCanvas graph={graph} selectedId={selectedId} onNodeClick={readNode} />
    </div>
    {selected && selectedRow && <Typography.Paragraph className="mt-2">
      选中：{selected.label} · {statusNames[selected.status]}
      {selected.status !== 'completed' && selectedRow.errorCode ? `（${selectedRow.errorCode}）` : ''}
      <br />
      <Typography.Text type="secondary">{wikiSourceLine(selectedRow, selected.position - 1, selected.sourceTotal)}</Typography.Text>
    </Typography.Paragraph>}
  </div>
}

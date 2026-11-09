// Issue 103: the read-only SQL pane — 只读 SQL 查询窗格 over this identity's
// own imported table datasets. The pane is a thin honest surface on one
// device-local channel (`desktop:sql`): it names a registered ready dataset
// and the query text, and the device-side stdlib engine owns the entire
// read-only fence (write statements, multi-statement text and unlisted
// functions are refused there) plus every bound on the reply (rows,
// columns, cells, total characters, a deterministic VM budget). A cut is
// announced, never hidden; a failure is its fixed `SQL_QUERY_*` category,
// never a guess. 结果入会话 rides the #84 prefill signal — the composer's
// editable draft, never an automatic send — and carries the query's own
// provenance (dataset, row count, truncation markers) with it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Select, Space, Table, Tag, Typography } from 'antd'
import type { DesktopBridge, DesktopStatus, DatasetView, SqlQueryCommand, SqlQueryResultView } from '../../../../shared/desktop'
import { useSessionStore } from '../../stores/sessionStore'

type SqlApi = Pick<DesktopBridge, 'sql' | 'getStatus'>

const MAX_SQL_QUERY_CHARS = 10_000

/** Fixed categories only: the renderer maps codes to honest hints and can
 * never invent a cause it was not told. */
const ERROR_HINTS: Record<string, string> = {
  SQL_QUERY_COMMAND_INVALID: '查询命令形状不合法，请修改后重试',
  SQL_QUERY_UNAUTHENTICATED: '需要先登录，才能查询本机账号自己的数据集',
  SQL_QUERY_NOT_FOUND: '没有找到这条数据集登记（或它不是就绪状态）',
  SQL_QUERY_FILE_TOO_LARGE: '数据集原文件超出了本机读取上限',
  SQL_QUERY_FILE_UNREADABLE: '数据集原文件已不可读（可能被移动或删除）',
  SQL_QUERY_PARSE_FAILED: '数据集原文件已无法解析（内容可能已被修改）',
  SQL_QUERY_DATASET_TOO_LARGE: '数据集超过了查询引擎的载入上限，无法在内存中建副本',
  SQL_QUERY_IDENTITY_CHANGED: '工作区身份已变化，请重新发起查询',
  SQL_QUERY_FORBIDDEN: '只读限制：写语句、多语句或未放行的函数被拒绝，查询未执行',
  SQL_QUERY_INTERRUPTED: '查询超出了计算预算，已被中断；请缩小查询范围或加过滤条件',
  SQL_QUERY_EXECUTION_FAILED: 'SQL 执行失败；请检查表名与列名（可在下方查看可查询的列）',
  SQL_QUERY_TIMEOUT: '查询超过 60 秒未返回，已放弃',
  SQL_QUERY_BUSY: '已有查询在执行，请等它返回后再发',
  SQL_QUERY_FAILED: '查询失败（本机原因未知）',
  RUNTIME_UNAVAILABLE: '设备端 Runtime 未运行，请先在“运行”面板启动'
}

const errorHint = (error: unknown): string => {
  const code = error instanceof Error ? error.message : String(error)
  return ERROR_HINTS[code] ?? `查询失败（${code}）`
}

const buildSessionText = (dataset: DatasetView, sql: string, result: SqlQueryResultView): string => {
  const marks = [
    result.truncated ? '行已达上限' : '',
    result.columnsTruncated ? '列已达上限' : '',
    result.cellsTruncated ? '有单元格被截断' : ''
  ].filter(Boolean)
  const header =
    `**只读 SQL 查询**（数据集：${dataset.filename}` +
    `${dataset.projectId ? `，平台项目 ${dataset.projectId}` : ''}；` +
    `返回 ${result.rowCount} 行${marks.length ? `；${marks.join('，')}` : ''}）`
  const csvCell = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  if (result.rows.length <= 20 && result.columns.length <= 8) {
    // Markdown table cells cannot carry a raw pipe or newline: a value with
    // either would distort the draft's table shape, so each is escaped —
    // the CSV path below keeps its own quoting.
    const mdCell = (value: string | number | null): string =>
      (value === null ? '' : String(value)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    const head = `| ${result.columns.map(mdCell).join(' | ')} |`
    const rule = `| ${result.columns.map(() => '---').join(' | ')} |`
    const body = result.rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`).join('\n')
    return `${header}\n\n${head}\n${rule}\n${body}`
  }
  const rows = [result.columns, ...result.rows].map((row) => row.map(csvCell).join(',')).join('\n')
  return `${header}\n\n\`\`\`csv\n${rows}\n\`\`\``
}

export default function SqlPane({ instanceId, panelType, api }: {
  instanceId: string
  panelType: string
  /** Injectable seam for headless tests; production uses the trusted bridge. */
  api?: SqlApi
}): JSX.Element {
  const bridge: SqlApi = api ?? window.ideer
  // `instanceId`/`panelType` keep the dock pane signature; the pane is
  // single-instance and view state is component-local on purpose.
  void instanceId
  void panelType
  const [datasets, setDatasets] = useState<DatasetView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [sql, setSql] = useState('')
  const [running, setRunning] = useState(false)
  const [hint, setHint] = useState('')
  const [result, setResult] = useState<SqlQueryResultView | null>(null)
  // One sequence per operation: a refresh landing mid-query must never
  // invalidate the query's own settle (its `finally` keeps the button
  // honest), and vice versa.
  const refreshSequence = useRef(0)
  const querySequence = useRef(0)

  const selected = datasets.find((row) => row.id === selectedId) ?? null

  const refreshDatasets = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const status: DesktopStatus = await bridge.getStatus()
      if (refreshSequence.current !== sequence) return
      const ready = (status.runtime.datasets ?? []).filter((row) => row.status === 'ready')
      setDatasets(ready)
      setSelectedId((current) =>
        ready.some((row) => row.id === current) ? current : ready[0]?.id ?? '')
    } catch {
      if (refreshSequence.current === sequence) setHint('数据集列表读取失败；请确认设备端 Runtime 正在运行')
    }
  }, [bridge])

  useEffect(() => { void refreshDatasets() }, [refreshDatasets])

  const runQuery = useCallback(async () => {
    if (!selected || !sql.trim() || running) return
    const sequence = ++querySequence.current
    setRunning(true)
    setHint('')
    const command: SqlQueryCommand = { action: 'query', datasetId: selected.id, sql: sql.trim() }
    try {
      const view = await bridge.sql(command)
      if (querySequence.current !== sequence) return
      setResult(view)
    } catch (error) {
      if (querySequence.current !== sequence) return
      setResult(null)
      setHint(errorHint(error))
    } finally {
      if (querySequence.current === sequence) setRunning(false)
    }
  }, [bridge, running, selected, sql])

  const sendToSession = useCallback(() => {
    if (!selected || !result) return
    useSessionStore.getState().requestPrefill(buildSessionText(selected, sql.trim(), result))
  }, [result, selected, sql])

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3">
      <Space wrap>
        <Select
          aria-label="选择数据集"
          placeholder="选择数据集"
          style={{ minWidth: 240 }}
          value={selectedId || undefined}
          onChange={(id) => { setSelectedId(id); setResult(null); setHint('') }}
          options={datasets.map((row) => ({
            value: row.id,
            label: `${row.filename}${row.projectId ? `（平台项目 ${row.projectId}）` : ''}`
          }))}
        />
        <Button aria-label="刷新数据集列表" onClick={() => { void refreshDatasets() }}>刷新</Button>
      </Space>
      {selected && (
        <Typography.Text type="secondary" className="text-xs">
          工作表按导入顺序注册为 sheet1…sheet{selected.sheets.length}：
          {selected.sheets.map((sheet, index) => (
            <Tag key={index} className="mr-1">
              {`sheet${index + 1} ≙ ${sheet.name}（${sheet.rowCount} 行）`}
            </Tag>
          ))}
        </Typography.Text>
      )}
      <Input.TextArea
        aria-label="SQL 查询"
        placeholder="只读 SELECT，例如：SELECT * FROM sheet1 LIMIT 20"
        value={sql}
        onChange={(event) => setSql(event.target.value.slice(0, MAX_SQL_QUERY_CHARS))}
        rows={5}
        disabled={!selected}
      />
      <Space>
        <Button
          aria-label="执行查询"
          type="primary"
          disabled={!selected || !sql.trim() || running}
          loading={running}
          onClick={() => { void runQuery() }}
        >
          查询
        </Button>
        <Typography.Text type="secondary" className="text-xs">{sql.length}/{MAX_SQL_QUERY_CHARS}</Typography.Text>
      </Space>
      {hint && <Alert type="error" showIcon message={hint} />}
      {result && selected && (
        <>
          <Space wrap aria-label="查询结果摘要">
            <Typography.Text>返回 {result.rowCount} 行</Typography.Text>
            {result.truncated && <Tag color="orange">行已达上限（200）</Tag>}
            {result.columnsTruncated && <Tag color="orange">列已达上限（64）</Tag>}
            {result.cellsTruncated && <Tag color="orange">部分单元格被截断</Tag>}
            <Button aria-label="结果入会话" onClick={sendToSession}>结果入会话</Button>
          </Space>
          <Table
            aria-label="查询结果"
            size="small"
            pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
            dataSource={result.rows.map((row, index) => ({
              key: index,
              cells: row.map((cell) => (cell === null ? '' : String(cell)))
            }))}
            columns={result.columns.map((name, index) => ({
              title: name,
              dataIndex: ['cells', index],
              key: String(index),
              ellipsis: true
            }))}
          />
        </>
      )}
      {!selected && !hint && (
        <Empty description="还没有已导入的表格数据集；在“运行”面板的数据集区导入 XLSX/CSV 后即可查询" />
      )}
    </div>
  )
}

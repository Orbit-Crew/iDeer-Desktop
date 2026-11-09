// @vitest-environment jsdom
// Issue 103: the read-only SQL pane's surface contract over its one bounded
// channel. The pane lists this identity's own ready datasets, sends only the
// registered identity plus the query text, announces every honest cut marker
// the engine reports, maps fixed `SQL_QUERY_*` categories to real hints —
// and 结果入会话 rides the #84 prefill signal as an editable draft with its
// provenance, never an automatic send.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SqlPane from '../src/renderer/src/dock/panels/sqlPane'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { DesktopStatus, DatasetView, SqlQueryResultView } from '../src/shared/desktop'

afterEach(() => {
  cleanup()
  useSessionStore.setState({ pendingPrefill: null })
})

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  } as MediaQueryList))
})

const dataset = (over: Partial<DatasetView> = {}): DatasetView => ({
  id: 'a'.repeat(64), filename: '销售台账.xlsx', sourcePath: 'C:/data/销售台账.xlsx',
  format: 'xlsx', fileSha256: 'b'.repeat(64),
  sheets: [
    { name: '明细', fingerprint: 'c'.repeat(64), schema: '编号:number、品名:string',
      rowCount: 2, colCount: 2, truncated: false, columnsTruncated: false },
    { name: '汇总', fingerprint: 'd'.repeat(64), schema: '合计:number', rowCount: 1,
      colCount: 1, truncated: false, columnsTruncated: false }
  ],
  rowCount: 3, projectId: 'prj_9', deviceId: 'device-102', status: 'ready',
  errorCode: '', createdAt: '2026-11-08T00:00:00',
  ...over
})

const status = (rows: DatasetView[]): DesktopStatus => ({
  version: '0.2.0', server: 'connected',
  runtime: { process: 'running', connection: 'connected', tasks: [], datasets: rows }
})

const queryResult = (over: Partial<SqlQueryResultView> = {}): SqlQueryResultView => ({
  tables: [{ table: 'sheet1', name: '明细', columns: ['编号', '品名'] }],
  columns: ['编号', '品名'],
  rows: [[1, 'widget'], [2, null]],
  rowCount: 2, truncated: false, columnsTruncated: false, cellsTruncated: false,
  ...over
})

const api = (over: { sql?: ReturnType<typeof vi.fn>; getStatus?: ReturnType<typeof vi.fn> } = {}) => ({
  sql: over.sql ?? vi.fn(),
  getStatus: over.getStatus ?? vi.fn()
})

describe('sql pane surface (#103)', () => {
  it('lists only ready datasets with their sheetN registration mapping', async () => {
    const bridge = api({ getStatus: vi.fn().mockResolvedValue(status([dataset(), dataset({ id: 'e'.repeat(64), status: 'failed', format: '', sheets: [], errorCode: 'DATASETS_PARSE_FAILED' })])) })
    render(<SqlPane instanceId="i1" panelType="sql" api={bridge} />)
    await waitFor(() => expect(bridge.getStatus).toHaveBeenCalled())
    // The pane auto-selects the first ready dataset — the sheet mapping only
    // renders once a dataset is selected — and the engine's deterministic
    // sheetN names sit next to the sheets the registry recorded, while a
    // failed row is nowhere on the surface.
    expect(await screen.findByText('sheet1 ≙ 明细（2 行）')).toBeTruthy()
    expect(screen.getByText('sheet2 ≙ 汇总（1 行）')).toBeTruthy()
    expect(screen.queryByText('e'.repeat(64))).toBeNull()
  })

  it('sends only the registered identity and the query text, and renders the bounded reply', async () => {
    const sql = vi.fn().mockResolvedValue(queryResult())
    const bridge = api({ sql, getStatus: vi.fn().mockResolvedValue(status([dataset()])) })
    render(<SqlPane instanceId="i1" panelType="sql" api={bridge} />)
    const textarea = await screen.findByLabelText('SQL 查询')
    fireEvent.change(textarea, { target: { value: 'SELECT * FROM sheet1' } })
    fireEvent.click(screen.getByLabelText('执行查询'))
    await waitFor(() => expect(sql).toHaveBeenCalledWith(
      { action: 'query', datasetId: 'a'.repeat(64), sql: 'SELECT * FROM sheet1' }))
    expect(await screen.findByText('返回 2 行')).toBeTruthy()
    expect(screen.queryByText('行已达上限（200）')).toBeNull()
    expect(screen.getByText('widget')).toBeTruthy()
    // A null cell renders empty — the engine's honest NULL, never a fake.
    const rows = screen.getAllByRole('row')
    expect(rows.some((row) => row.textContent?.includes('widget'))).toBe(true)
  })

  it('announces every honest cut marker the engine reports', async () => {
    const sql = vi.fn().mockResolvedValue(queryResult({ truncated: true, columnsTruncated: true, cellsTruncated: true }))
    const bridge = api({ sql, getStatus: vi.fn().mockResolvedValue(status([dataset()])) })
    render(<SqlPane instanceId="i1" panelType="sql" api={bridge} />)
    fireEvent.change(await screen.findByLabelText('SQL 查询'), { target: { value: 'SELECT * FROM sheet1' } })
    fireEvent.click(screen.getByLabelText('执行查询'))
    expect(await screen.findByText('行已达上限（200）')).toBeTruthy()
    expect(screen.getByText('列已达上限（64）')).toBeTruthy()
    expect(screen.getByText('部分单元格被截断')).toBeTruthy()
  })

  it('maps the fixed refused category to its honest hint and keeps the pane usable', async () => {
    const sql = vi.fn().mockRejectedValue(new Error('SQL_QUERY_FORBIDDEN'))
    const bridge = api({ sql, getStatus: vi.fn().mockResolvedValue(status([dataset()])) })
    render(<SqlPane instanceId="i1" panelType="sql" api={bridge} />)
    fireEvent.change(await screen.findByLabelText('SQL 查询'), { target: { value: 'DELETE FROM sheet1' } })
    fireEvent.click(screen.getByLabelText('执行查询'))
    expect(await screen.findByText('只读限制：写语句、多语句或未放行的函数被拒绝，查询未执行')).toBeTruthy()
    expect(screen.queryByText('返回 2 行')).toBeNull()
    // An unmapped fixed category still shows its code — never a fake cause.
    const failing = api({ sql: vi.fn().mockRejectedValue(new Error('SQL_QUERY_BUSY')), getStatus: vi.fn().mockResolvedValue(status([dataset()])) })
    cleanup()
    render(<SqlPane instanceId="i1" panelType="sql" api={failing} />)
    fireEvent.change(await screen.findByLabelText('SQL 查询'), { target: { value: 'SELECT 1' } })
    fireEvent.click(screen.getByLabelText('执行查询'))
    expect(await screen.findByText('已有查询在执行，请等它返回后再发')).toBeTruthy()
  })

  it('结果入会话 prefills the composer draft with provenance, never auto-sends', async () => {
    const sql = vi.fn().mockResolvedValue(queryResult())
    const bridge = api({ sql, getStatus: vi.fn().mockResolvedValue(status([dataset()])) })
    render(<SqlPane instanceId="i1" panelType="sql" api={bridge} />)
    fireEvent.change(await screen.findByLabelText('SQL 查询'), { target: { value: 'SELECT * FROM sheet1' } })
    fireEvent.click(screen.getByLabelText('执行查询'))
    await screen.findByText('返回 2 行')
    fireEvent.click(screen.getByLabelText('结果入会话'))
    await waitFor(() => expect(useSessionStore.getState().pendingPrefill).not.toBeNull())
    const prefill = useSessionStore.getState().pendingPrefill?.content ?? ''
    expect(prefill).toContain('**只读 SQL 查询**（数据集：销售台账.xlsx，平台项目 prj_9；返回 2 行）')
    expect(prefill).toContain('| 编号 | 品名 |')
    expect(prefill).toContain('| 1 | widget |')
  })

  it('large results enter the session as bounded csv text', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => [index + 1, `品${index}`])
    const sql = vi.fn().mockResolvedValue(queryResult({ rows, rowCount: 30 }))
    const bridge = api({ sql, getStatus: vi.fn().mockResolvedValue(status([dataset()])) })
    render(<SqlPane instanceId="i1" panelType="sql" api={bridge} />)
    fireEvent.change(await screen.findByLabelText('SQL 查询'), { target: { value: 'SELECT * FROM sheet1' } })
    fireEvent.click(screen.getByLabelText('执行查询'))
    await screen.findByText('返回 30 行')
    fireEvent.click(screen.getByLabelText('结果入会话'))
    await waitFor(() => expect(useSessionStore.getState().pendingPrefill).not.toBeNull())
    const prefill = useSessionStore.getState().pendingPrefill?.content ?? ''
    expect(prefill).toContain('```csv')
    expect(prefill).toContain('编号,品名')
  })

  it('markdown cells carry pipes and newlines escaped so the draft keeps its table shape', async () => {
    const sql = vi.fn().mockResolvedValue(queryResult({ rows: [[1, 'a|b'], [2, '两\n行']] }))
    const bridge = api({ sql, getStatus: vi.fn().mockResolvedValue(status([dataset()])) })
    render(<SqlPane instanceId="i1" panelType="sql" api={bridge} />)
    fireEvent.change(await screen.findByLabelText('SQL 查询'), { target: { value: 'SELECT * FROM sheet1' } })
    fireEvent.click(screen.getByLabelText('执行查询'))
    await screen.findByText('返回 2 行')
    fireEvent.click(screen.getByLabelText('结果入会话'))
    await waitFor(() => expect(useSessionStore.getState().pendingPrefill).not.toBeNull())
    const prefill = useSessionStore.getState().pendingPrefill?.content ?? ''
    expect(prefill).toContain('a\\|b')
    expect(prefill).toContain('两 行')
    // The table still has exactly its header rule and two rows.
    expect(prefill.match(/^\|/gm)?.length).toBe(4)
  })
})

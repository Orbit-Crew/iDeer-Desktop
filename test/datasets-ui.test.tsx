// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { DatasetSection } from '../src/renderer/src/components/DatasetSection'
import { useSessionStore } from '../src/renderer/src/stores/sessionStore'
import type { DatasetCommand, DatasetView, RuntimeStatus } from '../src/shared/desktop'

afterEach(cleanup)

const datasetRow = (overrides: Partial<DatasetView> = {}): DatasetView => ({
  id: 'a'.repeat(64), filename: 'sales.xlsx', sourcePath: 'C:/data/sales.xlsx', format: 'xlsx',
  fileSha256: 'b'.repeat(64),
  sheets: [{ name: 'Q1', fingerprint: 'c'.repeat(64), schema: '编号:number、名称:string',
    rowCount: 2, colCount: 2, truncated: false, columnsTruncated: false }],
  rowCount: 2, projectId: 'proj-1', deviceId: 'device-102', status: 'ready', errorCode: '',
  createdAt: '2026-11-06T00:00:00Z', ...overrides
})

const runtimeStatus = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({ process: 'running', connection: 'connected', tasks: [], datasets: [datasetRow()], ...overrides })

const renderSection = (overrides: {
  runtime?: RuntimeStatus
  busy?: boolean
  error?: string
  notice?: string
  onCommand?: (command: DatasetCommand) => void
} = {}) => render(
  <DatasetSection
    runtime={overrides.runtime ?? runtimeStatus()}
    busy={overrides.busy ?? false}
    error={overrides.error ?? ''}
    notice={overrides.notice ?? ''}
    onCommand={overrides.onCommand ?? (() => {})}
  />
)

describe('table dataset import surface (#102)', () => {
  it('renders registered datasets with their project association, schema and original-file facts', () => {
    renderSection()
    expect(screen.getByText(/sales.xlsx（XLSX · 1 个工作表，共 2 行）/)).toBeTruthy()
    expect(screen.getByText(/关联项目 proj-1 · 设备 device-102/)).toBeTruthy()
    expect(screen.getByText(/工作表「Q1」：2 行 × 2 列 · 编号:number、名称:string/)).toBeTruthy()
    expect(screen.getByText(/内容指纹：b{64}/)).toBeTruthy()
    expect(screen.getByText(/原件：C:\/data\/sales\.xlsx（留在本机，未被移动或上传）/)).toBeTruthy()
    expect(screen.getByText('删除此登记（保留原件）…')).toBeTruthy()
  })

  it('carries the currently selected platform project into the import association', async () => {

    const onCommand = vi.fn()
    useSessionStore.setState({ projectSelection: { kind: 'project', projectId: 'proj-9' } })
    renderSection({ onCommand })
    expect(screen.getByText(/导入将关联项目：proj-9/)).toBeTruthy()
    screen.getByText('导入表格数据集…').click()
    expect(onCommand).toHaveBeenCalledWith({ action: 'import', projectId: 'proj-9' })
    // An unassociated import says so honestly instead of guessing a project;
    // the store change re-renders through the subscription, so wait for it.
    useSessionStore.setState({ projectSelection: { kind: 'all' } })
    await waitFor(() => expect(screen.getByText(/导入将关联项目：当前未选中平台项目（登记为未关联）/)).toBeTruthy())
    useSessionStore.setState({ projectSelection: { kind: 'project', projectId: 'proj-9' } })
    await waitFor(() => expect(screen.getByText(/导入将关联项目：proj-9/)).toBeTruthy())
    screen.getByText('删除此登记（保留原件）…').click()
    expect(onCommand).toHaveBeenCalledWith({ action: 'delete', datasetId: 'a'.repeat(64) })
  })

  it('shows duplicate notices, honest failure rows and the fixed error categories', () => {
    renderSection({ notice: '未重复登记：内容指纹与已登记数据集一致，不产生第二条记录' })
    expect(screen.getByText(/未重复登记/)).toBeTruthy()
    cleanup()
    // A failed row that never recognized a format states no format (#102
    // review): the registry's real wire shape for a corrupt file.
    renderSection({ runtime: runtimeStatus({
      datasets: [datasetRow({ status: 'failed', format: '', errorCode: 'DATASETS_PARSE_FAILED', sheets: [] })] }) })
    expect(screen.getByText('导入失败：DATASETS_PARSE_FAILED')).toBeTruthy()
    cleanup()
    // A failed row whose suffix named the format keeps that honest fact.
    renderSection({ runtime: runtimeStatus({
      datasets: [datasetRow({ status: 'failed', format: 'xlsx', errorCode: 'DATASETS_PARSE_FAILED', sheets: [] })] }) })
    expect(screen.getByText('导入失败（XLSX）：DATASETS_PARSE_FAILED')).toBeTruthy()
    cleanup()
    renderSection({ error: 'DATASETS_UNAUTHENTICATED' })
    expect(screen.getByText('需要已认证的桌面会话')).toBeTruthy()
    cleanup()
    renderSection({ runtime: runtimeStatus({ datasetsStorageError: 'DATASETS_STORAGE_UNAVAILABLE' }) })
    expect(screen.getByText('数据集登记存储不可用，状态显示可能不完整')).toBeTruthy()
  })

  it('marks sheets that held more columns than the recorded cap', () => {
    renderSection({ runtime: runtimeStatus({ datasets: [datasetRow({
      filename: 'wide.csv', format: 'csv',
      sheets: [{ name: 'wide', fingerprint: 'd'.repeat(64), schema: 'c0:number',
        rowCount: 1, colCount: 128, truncated: false, columnsTruncated: true }] })] }) })
    expect(screen.getByText(/工作表「wide」：1 行 × 128 列 · c0:number（列已截断）/)).toBeTruthy()
  })

  it('shows the empty state without inventing rows', () => {
    renderSection({ runtime: runtimeStatus({ datasets: [] }) })
    expect(screen.getByText(/尚无数据集登记/)).toBeTruthy()
    expect(screen.queryByText(/sales\.xlsx/)).toBeNull()
  })
})

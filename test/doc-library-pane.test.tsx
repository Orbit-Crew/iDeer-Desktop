// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DocLibraryPane from '../src/renderer/src/dock/panels/docLibraryPane'
import type { DesktopStatus, KnowledgeFolderJobView, KnowledgeImportView, KnowledgeIndexJobView, KnowledgeIndexView, KnowledgeSearchView, RuntimeStatus } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  }) as MediaQueryList)
})

const KB = '33333333-3333-4333-8333-333333333333'
const PARSED = { status: 'parsed', parser: 'text-utf8', parserVersion: '1', pages: 0, tables: 0, truncated: false, errorCode: '', layout: [] }

const importRow = (overrides: Partial<KnowledgeImportView> = {}): KnowledgeImportView => ({
  id: 'a'.repeat(64), kbId: KB, revisionId: 'f'.repeat(64), revisionNo: 2, manifestHash: 'b'.repeat(64),
  documentCount: 2, status: 'registered', errorCode: '', createdAt: '2026-11-07T00:00:00Z',
  projectId: 'proj-77', source: { kind: 'folder', folder: '/workspace/文档库', pathCount: 2 },
  documents: [
    { filename: 'guide.md', sha256: 'c'.repeat(64), bytes: 44, mime: 'text/markdown', parse: PARSED },
    { filename: 'notes.txt', sha256: 'd'.repeat(64), bytes: 18, mime: 'text/plain', parse: PARSED }
  ],
  ...overrides
})

const failedRow = (overrides: Partial<KnowledgeImportView> = {}): KnowledgeImportView => importRow({
  id: 'e'.repeat(64), revisionId: '', revisionNo: 0, manifestHash: '', documentCount: 1,
  status: 'failed', errorCode: 'CHAT_SERVER_ERROR',
  source: { kind: 'folder', folder: '/workspace/文档库', pathCount: 1 },
  documents: [{ filename: 'broken.md', sha256: 'f'.repeat(64), bytes: 9, mime: 'text/markdown' }],
  ...overrides
})

const job = (overrides: Partial<KnowledgeFolderJobView> = {}): KnowledgeFolderJobView => ({
  state: 'running', kbId: KB, folder: '/workspace/文档库', totalFiles: 250, processedFiles: 120,
  registeredBatches: 0, registeredDocuments: 0, failedBatches: 0, skippedDuplicates: 7,
  skippedUnsupported: 3, skippedLinks: 1, truncated: false, error: '', failures: [], ...overrides
})

const runtimeStatus = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  process: 'running', connection: 'connected', tasks: [],
  login: { state: 'authenticated', account: 'a@test.invalid', device: 'dev', error: '' },
  workspace: { state: 'ready', logicalRoot: '/workspace' },
  knowledgeImports: [importRow(), failedRow()],
  knowledgeFolderImport: null,
  ...overrides
})

let statusFixture = runtimeStatus()
/** The bridge returns the whole DesktopStatus; the pane reads its runtime. */
const desktopStatus = (runtime: RuntimeStatus): DesktopStatus =>
  ({ version: '0.0.0-test', server: 'connected', runtime })

const stubIdeer = (impl: { reject?: string; outcomeOverrides?: Record<string, unknown> } = {}) => {
  const calls: { method: string; args: unknown[] }[] = []
  ;(window as { ideer?: unknown }).ideer = {
    getStatus: vi.fn(() => Promise.resolve(desktopStatus(statusFixture))),
    knowledgeFolderImport: vi.fn((kbId: string) => {
      calls.push({ method: 'knowledgeFolderImport', args: [kbId] })
      return impl.reject ? Promise.reject(new Error(impl.reject)) : Promise.resolve(job())
    }),
    knowledgeFolderCancel: vi.fn(() => {
      calls.push({ method: 'knowledgeFolderCancel', args: [] })
      return Promise.resolve({ canceled: true })
    }),
    deleteKnowledgeImports: vi.fn((ids: string[]) => {
      calls.push({ method: 'deleteKnowledgeImports', args: [ids] })
      return impl.reject ? Promise.reject(new Error(impl.reject)) : Promise.resolve({ deleted: ids.length })
    }),
    retryKnowledgeImport: vi.fn((recordId: string) => {
      calls.push({ method: 'retryKnowledgeImport', args: [recordId] })
      return impl.reject ? Promise.reject(new Error(impl.reject))
        : Promise.resolve({ kbId: KB, revisionId: 'f'.repeat(64), revisionNo: 3, manifestHash: 'b'.repeat(64), documentCount: 1, ...impl.outcomeOverrides })
    }),
    rebuildKnowledgeIndex: vi.fn((kbId: string, revisionId: string, manifestHash: string) => {
      calls.push({ method: 'rebuildKnowledgeIndex', args: [kbId, revisionId, manifestHash] })
      return impl.reject ? Promise.reject(new Error(impl.reject)) : Promise.resolve(indexJob())
    }),
    cancelKnowledgeIndexRebuild: vi.fn(() => {
      calls.push({ method: 'cancelKnowledgeIndexRebuild', args: [] })
      return Promise.resolve({ canceled: true })
    }),
    knowledgeSearch: vi.fn((kbId: string, revisionId: string, query: string) => {
      calls.push({ method: 'knowledgeSearch', args: [kbId, revisionId, query] })
      return impl.reject ? Promise.reject(new Error(impl.reject)) : Promise.resolve(searchView())
    }),
    // Issue 101: 删除=库新版本 and the separate physical cleanup.
    deleteKnowledgeDocuments: vi.fn((kbId: string, revisionId: string, contentHashes: string[]) => {
      calls.push({ method: 'deleteKnowledgeDocuments', args: [kbId, revisionId, contentHashes] })
      return impl.reject ? Promise.reject(new Error(impl.reject)) : Promise.resolve({
        kbId, removedDocuments: contentHashes.length,
        revision: { kbId, revisionId: 'e'.repeat(64), revisionNo: 3, manifestHash: 'e'.repeat(64), documentCount: 1 },
        supersededRecordId: 'a'.repeat(64) })
    }),
    cleanupKnowledgeRevision: vi.fn((kbId: string, revisionId: string, manifestHash: string) => {
      calls.push({ method: 'cleanupKnowledgeRevision', args: [kbId, revisionId, manifestHash] })
      return impl.reject ? Promise.reject(new Error(impl.reject))
        : Promise.resolve({ kbId, revisionId, indexPurged: true, snapshotsPurged: 1 })
    })
  }
  return { calls }
}

/** Issue 97: one revision's derived index facts and the one rebuild job. */
const indexView = (overrides: Partial<KnowledgeIndexView> = {}): KnowledgeIndexView =>
  ({ state: 'ready', documents: 2, indexedDocuments: 2, servableDocuments: 2, driftedDocuments: 0, builtAt: '2026-11-07T01:00:00Z', error: '', ...overrides })

const indexJob = (overrides: Partial<KnowledgeIndexJobView> = {}): KnowledgeIndexJobView =>
  ({ state: 'running', kbId: KB, revisionId: 'f'.repeat(64), manifestHash: 'b'.repeat(64), totalDocuments: 2, processedDocuments: 1, indexedDocuments: 1, driftedDocuments: 0, unavailableDocuments: 0, error: '', ...overrides })

/** Issue 98: one library search's bounded citation view. */
const searchView = (overrides: Partial<KnowledgeSearchView> = {}): KnowledgeSearchView => ({
  kbId: KB, revisionId: 'f'.repeat(64), revisionNo: 2, manifestHash: 'b'.repeat(64),
  query: 'ALPHA', engine: 'bm25', fallbackReason: '',
  chunks: [
    { filename: 'report.md', contentHash: 'c'.repeat(64), content: 'alpha in table body',
      position: { logicalPath: '/workspace/report.md', line: 2, page: 4, table: 2 } },
    { filename: 'guide.md', contentHash: 'd'.repeat(64), content: 'the launch code is ALPHA-7',
      position: { logicalPath: '/workspace/guide.md', line: 1, page: 1, table: null } }
  ],
  missing: [], truncated: false, documentsMatched: 2, documentsTotal: 2,
  evidenceComplete: true,
  credentials: { serverOrigin: 'https://test.invalid', userId: 'a@test.invalid', deviceId: 'dev' },
  auditTaskId: '4'.repeat(32) + '-audit',
  ...overrides
})

describe('doc library pane (issue 96)', () => {
  it('renders import records with honest outcomes, platform association and folder source', async () => {
    stubIdeer()
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const list = await screen.findByRole('list', { name: '导入记录列表' })
    expect(list.textContent).toContain('已完成：已登记版本 R2 · 2 个文件')
    expect(list.textContent).toContain('失败：CHAT_SERVER_ERROR')
    // Criterion 5: the platform project rides next to the library identity.
    expect(list.textContent).toContain('平台项目 proj-77')
    expect(list.textContent).toContain(`知识库 ${KB}`)
    expect(list.textContent).toContain('R2')
    // The workspace-logical source folder is a display fact; stored paths are not.
    expect(list.textContent).toContain('/workspace/文档库')
    expect(list.textContent).not.toMatch(/paths/i)
    // A stopped Runtime has no records; empty says so honestly.
    statusFixture = runtimeStatus({ knowledgeImports: [], process: 'stopped' })
    const stopped = render(<DocLibraryPane instanceId="kb-2" panelType="kb" />)
    expect(await screen.findByText('本机 Runtime 未运行，导入与批量操作不可用')).toBeTruthy()
    stopped.unmount()
  })

  it('shows the background job progress with the dedup prompt and failures', async () => {
    stubIdeer()
    statusFixture = runtimeStatus({ knowledgeFolderImport: job({
      state: 'completed', totalFiles: 250, processedFiles: 250, registeredBatches: 2,
      registeredDocuments: 240, failures: [{ filename: 'locked.md', errorCode: 'KNOWLEDGE_IMPORT_PROTECTED_PATH' }]
    }) })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    expect(await screen.findByText('后台导入已完成')).toBeTruthy()
    expect(screen.getByTestId('doc-library-job').textContent).toContain('已处理 250 / 250 个文件')
    // The dedup prompt: skipped duplicates are counted and surfaced, never silent.
    expect(screen.getByTestId('doc-library-job').textContent).toContain('按内容指纹去重：跳过 7 个重复文件')
    expect(screen.getByTestId('doc-library-job').textContent).toContain('locked.md：KNOWLEDGE_IMPORT_PROTECTED_PATH')
    // A running job offers its cancel command.
    statusFixture = runtimeStatus({ knowledgeFolderImport: job() })
    const running = render(<DocLibraryPane instanceId="kb-2" panelType="kb" />)
    expect(await screen.findByText('后台导入进行中')).toBeTruthy()
    running.unmount()
  })

  it('starts the folder import through the trusted bridge and cancels the running job', async () => {
    const { calls } = stubIdeer()
    statusFixture = runtimeStatus({ knowledgeFolderImport: job() })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const input = await screen.findByRole('textbox', { name: '平台知识库 UUID' })
    fireEvent.change(input, { target: { value: KB } })
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹并导入' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'knowledgeFolderImport')).toBe(true))
    expect(calls.find((call) => call.method === 'knowledgeFolderImport')?.args).toEqual([KB])
    fireEvent.click(await screen.findByRole('button', { name: '取消后台导入' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'knowledgeFolderCancel')).toBe(true))
  })

  it('batch-deletes the selected records after multi-select', async () => {
    const { calls } = stubIdeer()
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const boxes = await screen.findAllByRole('checkbox')
    expect(boxes.length).toBe(2)
    const deleteButton = screen.getByRole('button', { name: '删除所选记录' }) as HTMLButtonElement
    expect(deleteButton.disabled).toBe(true)
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])
    const armed = screen.getByRole('button', { name: '删除所选记录' }) as HTMLButtonElement
    expect(armed.disabled).toBe(false)
    fireEvent.click(armed)
    await waitFor(() => expect(calls.some((call) => call.method === 'deleteKnowledgeImports')).toBe(true))
    expect(calls.find((call) => call.method === 'deleteKnowledgeImports')?.args)
      .toEqual([['a'.repeat(64), 'e'.repeat(64)]])
  })

  it('retries only the selected failed records through the ordinary seam', async () => {
    const { calls } = stubIdeer()
    const first = render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const boxes = await screen.findAllByRole('checkbox')
    // Only the failed row is selected: the retry button arms.
    fireEvent.click(boxes[1])
    const retryButton = screen.getByRole('button', { name: '重试所选失败记录' }) as HTMLButtonElement
    expect(retryButton.disabled).toBe(false)
    fireEvent.click(retryButton)
    await waitFor(() => expect(calls.some((call) => call.method === 'retryKnowledgeImport')).toBe(true))
    expect(calls.find((call) => call.method === 'retryKnowledgeImport')?.args).toEqual(['e'.repeat(64)])
    first.unmount()
    // A registered row alone never arms the retry.
    stubIdeer()
    render(<DocLibraryPane instanceId="kb-2" panelType="kb" />)
    const registeredBox = (await screen.findAllByRole('checkbox'))[0]
    fireEvent.click(registeredBox)
    expect((screen.getByRole('button', { name: '重试所选失败记录' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces fixed categories as actionable explanations, never raw refusals', async () => {
    stubIdeer({ reject: 'KNOWLEDGE_IMPORT_NO_SOURCE' })
    statusFixture = runtimeStatus({ knowledgeImports: [failedRow()] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const boxes = await screen.findAllByRole('checkbox')
    fireEvent.click(boxes[0])
    fireEvent.click(screen.getByRole('button', { name: '重试所选失败记录' }))
    expect(await screen.findByText('该记录没有保存来源文件，无法重试')).toBeTruthy()
  })

  it('aggregates every retry failure across a multi-selection', async () => {
    // Two selected failed records, two distinct refusals: both explanations
    // stay visible, none erased by the next attempt.
    const refusals = ['KNOWLEDGE_IMPORT_NO_SOURCE', 'KNOWLEDGE_IMPORT_RECORD_NOT_FOUND']
    const retries = vi.fn(() => Promise.reject(new Error(refusals.shift() ?? 'X')))
    ;(window as { ideer?: unknown }).ideer = {
      getStatus: vi.fn(() => Promise.resolve(desktopStatus(statusFixture))),
      knowledgeFolderImport: vi.fn(() => Promise.resolve(job())),
      knowledgeFolderCancel: vi.fn(() => Promise.resolve({ canceled: true })),
      deleteKnowledgeImports: vi.fn(() => Promise.resolve({ deleted: 0 })),
      retryKnowledgeImport: retries
    }
    statusFixture = runtimeStatus({ knowledgeImports: [failedRow(), failedRow({ id: 'f'.repeat(64) })] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const boxes = await screen.findAllByRole('checkbox')
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])
    fireEvent.click(screen.getByRole('button', { name: '重试所选失败记录' }))
    expect(await screen.findByText('该记录没有保存来源文件，无法重试；该记录已不存在，列表已刷新')).toBeTruthy()
    expect(retries).toHaveBeenCalledTimes(2)
  })
})

describe('doc library pane (issue 97 index facts)', () => {
  it('annotates each registered record with its honest index state', async () => {
    stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [
      importRow({ index: indexView() }),
      importRow({ id: '9'.repeat(64), index: indexView({ state: 'missing', documents: 0, indexedDocuments: 0, servableDocuments: 0, builtAt: '' }) })
    ] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const statuses = await screen.findAllByTestId('doc-library-index-status')
    expect(statuses[0].textContent).toContain('检索索引就绪：2 个文件可全文检索')
    expect(statuses[1].textContent).toContain('未建检索索引')
  })

  it('says 已过期 with the drifted count on top of a ready index', async () => {
    stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [
      importRow({ index: indexView({ driftedDocuments: 1 }) })
    ] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const status = await screen.findByTestId('doc-library-index-status')
    expect(status.textContent).toContain('检索索引就绪：2 个文件可全文检索')
    expect(status.textContent).toContain('已过期：1 个文件已变更，重建后可恢复检索')
  })

  it('shows the running rebuild with its progress and an honest cancel', async () => {
    const { calls } = stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [importRow({ index: indexView() })],
      knowledgeIndexRebuild: indexJob() })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const status = await screen.findByTestId('doc-library-index-status')
    expect(status.textContent).toContain('检索索引重建中：已核对 1 / 2 个文件')
    fireEvent.click(screen.getByRole('button', { name: '取消索引重建' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'cancelKnowledgeIndexRebuild')).toBe(true))
  })

  it('starts the index rebuild through the trusted bridge with the frozen identity', async () => {
    const { calls } = stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [importRow({ index: indexView({ state: 'missing', documents: 0, indexedDocuments: 0, servableDocuments: 0, builtAt: '' }) })] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.click(await screen.findByRole('button', { name: '重建检索索引 ffffffff' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'rebuildKnowledgeIndex')).toBe(true))
    expect(calls.find((call) => call.method === 'rebuildKnowledgeIndex')?.args)
      .toEqual([KB, 'f'.repeat(64), 'b'.repeat(64)])
  })

  it('explains a failed rebuild with its fixed category and keeps 未建 distinct', async () => {
    stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [
      importRow({ index: indexView({ state: 'failed', error: 'KNOWLEDGE_INDEX_FAILED' }) }),
      importRow({ id: '9'.repeat(64), index: null })
    ] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const statuses = await screen.findAllByTestId('doc-library-index-status')
    expect(statuses[0].textContent).toContain('检索索引失败：KNOWLEDGE_INDEX_FAILED')
    expect(statuses[1].textContent).toContain('检索索引：状态未知')
  })
})

describe('doc library pane (issue 98 library search)', () => {
  it('searches one registered revision and displays citations down to page and table', async () => {
    const { calls } = stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [importRow()] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const input = await screen.findByRole('textbox', { name: '检索版本 ffffffff' })
    fireEvent.change(input, { target: { value: 'ALPHA' } })
    fireEvent.click(screen.getByRole('button', { name: '检索 ffffffff' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'knowledgeSearch')).toBe(true))
    expect(calls.find((call) => call.method === 'knowledgeSearch')?.args).toEqual([KB, 'f'.repeat(64), 'ALPHA'])
    const result = await screen.findByTestId('doc-library-search-result')
    // The citation chain on display: library revision, engine, hit locations.
    expect(result.textContent).toContain('检索“ALPHA” · 知识库 33333333-3333-4333-8333-333333333333 · 版本 R2 · 引擎 BM25 全文索引')
    expect(result.textContent).toContain('参与检索 2 / 2')
    expect(result.textContent).toContain('report.md · 第 4 页 · 行 2 · 表 2 · 指纹 cccccccccccc')
    expect(result.textContent).toContain('guide.md · 第 1 页 · 行 1 · 指纹 dddddddddddd')
    expect(result.textContent).toContain('alpha in table body')
    // The retrieval credentials close the chain, the audit record keeps it
    // queryable, and no physical path shows.
    expect(result.textContent).toContain('检索凭据：https://test.invalid · 用户 a@test.invalid · 设备 dev · 本机审计记录 444444444444…')
    expect(result.textContent).not.toMatch(/\\|workspace\/report/)
    expect(result.textContent).not.toContain('依据不完整')
  })

  it('marks incomplete evidence with the structured missing reasons instead of faking a full answer', async () => {
    stubIdeer()
    ;(window as unknown as { ideer: { knowledgeSearch: unknown } }).ideer.knowledgeSearch = vi.fn(() =>
      Promise.resolve(searchView({
        evidenceComplete: false, documentsMatched: 1, truncated: true,
        missing: [{ filename: 'report.md', reason: 'content_drift' }],
        chunks: [{ filename: 'guide.md', contentHash: 'd'.repeat(64), content: 'the launch code is ALPHA-7',
          position: { logicalPath: '/workspace/guide.md', line: 1, page: 1, table: null } }]
      })))
    statusFixture = runtimeStatus({ knowledgeImports: [importRow()] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.change(await screen.findByRole('textbox', { name: '检索版本 ffffffff' }), { target: { value: 'ALPHA' } })
    fireEvent.click(screen.getByRole('button', { name: '检索 ffffffff' }))
    const partial = await screen.findByTestId('doc-library-search-result')
    expect(partial.textContent).toContain('依据不完整：部分文档未能参与本次检索')
    expect(partial.textContent).toContain('未参与检索：report.md · 内容已变更（已过期）')
    expect(partial.textContent).toContain('命中数量达到上限，已截断显示')
    expect(partial.textContent).toContain('参与检索 1 / 2')
    expect(partial.textContent).toContain('the launch code is ALPHA-7')
    expect(partial.textContent).not.toContain('alpha in table body')
  })

  it('names truncation, not missing documents, when the cut alone broke completeness', async () => {
    stubIdeer()
    ;(window as unknown as { ideer: { knowledgeSearch: unknown } }).ideer.knowledgeSearch = vi.fn(() =>
      Promise.resolve(searchView({ evidenceComplete: false, truncated: true, missing: [] })))
    statusFixture = runtimeStatus({ knowledgeImports: [importRow()] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.change(await screen.findByRole('textbox', { name: '检索版本 ffffffff' }), { target: { value: 'ALPHA' } })
    fireEvent.click(screen.getByRole('button', { name: '检索 ffffffff' }))
    const cut = await screen.findByTestId('doc-library-search-result')
    // Every document participated; the honest banner names the cut, and the
    // document-missing wording stays out.
    expect(cut.textContent).toContain('依据不完整：命中数量达到上限，以下仅显示截断前的命中')
    expect(cut.textContent).not.toContain('部分文档未能参与本次检索')
    expect(cut.textContent).not.toContain('未参与检索：')
  })

  it('never claims a cut when completeness broke without one and without a missing row', async () => {
    stubIdeer()
    ;(window as unknown as { ideer: { knowledgeSearch: unknown } }).ideer.knowledgeSearch = vi.fn(() =>
      Promise.resolve(searchView({ evidenceComplete: false, truncated: false, missing: [] })))
    statusFixture = runtimeStatus({ knowledgeImports: [importRow()] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.change(await screen.findByRole('textbox', { name: '检索版本 ffffffff' }), { target: { value: 'ALPHA' } })
    fireEvent.click(screen.getByRole('button', { name: '检索 ffffffff' }))
    const unknown = await screen.findByTestId('doc-library-search-result')
    // The servability read failed: no document is nameable as missing and no
    // cut happened, so the banner must not claim either — it names the
    // unverifiable participation instead.
    expect(unknown.textContent).toContain('依据不完整')
    expect(unknown.textContent).toContain('无法确认')
    expect(unknown.textContent).not.toContain('命中数量达到上限')
    expect(unknown.textContent).not.toContain('部分文档未能参与本次检索')
    expect(unknown.textContent).not.toContain('未参与检索：')
  })

  it('explains a refused search through its fixed category', async () => {
    stubIdeer({ reject: 'KNOWLEDGE_SEARCH_REVISION_UNREGISTERED' })
    statusFixture = runtimeStatus({ knowledgeImports: [importRow()] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.change(await screen.findByRole('textbox', { name: '检索版本 ffffffff' }), { target: { value: 'ALPHA' } })
    fireEvent.click(screen.getByRole('button', { name: '检索 ffffffff' }))
    expect(await screen.findByTestId('doc-library-search-error').then((node) => node.textContent))
      .toContain('该版本已不在本机记录中，列表已刷新')
    // A refused search keeps no stale citation view on display.
    expect(screen.queryByTestId('doc-library-search-result')).toBeNull()
  })

  it('annotates a degraded literal answer with its visible fallback reason', async () => {
    stubIdeer()
    ;(window as unknown as { ideer: { knowledgeSearch: unknown } }).ideer.knowledgeSearch = vi.fn(() =>
      Promise.resolve(searchView({ engine: 'literal', fallbackReason: 'index-missing',
        chunks: [
          { filename: 'guide.md', contentHash: 'd'.repeat(64), content: 'the launch code is ALPHA-7',
            position: { logicalPath: '/workspace/guide.md', line: 1, page: null, table: null } }
        ] })))
    statusFixture = runtimeStatus({ knowledgeImports: [importRow()] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.change(await screen.findByRole('textbox', { name: '检索版本 ffffffff' }), { target: { value: 'ALPHA' } })
    fireEvent.click(screen.getByRole('button', { name: '检索 ffffffff' }))
    const degraded = await screen.findByTestId('doc-library-search-result')
    expect(degraded.textContent).toContain('引擎 字面扫描（降级） · 降级原因 index-missing')
    // No frozen anchor, no invented page number.
    expect(degraded.textContent).toContain('guide.md · 行 1 · 指纹 dddddddddddd')
  })
})
describe('doc library pane (issue 101 version semantics)', () => {
  it('marks historical versions and the user-confirmed 原件已不在 on the record', async () => {
    stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [
      importRow({ historical: true, supersededBy: 'e'.repeat(64), index: indexView() }),
      importRow({ id: '9'.repeat(64), revisionNo: 3, originalsMissing: true })
    ] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    const list = await screen.findByRole('list', { name: '导入记录列表' })
    expect(list.textContent).toContain('已完成：已登记版本 R2 · 2 个文件（历史版本）')
    expect(list.textContent).toContain('已完成：已登记版本 R3 · 2 个文件（原件已不在）')
    // The kept cache says it survives only until the user's cleanup (决策票
    // 62: 标过期并存至用户清理) — and a cleaned row carries no such promise,
    // because there is nothing kept.
    expect(list.textContent).toContain('检索索引就绪：2 个文件可全文检索（历史版本缓存，保留至用户清理）')
    expect(list.textContent).not.toContain('未建检索索引（历史版本缓存')
  }, 15000)

  it('expands the document list and deletes the selection through the trusted bridge', async () => {
    const { calls } = stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [importRow({ index: indexView() })] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.click(await screen.findByRole('button', { name: '管理文档 ffffffff' }))
    const documents = await screen.findByTestId('doc-library-documents')
    expect(documents.textContent).toContain('guide.md')
    expect(documents.textContent).toContain('notes.txt')
    expect(documents.textContent).toContain('删除=库新版本')
    // Refusing to select everything is honest: an empty successor library is
    // not a delete, it is dropping the record (the Runtime refuses it too).
    fireEvent.click(screen.getByRole('checkbox', { name: '选择文档 guide.md' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择文档 notes.txt' }))
    expect((screen.getByRole('button', { name: '删除所选文档' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择文档 notes.txt' }))
    fireEvent.click(screen.getByRole('button', { name: '删除所选文档' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'deleteKnowledgeDocuments')).toBe(true), { timeout: 5000 })
    // guide.md stays selected (notes.txt was toggled back off): the delete
    // names exactly the frozen hash of the document that leaves the library.
    expect(calls.find((call) => call.method === 'deleteKnowledgeDocuments')?.args)
      .toEqual([KB, 'f'.repeat(64), ['c'.repeat(64)]])
  }, 15000)

  it('offers the separate cleanup with the frozen identity and hides it once cleaned', async () => {
    const { calls } = stubIdeer()
    statusFixture = runtimeStatus({ knowledgeImports: [
      importRow({ index: indexView() }),
      importRow({ id: '9'.repeat(64), revisionNo: 3, originalsMissing: true })
    ] })
    render(<DocLibraryPane instanceId="kb-1" panelType="kb" />)
    fireEvent.click(await screen.findByRole('button', { name: '清理本机索引 ffffffff' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'cleanupKnowledgeRevision')).toBe(true), { timeout: 5000 })
    expect(calls.find((call) => call.method === 'cleanupKnowledgeRevision')?.args)
      .toEqual([KB, 'f'.repeat(64), 'b'.repeat(64)])
    // A cleaned revision offers no second cleanup — the marker is the fact.
    expect(screen.queryByRole('button', { name: '清理本机索引 99999999' })).toBeNull()
  }, 15000)
})

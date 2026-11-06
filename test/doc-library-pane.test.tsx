// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DocLibraryPane from '../src/renderer/src/dock/panels/docLibraryPane'
import type { DesktopStatus, KnowledgeFolderJobView, KnowledgeImportView, RuntimeStatus } from '../src/shared/desktop'

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
    })
  }
  return { calls }
}

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
})

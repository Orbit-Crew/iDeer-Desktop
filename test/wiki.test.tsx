import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import { WikiSection } from '../src/renderer/src/components/WikiSection'
import type { KnowledgeImportView, RuntimeStatus, WikiCommand, WikiPage, WikiView } from '../src/shared/desktop'

const KB = '33333333-3333-4333-8333-333333333333'
const REVISION = '77777777-7777-4777-8777-777777777777'
const DOCUMENT = '88888888-8888-4888-8888-888888888888'
const SECOND_DOCUMENT = '99999999-9999-4999-8999-999999999999'
const GUIDE_HASH = 'd49dc8f44a00d41f35848312a37ff85c21092efc38a78bbf0442cacd9d4c0783'

const wikiView: WikiView = {
  kbId: KB,
  revisionId: REVISION,
  revisionNo: 1,
  manifestHash: 'c'.repeat(64),
  status: 'completed',
  generated: 1,
  failed: 0,
  skipped: 0,
  pages: [
    { documentId: DOCUMENT, filename: 'guide.txt', title: '甲零件与乙组件', contentHash: GUIDE_HASH, status: 'completed', errorCode: '' }
  ]
}

const wikiPage: WikiPage = {
  kbId: KB,
  revisionId: REVISION,
  revisionNo: 1,
  manifestHash: 'c'.repeat(64),
  documentId: DOCUMENT,
  filename: 'guide.txt',
  title: '甲零件与乙组件',
  contentHash: GUIDE_HASH,
  status: 'completed',
  errorCode: '',
  body: '# 甲零件与乙组件\n\n甲零件属于乙组件，乙组件由甲零件与螺栓构成。'
}

const registeredImport: KnowledgeImportView = {
  id: 'import-1', kbId: KB, revisionId: REVISION, revisionNo: 1, manifestHash: 'c'.repeat(64),
  documentCount: 1, status: 'registered', errorCode: '', createdAt: '2026-10-27T00:00:00Z', documents: []
}

const runtimeStatus = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({ process: 'running', connection: 'connected', tasks: [], knowledgeImports: [registeredImport], ...overrides })

const renderSection = (overrides: {
  wiki?: WikiView | null
  page?: WikiPage | null
  runtime?: RuntimeStatus
  busy?: boolean
  error?: string
  onCommand?: (command: WikiCommand) => void
} = {}): string =>
  renderToStaticMarkup(
    <WikiSection
      runtime={overrides.runtime ?? runtimeStatus()}
      wiki={overrides.wiki === undefined ? wikiView : overrides.wiki}
      page={overrides.page === undefined ? null : overrides.page}
      busy={overrides.busy ?? false}
      error={overrides.error ?? ''}
      onCommand={overrides.onCommand ?? (() => {})}
    />
  )

describe('controlled wiki entry (#118)', () => {
  it('validates the wiki command before the owned Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-118/unused')
    for (const kbId of ['', 'not-a-uuid', `${KB}/extra`]) {
      await expect(runtime.knowledgeWiki({ action: 'view', kbId, revisionId: REVISION })).rejects.toThrow('KNOWLEDGE_WIKI_KB_INVALID')
    }
    for (const revisionId of ['', 'not-a-uuid', REVISION.slice(1)]) {
      await expect(runtime.knowledgeWiki({ action: 'view', kbId: KB, revisionId })).rejects.toThrow('KNOWLEDGE_WIKI_REVISION_INVALID')
    }
    for (const action of ['delete', 'locate', 'search', '']) {
      await expect(runtime.knowledgeWiki({ action: action as 'view', kbId: KB, revisionId: REVISION })).rejects.toThrow('KNOWLEDGE_WIKI_ACTION_INVALID')
    }
    for (const documentId of ['', 'doc/../escape', 'x'.repeat(65)]) {
      await expect(runtime.knowledgeWiki({ action: 'read', kbId: KB, revisionId: REVISION, documentId })).rejects.toThrow('KNOWLEDGE_WIKI_DOCUMENT_INVALID')
    }
    await expect(runtime.knowledgeWiki({ action: 'read', kbId: KB, revisionId: REVISION })).rejects.toThrow('KNOWLEDGE_WIKI_DOCUMENT_INVALID')
    // A well-formed command still needs the owned Runtime process.
    await expect(runtime.knowledgeWiki({ action: 'view', kbId: KB, revisionId: REVISION })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it('shows the page list with progress and frozen sources, never bodies', () => {
    const html = renderSection()
    expect(html).toContain('版本 R1 · 生成完成 · 成功 1 · 失败 0 · 跳过 0')
    expect(html).toContain('c'.repeat(64))
    expect(html).toContain('甲零件与乙组件 · 可阅读')
    expect(html).toContain(`来源 guide.txt · 文档指纹：${GUIDE_HASH}`)
    // The list never carries a page body; bodies come only from the read.
    expect(html).not.toContain('甲零件属于乙组件，乙组件由甲零件与螺栓构成。')
    // The entry offers exactly the account's registered revisions.
    expect(html).toContain('查看Wiki')
    expect(html).toContain('生成Wiki')
  })

  it('reads a completed page with its body and source digest', () => {
    const html = renderSection({ page: wikiPage })
    expect(html).toContain('页面正文')
    expect(html).toContain('甲零件与乙组件')
    expect(html).toContain('甲零件属于乙组件，乙组件由甲零件与螺栓构成。')
    expect(html).toContain('来源 guide.txt · 指纹 d49dc8f44a00')
  })

  it('keeps skips and partial failures visible instead of a complete wiki', () => {
    const partial: WikiView = {
      ...wikiView,
      status: 'partial',
      generated: 1,
      failed: 0,
      skipped: 1,
      pages: [
        wikiView.pages[0],
        { documentId: SECOND_DOCUMENT, filename: 'policy.txt', title: '', contentHash: 'e'.repeat(64), status: 'skipped', errorCode: 'GRAPH_CONTENT_DRIFTED' }
      ]
    }
    const html = renderSection({ wiki: partial })
    expect(html).toContain('版本 R1 · 部分完成 · 成功 1 · 失败 0 · 跳过 1')
    expect(html).toContain('部分页面未生成：缺失的页面不代表完整 Wiki')
    expect(html).toContain('已跳过：GRAPH_CONTENT_DRIFTED')
    // The completed page stays readable alongside the skipped one; the
    // skipped page offers no read entry.
    expect(html).toContain('阅读此页')
    const skippedIndex = html.indexOf('已跳过：GRAPH_CONTENT_DRIFTED')
    const readIndex = html.indexOf('aria-label="阅读页面 guide.txt"')
    expect(readIndex).toBeGreaterThan(-1)
    expect(html.indexOf('aria-label="阅读页面 policy.txt"')).toBe(-1)
    expect(skippedIndex).toBeGreaterThan(readIndex)
  })

  it('projects a failed or ungenerated page read as a warning without any body', () => {
    const failedPage: WikiPage = { ...wikiPage, status: 'failed', errorCode: 'WIKI_MODEL_OUTPUT_INVALID', body: '' }
    expect(renderSection({ page: failedPage })).toContain('此页不可阅读：失败：WIKI_MODEL_OUTPUT_INVALID')
    expect(renderSection({ page: failedPage })).not.toContain('甲零件属于乙组件')
  })

  it('offers no wiki entry for other accounts or unregistered revisions', () => {
    const empty = renderSection({ runtime: runtimeStatus({ knowledgeImports: [] }), wiki: null })
    expect(empty).toContain('当前账号与设备尚无可查看 Wiki 的已登记版本。')
    expect(empty).not.toContain('aria-label="查看Wiki')
    // Failed imports are never offered as wiki entries.
    const failed = renderSection({
      runtime: runtimeStatus({ knowledgeImports: [{ ...registeredImport, status: 'failed', errorCode: 'KNOWLEDGE_IMPORT_FILE_UNAVAILABLE' }] }),
      wiki: null
    })
    expect(failed).toContain('尚无可查看 Wiki 的已登记版本')
    expect(failed).not.toContain('aria-label="查看Wiki')
  })
})

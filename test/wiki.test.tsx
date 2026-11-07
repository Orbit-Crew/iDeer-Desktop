// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RuntimeProcess } from '../src/main/runtime'
import { WikiSection } from '../src/renderer/src/components/WikiSection'
import type { KnowledgeImportView, RuntimeStatus, WikiCommand, WikiNavigation, WikiNavigationPage, WikiPage, WikiView } from '../src/shared/desktop'

afterEach(cleanup)

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  }) as MediaQueryList)
})

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
  navigation?: WikiNavigation | null
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
      navigation={overrides.navigation === undefined ? null : overrides.navigation}
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
    // Issue #100: the source line names the document and its frozen
    // manifest position next to the digest.
    expect(html).toContain(`来源 guide.txt · 冻结位置 1/1 · 文档指纹：${GUIDE_HASH}`)
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

describe('wiki navigation index with links, backlinks, and associations (#119)', () => {
  const navigation: WikiNavigation = {
    ...wikiView,
    status: 'partial',
    generated: 1,
    failed: 0,
    skipped: 1,
    pages: [
      {
        documentId: DOCUMENT, filename: 'guide.txt', title: '甲零件与乙组件', contentHash: GUIDE_HASH, status: 'completed', errorCode: '',
        links: [{ documentId: SECOND_DOCUMENT, title: '', status: 'skipped' }],
        missingLinks: ['未登记的文档'],
        backlinks: []
      },
      {
        documentId: SECOND_DOCUMENT, filename: 'policy.txt', title: '', contentHash: 'e'.repeat(64), status: 'skipped', errorCode: 'GRAPH_CONTENT_DRIFTED',
        links: [],
        missingLinks: [],
        backlinks: [{ documentId: DOCUMENT, title: '甲零件与乙组件', status: 'completed' }]
      }
    ],
    associations: {
      status: 'partial',
      generated: 1,
      failed: 0,
      sources: [
        { documentId: DOCUMENT, filename: 'guide.txt', contentHash: GUIDE_HASH, status: 'completed', errorCode: '' },
        { documentId: SECOND_DOCUMENT, filename: 'policy.txt', contentHash: 'e'.repeat(64), status: 'skipped', errorCode: 'GRAPH_CONTENT_DRIFTED' }
      ],
      entities: [{ name: '乙组件', type: 'component', documentId: DOCUMENT, filename: 'guide.txt', contentHash: GUIDE_HASH }],
      relations: [{ source: '甲零件', target: '乙组件', relation: '构成', documentId: DOCUMENT, filename: 'guide.txt', contentHash: GUIDE_HASH }]
    }
  }

  it('accepts the navigate action at the owned Runtime seam and still refuses malformed commands', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-119/unused')
    // The navigate action is a well-formed command; it fails only because no
    // owned Runtime process is running.
    await expect(runtime.knowledgeWiki({ action: 'navigate', kbId: KB, revisionId: REVISION })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    for (const action of ['teleport', 'index', '']) {
      await expect(runtime.knowledgeWiki({ action: action as 'view', kbId: KB, revisionId: REVISION })).rejects.toThrow('KNOWLEDGE_WIKI_ACTION_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it('renders the navigation index with honest per-page statuses and offers the entry per registered revision', () => {
    const html = renderSection({ wiki: null, navigation })
    expect(html).toContain('aria-label="导航Wiki R1"')
    expect(html).toContain('版本 R1 · 导航索引 · 部分完成 · 成功 1 · 失败 0 · 跳过 1')
    expect(html).toContain('c'.repeat(64))
    expect(html).toContain('甲零件与乙组件 · 可阅读')
    expect(html).toContain('已跳过：GRAPH_CONTENT_DRIFTED')
    // The index never carries a page body; bodies come only from the read.
    expect(html).not.toContain('甲零件属于乙组件，乙组件由甲零件与螺栓构成。')
    // Without the index nothing navigation-shaped is rendered.
    expect(renderSection({ wiki: null })).not.toContain('导航索引 ·')
  })

  it('renders links and backlinks as page-to-page navigation and missing targets as explicit dead ends', () => {
    const html = renderSection({ wiki: null, navigation })
    expect(html).toContain('链接：')
    expect(html).toContain('反链：')
    // The completed target of the backlink is clickable for reading; the
    // link row into a skipped page only names its status, never a read entry.
    expect(html).toContain('aria-label="返回 甲零件与乙组件"')
    expect(html).toContain('aria-label="阅读页面 guide.txt"')
    expect(html).not.toContain('aria-label="前往')
    expect(html).toContain('（已跳过）')
    // A missing target stays an explicit dead end: it names the absent text
    // and can never be opened.
    expect(html).toContain('缺失目标：未登记的文档（未在此冻结版本中登记或生成，不可访问）')
    expect(html).not.toContain('aria-label="前往 未登记的文档"')
  })

  it('renders the association graph summary with frozen source coverage', () => {
    const html = renderSection({ wiki: null, navigation })
    expect(html).toContain('关联图')
    expect(html).toContain('部分完成 · 生成 1 · 失败 0 · 实体 1 · 关系 1')
    expect(html).toContain(`来源 guide.txt · 可阅读 · 文档指纹：${GUIDE_HASH}`)
    expect(html).toContain('来源 policy.txt · 已跳过：GRAPH_CONTENT_DRIFTED')
  })

  it('disables every navigation entry while a command is in flight', () => {
    const html = renderSection({ wiki: null, navigation, busy: true })
    expect(html).toContain('aria-label="导航Wiki R1"')
    expect(html).toContain('disabled')
    expect(html).not.toContain('aria-label="返回 甲零件与乙组件">')
  })
})

describe('wiki graph navigation with overview, neighborhood, clear, and rebuild (#100)', () => {
  const THIRD_DOCUMENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const pageA = (): WikiNavigationPage => ({
    documentId: DOCUMENT, filename: 'guide.txt', title: '甲零件与乙组件', contentHash: GUIDE_HASH, status: 'completed', errorCode: '',
    links: [{ documentId: SECOND_DOCUMENT, title: '乙组件', status: 'completed' }], missingLinks: [], backlinks: []
  })
  const pageB = (): WikiNavigationPage => ({
    documentId: SECOND_DOCUMENT, filename: 'bom.txt', title: '乙组件', contentHash: 'e'.repeat(64), status: 'completed', errorCode: '',
    links: [], missingLinks: [], backlinks: [{ documentId: DOCUMENT, title: '甲零件与乙组件', status: 'completed' }]
  })
  const pageC = (overrides: Partial<WikiNavigationPage> = {}): WikiNavigationPage => ({
    documentId: THIRD_DOCUMENT, filename: 'misc.txt', title: '无关页面', contentHash: 'f'.repeat(64), status: 'completed', errorCode: '',
    links: [], missingLinks: [], backlinks: [], ...overrides
  })
  const graphNavigation = (pages: WikiNavigationPage[]): WikiNavigation => ({
    ...wikiView, pages, status: 'completed', generated: pages.length, failed: 0, skipped: 0,
    associations: { status: 'not_generated', generated: 0, failed: 0, sources: [], entities: [], relations: [] }
  })

  const renderLive = (props: { wiki?: WikiView | null; navigation?: WikiNavigation | null; busy?: boolean; onCommand?: (command: WikiCommand) => void; onClear?: () => void } = {}) =>
    render(
      <WikiSection
        runtime={runtimeStatus()}
        wiki={props.wiki ?? null}
        navigation={props.navigation ?? null}
        page={null}
        busy={props.busy ?? false}
        error=""
        onCommand={props.onCommand ?? (() => {})}
        onClear={props.onClear}
      />
    )

  it('renders the overview canvas with every page, its status legend, and the frozen source positions', () => {
    const html = renderSection({ wiki: null, navigation: graphNavigation([pageA(), pageB(), pageC()]) })
    expect(html).toContain('概览')
    expect(html).toContain('邻域')
    expect(html).toContain('wiki 图导航')
    // Every page of the index is a node; the text index keeps the frozen
    // source position next to the digest.
    expect(html).toContain('页面节点 甲零件与乙组件')
    expect(html).toContain('页面节点 乙组件')
    expect(html).toContain('页面节点 无关页面')
    expect(html).toContain('来源 guide.txt · 冻结位置 1/3')
    expect(html).toContain('来源 misc.txt · 冻结位置 3/3')
    expect(html).toContain('可阅读')
    expect(html).toContain('已跳过')
  })

  it('reads a completed page when its node is clicked', () => {
    const onCommand = vi.fn()
    renderLive({ navigation: graphNavigation([pageA(), pageB(), pageC()]), onCommand })
    fireEvent.click(screen.getByLabelText('页面节点 甲零件与乙组件'))
    expect(onCommand).toHaveBeenCalledWith({ action: 'read', kbId: KB, revisionId: REVISION, documentId: DOCUMENT })
  })

  it('never opens a skipped page from the graph', () => {
    const onCommand = vi.fn()
    const skipped = pageC({ status: 'skipped', errorCode: 'GRAPH_CONTENT_DRIFTED' })
    renderLive({ navigation: graphNavigation([pageA(), pageB(), skipped]), onCommand })
    fireEvent.click(screen.getByLabelText('页面节点 无关页面'))
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('switches to the neighborhood of the selected page and leaves unrelated pages out', () => {
    const onCommand = vi.fn()
    renderLive({ navigation: graphNavigation([pageA(), pageB(), pageC()]), onCommand })
    fireEvent.click(screen.getByLabelText('页面节点 乙组件'))
    fireEvent.click(screen.getByText('邻域'))
    expect(screen.queryByLabelText('页面节点 无关页面')).toBeNull()
    expect(screen.getByLabelText('页面节点 乙组件')).toBeTruthy()
    expect(screen.getByLabelText('页面节点 甲零件与乙组件')).toBeTruthy()
  })

  it('says so on screen when the neighborhood bound truncates the closure', () => {
    const hub = pageA()
    const many: WikiNavigationPage[] = Array.from({ length: 70 }, (_, index) => ({
      documentId: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, '0')}`,
      filename: `f${index}.txt`, title: `页${index}`, contentHash: 'a'.repeat(64), status: 'completed', errorCode: '',
      links: [], missingLinks: [], backlinks: []
    }))
    for (const row of many) hub.links.push({ documentId: row.documentId, title: row.title, status: 'completed' })
    renderLive({ navigation: graphNavigation([hub, ...many]) })
    expect(screen.queryByText(/邻域已达 60 页上限/)).toBeNull()
    fireEvent.click(screen.getByText('邻域'))
    expect(screen.getByText(/邻域已达 60 页上限/)).toBeTruthy()
  })

  it('clears the derived wiki surface only behind an explicit confirm', async () => {
    const onClear = vi.fn()
    renderLive({ wiki: wikiView, onClear })
    fireEvent.click(screen.getByLabelText('清空Wiki展示状态'))
    fireEvent.click(await screen.findByText('确认清空'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('offers 重新生成 for a revision whose pages exist and 生成Wiki before that', () => {
    expect(renderSection({ wiki: wikiView })).toContain('aria-label="重新生成Wiki R1"')
    expect(renderSection({ wiki: wikiView })).toContain('重新生成')
    expect(renderSection({ wiki: null, navigation: null })).toContain('aria-label="生成Wiki R1"')
  })
})

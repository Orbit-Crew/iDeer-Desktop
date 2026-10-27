import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import { KnowledgeGraphSection } from '../src/renderer/src/components/KnowledgeGraphSection'
import type { KnowledgeGraphCommand, KnowledgeGraphView, KnowledgeImportView, RuntimeStatus } from '../src/shared/desktop'

const KB = '33333333-3333-4333-8333-333333333333'
const REVISION = '77777777-7777-4777-8777-777777777777'
const DOCUMENT = '88888888-8888-4888-8888-888888888888'
const GUIDE_HASH = 'd49dc8f44a00d41f35848312a37ff85c21092efc38a78bbf0442cacd9d4c0783'

const view: KnowledgeGraphView = {
  kbId: KB,
  revisionId: REVISION,
  revisionNo: 1,
  manifestHash: 'c'.repeat(64),
  status: 'completed',
  generated: 1,
  failed: 0,
  entities: [
    { name: '甲零件', type: '零件', documentId: DOCUMENT, filename: 'guide.txt' },
    { name: '乙组件', type: '组件', documentId: DOCUMENT, filename: 'guide.txt' }
  ],
  relations: [{ source: '甲零件', target: '乙组件', relation: '属于', documentId: DOCUMENT, filename: 'guide.txt' }],
  sources: [{ documentId: DOCUMENT, filename: 'guide.txt', contentHash: GUIDE_HASH, status: 'completed', errorCode: '' }]
}

const registeredImport: KnowledgeImportView = {
  id: 'import-1', kbId: KB, revisionId: REVISION, revisionNo: 1, manifestHash: 'c'.repeat(64),
  documentCount: 1, status: 'registered', errorCode: '', createdAt: '2026-10-27T00:00:00Z', documents: []
}

const runtimeStatus = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({ process: 'running', connection: 'connected', tasks: [], knowledgeImports: [registeredImport], ...overrides })

const lastCommand = (): { command: KnowledgeGraphCommand | null } => {
  const holder: { command: KnowledgeGraphCommand | null } = { command: null }
  return holder
}

describe('controlled knowledge-graph entry (#116)', () => {
  it('validates the graph command before the owned Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-116/unused')
    for (const kbId of ['', 'not-a-uuid', `${KB}/extra`]) {
      await expect(runtime.knowledgeGraph({ action: 'view', kbId, revisionId: REVISION })).rejects.toThrow('KNOWLEDGE_GRAPH_KB_INVALID')
    }
    for (const revisionId of ['', 'not-a-uuid', REVISION.slice(1)]) {
      await expect(runtime.knowledgeGraph({ action: 'view', kbId: KB, revisionId })).rejects.toThrow('KNOWLEDGE_GRAPH_REVISION_INVALID')
    }
    for (const action of ['delete', 'upload', '']) {
      await expect(runtime.knowledgeGraph({ action: action as 'view', kbId: KB, revisionId: REVISION })).rejects.toThrow('KNOWLEDGE_GRAPH_ACTION_INVALID')
    }
    for (const documentId of ['', 'source/../escape', 'x'.repeat(65)]) {
      await expect(runtime.knowledgeGraph({ action: 'locate', kbId: KB, revisionId: REVISION, documentId })).rejects.toThrow('KNOWLEDGE_GRAPH_DOCUMENT_INVALID')
    }
    // A well-formed command still needs the owned Runtime process.
    await expect(runtime.knowledgeGraph({ action: 'view', kbId: KB, revisionId: REVISION })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it('shows entities, the representative relation and sources bound to the frozen revision', () => {
    const commands = lastCommand()
    const html = renderToStaticMarkup(
      <KnowledgeGraphSection
        runtime={runtimeStatus()}
        graph={view}
        located={{}}
        busy={false}
        error=""
        onCommand={(command) => { commands.command = command }}
      />
    )
    // The representative relation is verifiable against the fixed material.
    expect(html).toContain('甲零件 —[属于]→ 乙组件')
    expect(html).toContain('来源：guide.txt')
    expect(html).toContain('甲零件（零件）')
    expect(html).toContain('生成完成')
    expect(html).toContain(GUIDE_HASH)
    // The entry offers exactly the account's registered revisions.
    expect(html).toContain(`R1 · ${KB}`)
    expect(html).toContain('查看图谱')
    expect(html).toContain('生成图谱')
    expect(commands.command).toBeNull()
  })

  it('locates an authorized source back to the workspace and reports drift honestly', () => {
    const commands = lastCommand()
    const html = renderToStaticMarkup(
      <KnowledgeGraphSection
        runtime={runtimeStatus()}
        graph={view}
        located={{ [DOCUMENT]: { kbId: KB, revisionId: REVISION, documentId: DOCUMENT, filename: 'guide.txt', logicalPath: '/workspace/work/guide.txt' } }}
        busy={false}
        error=""
        onCommand={(command) => { commands.command = command }}
      />
    )
    expect(html).toContain('本机位置：/workspace/work/guide.txt')
    expect(html).toContain('定位本机来源')

    const drifted = renderToStaticMarkup(
      <KnowledgeGraphSection
        runtime={runtimeStatus()}
        graph={view}
        located={{ [DOCUMENT]: { kbId: KB, revisionId: REVISION, documentId: DOCUMENT, missing: true, reason: 'content_drift' } }}
        busy={false}
        error=""
        onCommand={() => {}}
      />
    )
    expect(drifted).toContain('来源暂不可定位：content_drift')
  })

  it('keeps partial failures visible instead of a complete graph', () => {
    const partial: KnowledgeGraphView = {
      ...view,
      status: 'partial',
      generated: 1,
      failed: 1,
      sources: [
        view.sources[0],
        { documentId: '99999999-9999-4999-8999-999999999999', filename: 'policy.txt', contentHash: 'e'.repeat(64), status: 'failed', errorCode: 'GRAPH_CONTENT_DRIFTED' }
      ]
    }
    const html = renderToStaticMarkup(
      <KnowledgeGraphSection
        runtime={runtimeStatus()}
        graph={partial}
        located={{}}
        busy={false}
        error=""
        onCommand={() => {}}
      />
    )
    expect(html).toContain('部分完成')
    expect(html).toContain('部分文档生成失败：缺失的关系不代表完整图谱')
    expect(html).toContain('失败：GRAPH_CONTENT_DRIFTED')
    // The successful source stays readable alongside the failed one.
    expect(html).toContain('guide.txt · 已生成')
  })

  it('offers no graph entry for other accounts or unregistered revisions', () => {
    const empty = renderToStaticMarkup(
      <KnowledgeGraphSection
        runtime={runtimeStatus({ knowledgeImports: [] })}
        graph={null}
        located={{}}
        busy={false}
        error=""
        onCommand={() => {}}
      />
    )
    expect(empty).toContain('当前账号与设备尚无可查看图谱的已登记版本。')
    expect(empty).not.toContain('aria-label="查看图谱')
    // Failed imports are never offered as graph entries.
    const failed = renderToStaticMarkup(
      <KnowledgeGraphSection
        runtime={runtimeStatus({ knowledgeImports: [{ ...registeredImport, status: 'failed', errorCode: 'KNOWLEDGE_IMPORT_FILE_UNAVAILABLE' }] })}
        graph={null}
        located={{}}
        busy={false}
        error=""
        onCommand={() => {}}
      />
    )
    expect(failed).toContain('尚无可查看图谱的已登记版本')
    expect(failed).not.toContain('aria-label="查看图谱')
  })
})

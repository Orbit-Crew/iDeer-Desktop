import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

const KB = '33333333-3333-4333-8333-333333333333'

describe('explicit local knowledge import bridge', () => {
  it('validates the platform KB identity and picked paths before the Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-112/unused')
    for (const kbId of ['', 'not-a-uuid', `${KB}/extra`, KB.slice(1)]) {
      await expect(runtime.importKnowledge(kbId, ['C:/work/a.md'])).rejects.toThrow('KNOWLEDGE_IMPORT_KB_INVALID')
    }
    for (const paths of [[], new Array(201).fill('C:/w/a.md'), [''], ['C:/w/a.md', 7], [`C:/${'x'.repeat(33000)}/a.md`]]) {
      await expect(runtime.importKnowledge(KB, paths as string[])).rejects.toThrow('KNOWLEDGE_IMPORT_PATHS_INVALID')
    }
    // A well-formed import still needs the owned Runtime process.
    await expect(runtime.importKnowledge(KB, ['C:/work/a.md'])).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
    // A stopped Runtime has no import view; a running one starts empty.
    expect(runtime.status().knowledgeImports ?? []).toEqual([])
  })
  it.skipIf(process.platform !== 'win32')('delivers an explicit import through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-import-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(runtime.status().knowledgeImports).toEqual([])
      // The unauthenticated boundary rejects the import before any workspace
      // read or Server call; the fixed category crosses the bridge.
      await expect(runtime.importKnowledge(KB, [join(profile, 'never-selected.md')]))
        .rejects.toThrow('CHAT_UNAUTHENTICATED')
      // The refused attempt leaves no import display fact behind.
      expect(runtime.status().knowledgeImports).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

describe('doc library folder import and record management bridge (#96)', () => {
  it('validates the folder, cancel and record-management commands before the Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-96/unused')
    for (const kbId of ['', 'not-a-uuid', `${KB}/extra`, KB.slice(1)]) {
      await expect(runtime.importKnowledgeFolder(kbId, 'C:/work/library')).rejects.toThrow('KNOWLEDGE_IMPORT_KB_INVALID')
    }
    for (const folder of ['', `C:/${'x'.repeat(33000)}/library`]) {
      await expect(runtime.importKnowledgeFolder(KB, folder)).rejects.toThrow('KNOWLEDGE_IMPORT_PATHS_INVALID')
    }
    await expect(runtime.importKnowledgeFolder(KB, 'C:/work/library')).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.cancelKnowledgeFolder()).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
    // A stopped Runtime has no folder job; the doc library starts empty.
    expect(runtime.status().knowledgeFolderImport ?? null).toBeNull()
    for (const ids of [[], new Array(101).fill('a'.repeat(64)), [''], ['a'.repeat(65)], [7], ['a'.repeat(64), '']]) {
      await expect(runtime.deleteKnowledgeImports(ids as never)).rejects.toThrow('KNOWLEDGE_IMPORT_IDS_INVALID')
    }
    await expect(runtime.deleteKnowledgeImports(['a'.repeat(64)])).rejects.toThrow('RUNTIME_UNAVAILABLE')
    for (const id of ['', 'short', `${'a'.repeat(64)}x`, 7]) {
      await expect(runtime.retryKnowledgeImport(id as never)).rejects.toThrow('KNOWLEDGE_IMPORT_ID_INVALID')
    }
    await expect(runtime.retryKnowledgeImport('a'.repeat(64))).rejects.toThrow('RUNTIME_UNAVAILABLE')
  })

  it('validates the version-semantics commands (删除=库新版本, 清理) before the Runtime (#101)', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-101/unused')
    const HASH = 'a'.repeat(64)
    // The document-level delete names a bounded kb/revision and a bounded
    // list of frozen content hashes — anything else refuses before the wire.
    for (const kbId of ['', `C:/${'x'.repeat(33000)}`]) {
      await expect(runtime.deleteKnowledgeDocuments(kbId as never, 'rev', [HASH])).rejects.toThrow('KNOWLEDGE_INDEX_KB_INVALID')
    }
    for (const revisionId of ['', 'x'.repeat(65), 7]) {
      await expect(runtime.deleteKnowledgeDocuments(KB, revisionId as never, [HASH])).rejects.toThrow('KNOWLEDGE_INDEX_REVISION_INVALID')
    }
    for (const hashes of [[], new Array(201).fill(HASH), [''], ['not-a-hash'], [7]]) {
      await expect(runtime.deleteKnowledgeDocuments(KB, 'rev', hashes as never)).rejects.toThrow('KNOWLEDGE_DELETE_DOCUMENTS_INVALID')
    }
    await expect(runtime.deleteKnowledgeDocuments(KB, 'rev', [HASH])).rejects.toThrow('RUNTIME_UNAVAILABLE')
    // The cleanup names the frozen triple; a malformed manifest refuses.
    for (const kbId of ['', 'x'.repeat(65)]) {
      await expect(runtime.cleanupKnowledgeRevision(kbId as never, 'rev', HASH)).rejects.toThrow('KNOWLEDGE_INDEX_KB_INVALID')
    }
    for (const revisionId of ['', 'x'.repeat(65), 7]) {
      await expect(runtime.cleanupKnowledgeRevision(KB, revisionId as never, HASH)).rejects.toThrow('KNOWLEDGE_INDEX_REVISION_INVALID')
    }
    for (const manifestHash of ['', 'short', `${'a'.repeat(64)}x`, 7]) {
      await expect(runtime.cleanupKnowledgeRevision(KB, 'rev', manifestHash as never)).rejects.toThrow('KNOWLEDGE_INDEX_MANIFEST_INVALID')
    }
    await expect(runtime.cleanupKnowledgeRevision(KB, 'rev', HASH)).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('delivers folder import and record management through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-folder-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      // No confirmed workspace: the folder job refuses before any read; the
      // fixed category crosses the bridge and no job display fact appears.
      await expect(runtime.importKnowledgeFolder(KB, join(profile, 'library')))
        .rejects.toThrow('KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE')
      expect(runtime.status().knowledgeFolderImport ?? null).toBeNull()
      // Cancel without a job is an honest no-op; an unknown record refuses.
      await expect(runtime.cancelKnowledgeFolder()).resolves.toEqual({ canceled: true })
      await expect(runtime.deleteKnowledgeImports(['b'.repeat(64)])).resolves.toEqual({ deleted: 0 })
      await expect(runtime.retryKnowledgeImport('c'.repeat(64)))
        .rejects.toThrow('KNOWLEDGE_IMPORT_RECORD_NOT_FOUND')
      expect(runtime.status().knowledgeImports ?? []).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

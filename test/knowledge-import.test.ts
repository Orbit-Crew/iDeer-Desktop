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

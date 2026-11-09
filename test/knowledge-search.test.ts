import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

const KB = '33333333-3333-4333-8333-333333333333'
const REVISION = '44444444-4444-4444-8444-444444444444'

describe('user library search bridge (#98)', () => {
  it('validates the revision identity and the query before the Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-98/unused')
    for (const kbId of ['', 'not-a-uuid', `${KB}/extra`, KB.slice(1)]) {
      await expect(runtime.knowledgeSearch(kbId, REVISION, 'ALPHA')).rejects.toThrow('KNOWLEDGE_SEARCH_KB_INVALID')
    }
    for (const revisionId of ['', 'not-a-uuid', `${REVISION}/extra`]) {
      await expect(runtime.knowledgeSearch(KB, revisionId, 'ALPHA')).rejects.toThrow('KNOWLEDGE_SEARCH_REVISION_INVALID')
    }
    for (const query of ['', '   ', 'a\nb', 'x'.repeat(513)]) {
      await expect(runtime.knowledgeSearch(KB, REVISION, query)).rejects.toThrow('KNOWLEDGE_SEARCH_QUERY_INVALID')
    }
    // A well-formed search still needs the owned Runtime process.
    await expect(runtime.knowledgeSearch(KB, REVISION, 'ALPHA')).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('refuses before any file read through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-search-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      // The search is binding-scoped: a fresh profile has no retrieval
      // credentials, so the refusal names exactly that — no workspace read,
      // no Server call, and the fixed category crosses the bridge.
      await expect(runtime.knowledgeSearch(KB, REVISION, 'ALPHA'))
        .rejects.toThrow('KNOWLEDGE_SEARCH_IDENTITY_UNAVAILABLE')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

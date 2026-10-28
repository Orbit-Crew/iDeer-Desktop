import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

const KB = '33333333-3333-4333-8333-333333333333'
const REVISION = '44444444-4444-4444-8444-444444444444'

describe('explicit server publication bridge (#115)', () => {
  it('validates the platform identities and confirmation before the Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-115/unused')
    for (const kbId of ['', 'not-a-uuid', `${KB}/extra`, KB.slice(1)]) {
      await expect(runtime.publishKnowledge(kbId, REVISION, ['C:/work/a.md'], true)).rejects.toThrow('KNOWLEDGE_PUBLISH_KB_INVALID')
    }
    for (const revisionId of ['', 'not-a-uuid', REVISION.slice(1)]) {
      await expect(runtime.publishKnowledge(KB, revisionId, ['C:/work/a.md'], true)).rejects.toThrow('KNOWLEDGE_PUBLISH_REVISION_INVALID')
    }
    for (const confirmed of ['yes', 1, undefined]) {
      await expect(runtime.publishKnowledge(KB, REVISION, ['C:/work/a.md'], confirmed as boolean))
        .rejects.toThrow('KNOWLEDGE_PUBLISH_CONFIRMATION_INVALID')
    }
    for (const paths of [[], new Array(201).fill('C:/w/a.md'), [''], ['C:/w/a.md', 7], [`C:/${'x'.repeat(33000)}/a.md`]]) {
      await expect(runtime.publishKnowledge(KB, REVISION, paths as string[], false)).rejects.toThrow('KNOWLEDGE_PUBLISH_PATHS_INVALID')
    }
    // A well-formed preview still needs the owned Runtime process.
    await expect(runtime.publishKnowledge(KB, REVISION, ['C:/work/a.md'], false)).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
    // A stopped Runtime has no publication view; a running one starts empty.
    expect(runtime.status().knowledgePublications ?? []).toEqual([])
  })
  it.skipIf(process.platform !== 'win32')('refuses an unauthenticated publication through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-publish-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(runtime.status().knowledgePublications).toEqual([])
      // The unauthenticated boundary refuses the publication before any
      // workspace read or Server call; the fixed category crosses the bridge.
      await expect(runtime.publishKnowledge(KB, REVISION, [join(profile, 'never-selected.md')], false))
        .rejects.toThrow('CHAT_UNAUTHENTICATED')
      // The refused preview leaves no publication display fact behind.
      expect(runtime.status().knowledgePublications).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

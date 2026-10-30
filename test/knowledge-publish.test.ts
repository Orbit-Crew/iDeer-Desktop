import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
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
  it.skipIf(process.platform !== 'win32')('carries the real Server preview destination through Runtime to the Desktop (#42)', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-i42-publish-'))
    const work = mkdtempSync(join(tmpdir(), 'ideer-i42-work-'))
    writeFileSync(join(work, 'guide.md'), '# marker\nlocal bytes that now publish explicitly\n')
    const posts: string[] = []
    const platform = createServer((request, response) => {
      request.resume(); response.setHeader('Content-Type', 'application/json')
      const url = request.url ?? ''
      if (url === '/api/devices/login/start') { response.end(JSON.stringify({ login_id: 'publish-42' })); return }
      if (url.startsWith('/api/devices/')) {
        response.end(JSON.stringify({ account: { id: 'A', name: 'Synthetic A' }, device: { id: 'D', name: 'Synthetic D', owner_id: 'A' },
          business_token: 'synthetic-publish-business', session_token: 'synthetic-publish-device', session_id: 'session-D',
          server_public_key: 'synthetic-broker', business_expires_at: '2099-01-01T00:00:00+00:00' }))
        return
      }
      if (url === '/api/v1/auth/me') {
        response.end(JSON.stringify({ id: 'A', email: 'a@test.invalid', system_role: 'user', permissions: ['runs:create'] }))
        return
      }
      if (request.method === 'POST' && url.endsWith('/knowledge-revisions/local-imports')) {
        posts.push(url)
        // The Server's real registration shape (issue 112); the manifest hash
        // is the platform's own fact and is only shape-checked by the device.
        response.end(JSON.stringify({ id: REVISION, resource_id: KB, revision_no: 1, status: 'draft',
          manifest_hash: 'a'.repeat(64), document_count: 1 }))
        return
      }
      if (request.method === 'GET' && url.endsWith('/local-publication/preview')) {
        // The exact preview payload shape the Server sends (issue 115):
        // the destination carries `display_name`, not `displayName`.
        response.end(JSON.stringify({
          source: { resource_id: KB, revision_id: REVISION, revision_no: 1, manifest_hash: 'a'.repeat(64), document_count: 1 },
          documents: [{ document_id: 'doc-1', filename: 'guide.md', size_bytes: 49, mime_type: 'text/markdown', content_hash: 'b'.repeat(64) }],
          destination: { kind: 'server_copy', display_name: 'Team · 服务端副本 R1', slug: 'team-pub-r1',
            visibility: 'private', governance: 'visibility_application_required' },
          upload_policy: { requires_explicit_confirmation: true, device_kb_unchanged: true, two_way_sync: false }
        }))
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
    await new Promise<void>(done => platform.listen(0, '127.0.0.1', done))
    const address = platform.address()
    if (!address || typeof address === 'string') throw new Error('No fixture listener')
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    const config = join(profile, 'settings.json')
    try {
      await runtime.beginLogin(`http://127.0.0.1:${address.port}`, 'Synthetic D')
      await vi.waitFor(() => expect(runtime.status().login?.state).toBe('authenticated'), { timeout: 10000 })
      const scopeBefore = runtime.workspaceScope()
      execFileSync(resolve('.runtime/python.exe'), ['-I', '-c',
        "import sys;from pathlib import Path;from core.file_service import WorkspaceSelection;WorkspaceSelection(Path(sys.argv[1])).select(Path(sys.argv[2]),confirmed=True)",
        config, work], { encoding: 'utf8', windowsHide: true })
      // The Desktop learns the new scope through the Runtime's status push;
      // the pre-selection scope is also a 64-hex value, so wait for a change.
      await vi.waitFor(() => expect(runtime.workspaceScope()).not.toBe(scopeBefore), { timeout: 10000 })
      const registered = await runtime.importKnowledge(KB, [join(work, 'guide.md')])
      expect(registered.revisionId).toBe(REVISION)
      // The real chain: the Server's display_name preview → the Runtime seam →
      // the Electron parser that used to refuse it before the dialog opened.
      const preview = await runtime.publishKnowledge(KB, REVISION, [join(work, 'guide.md')], false)
      expect(preview.confirmed).toBe(false)
      if (preview.confirmed !== false) throw new Error('unreachable')
      expect(preview.destination.displayName).toBe('Team · 服务端副本 R1')
      expect(preview.destination.slug).toBe('team-pub-r1')
      expect(preview.destination.visibility).toBe('private')
      expect(preview.destination).not.toHaveProperty('display_name')
      // Read-only preview: the registration POST is the only write so far.
      expect(posts).toEqual([`/api/resources/${KB}/knowledge-revisions/local-imports`])
    } finally {
      await runtime.stop()
      execFileSync(resolve('.runtime/python.exe'), ['-I', '-c',
        "import sys;from core.settings import load_settings;from core.secrets import create_default_secret_store;s=load_settings(sys.argv[1]);store=create_default_secret_store();[store.delete(r) for r in [s.business_token_ref,s.session_token_ref,s.device_key_ref] if r.startswith('desktop-')]", config], { windowsHide: true })
      await new Promise<void>(done => platform.close(() => done()))
      rmSync(profile, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    }
  }, 60000)
})

import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('restricted templates bridge (#84)', () => {
  it('accepts only exact prompt-template plaza commands', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-84/unused')
    for (const command of [
      { action: 'publish' },
      { action: 'list', extra: 1 },
      { action: 'create', name: 'x' },
      { action: 'create', name: 'x', category: '', content: 'body', visibility: 'public' },
      { action: 'create', name: '', category: '', content: 'body' },
      { action: 'create', name: 'x', category: '', content: '   ' },
      { action: 'create', name: 'x'.repeat(201), category: '', content: 'body' },
      { action: 'update', templateId: 'x', visibility: 'public' },
      { action: 'update', templateId: 'x' },
      { action: 'update', templateId: 'bad id!', name: 'x' },
      { action: 'delete', templateId: 'bad id!' },
      { action: 'use', templateId: 'x', content: 'smuggled text' },
      { action: 'delete' }
    ]) {
      await expect(runtime.templates(JSON.parse(JSON.stringify(command)))).rejects.toThrow('TEMPLATE_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })
  it('carries no visibility field anywhere in the family', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-84/unused')
    // A create can never widen visibility: any extra key fails the exact
    // key-set check, so a private-by-default creation is structural.
    await expect(runtime.templates({ action: 'create', name: 't', category: 'c', content: 'b', visibility: 'public' }))
      .rejects.toThrow('TEMPLATE_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
  it.skipIf(process.platform !== 'win32')('returns an unauthenticated refusal through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-templates-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await expect(runtime.templates({ action: 'list' })).rejects.toThrow('CHAT_UNAUTHENTICATED')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

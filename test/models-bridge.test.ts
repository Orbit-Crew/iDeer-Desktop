import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('restricted models bridge', () => {
  it('accepts only exact model settings commands', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-73/unused')
    for (const command of [
      { action: 'install-provider' },
      { action: 'list', url: 'https://untrusted.invalid' },
      { action: 'set-default', modelName: 'x', baseUrl: 'https://untrusted.invalid' },
      { action: 'set-default', modelName: 5 },
      { action: 'set-fallback', modelName: 'x'.repeat(201) },
      { action: 'set-default' }
    ]) {
      await expect(runtime.models(JSON.parse(JSON.stringify(command)))).rejects.toThrow('MODEL_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects an over-long session model choice before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-73/unused')
    await expect(runtime.chat({ action: 'set-model', scope: 's', threadId: 't', modelName: 'x'.repeat(201) }))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
  it.skipIf(process.platform !== 'win32')('returns an unauthenticated model view through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-models-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await expect(runtime.models({ action: 'list' })).rejects.toThrow('CHAT_UNAUTHENTICATED')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

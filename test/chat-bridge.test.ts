import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('restricted chat bridge', () => {
  it('rejects malformed or broadened local write decisions before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-102/unused')
    for (const patch of [{ requestHash: 'wrong' }, { decision: 'always' }, { url: 'https://untrusted.invalid' }, { content: 'CHANGED' }]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ action: 'consent', scope: 'account', threadId: 'thread',
        runId: 'run', taskId: 'task', requestHash: 'a'.repeat(64), decision: 'allow', ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects arbitrary HTTP targets before starting a process', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-99/unused')
    await expect(runtime.chat(JSON.parse('{"action":"refresh","url":"https://untrusted.invalid","headers":{"Cookie":"secret"}}')))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
  it.skipIf(process.platform !== 'win32')('returns an unauthenticated state through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-chat-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      const snapshot = await runtime.chat({ action: 'refresh' })
      expect(snapshot.error).toBe('CHAT_UNAUTHENTICATED')
      expect(snapshot.scope).toBe('')
      expect(snapshot.messages).toEqual([])
      expect(snapshot.resources).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('restricted chat bridge', () => {
  it('accepts only an exact scoped stop command', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-104/unused')
    for (const patch of [{ runId: '' }, { url: 'https://untrusted.invalid' }, { action: 'cancel-all' }]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ action: 'stop', scope: 'A', threadId: 'thread', runId: 'run', ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })
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

describe('session tier commands (#74)', () => {
  it('lets a plain tier switch pass validation and fail only on the stopped runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-74/unused')
    await expect(runtime.chat({ action: 'tier', scope: 'A', threadId: 'thread', tier: 'autonomous' }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects malformed tier shapes before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-74/unused')
    for (const patch of [{ tier: 'unlimited' }, { tier: '' }, { extra: 'x' }, { tier: 3 }]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ action: 'tier', scope: 'A', threadId: 'thread', tier: 'autonomous', ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    // Only the main process may sign the full-tier confirm; a bare full
    // switch and a confirm on any other tier are both malformed.
    await expect(runtime.chat(JSON.parse(JSON.stringify({ action: 'tier', scope: 'A', threadId: 'thread', tier: 'full' }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    await expect(runtime.chat(JSON.parse(JSON.stringify({ action: 'tier', scope: 'A', threadId: 'thread', tier: 'autonomous', confirm: true }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    await expect(runtime.chat(JSON.parse(JSON.stringify({ action: 'tier', scope: 'A', threadId: 'thread', tier: 'full', confirm: false }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
  it('accepts the remembered script allow the renderer sends (#39)', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-39/unused')
    await expect(runtime.chat({ action: 'consent', scope: 'A', threadId: 'thread', runId: 'run', taskId: 'task',
      requestHash: 'a'.repeat(64), decision: 'allow', rememberScript: true }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'
import type { ChatAttachment } from '../src/shared/desktop'

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
      // Issue 76: the sub-agent ledger is part of every snapshot the real
      // bundled Runtime returns, so the structured progress has a wire.
      expect(snapshot.subagents).toEqual([])
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

describe('input command semantics on send (#75)', () => {
  const send = { action: 'send', scope: 'A', threadId: 'thread', turnId: 'turn', text: 'hello' }
  it('lets the plain send and the structured input commands pass validation', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-75/unused')
    // The plain send keeps its original shape; the @ delegation and the
    // mounted skills ride as optional structured facts, alone or together.
    await expect(runtime.chat({ ...send })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...send, delegateAgentId: 'agent-1' })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...send, skillIds: ['skill-1'] })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...send, delegateAgentId: 'agent-1', skillIds: ['skill-1', 'skill-2'] }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects malformed delegate agents before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-75/unused')
    for (const patch of [{ delegateAgentId: '' }, { delegateAgentId: 'bad id!' }, { delegateAgentId: 42 },
      { delegateAgentId: 'x'.repeat(129) }, { delegateAgentId: ['agent-1'] }]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ ...send, ...patch })))).rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects malformed mounted skill lists before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-75/unused')
    for (const patch of [
      { skillIds: [] }, { skillIds: 'skill-1' }, { skillIds: ['bad id!'] }, { skillIds: [42] },
      { skillIds: ['skill-1', 'skill-1'] },
      { skillIds: Array.from({ length: 9 }, (_, i) => `skill-${i}`) }
    ]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ ...send, ...patch })))).rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    // The structured facts ride the send action only.
    await expect(runtime.chat(JSON.parse(JSON.stringify({
      action: 'answer', scope: 'A', threadId: 'thread', turnId: 'turn', requestId: 'req', text: 'ok', skillIds: ['skill-1'] }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects a broadened send shape before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-75/unused')
    await expect(runtime.chat(JSON.parse(JSON.stringify({ ...send, url: 'https://untrusted.invalid' }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
})

describe('collab mode on send (#76)', () => {
  const send = { action: 'send', scope: 'A', threadId: 'thread', turnId: 'turn', text: 'hello' }
  it('lets the boolean collab switch pass validation and fail only on the stopped runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-76/unused')
    // false is the single-Agent mode (subagent_enabled=false); true is an
    // explicit keep-the-platform-default. Both ride the send command alone.
    await expect(runtime.chat({ ...send, collab: false })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...send, collab: true })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...send, delegateAgentId: 'agent-1', collab: false }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects malformed collab flags and other actions carrying it', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-76/unused')
    for (const patch of [{ collab: 'yes' }, { collab: 1 }, { collab: null }, { collab: ['false'] }]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ ...send, ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    // The collab switch rides the send action only.
    await expect(runtime.chat(JSON.parse(JSON.stringify({
      action: 'stop', scope: 'A', threadId: 'thread', runId: 'run', collab: false }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
})

describe('message-level branch on chat (#78)', () => {
  const branch = { action: 'branch', scope: 'A', threadId: 'thread', messageId: 'msg-1' }
  it('lets the plain branch and the full turn group pass validation', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-78/unused')
    // The renderer names the target turn only; the Runtime resolves the
    // branch on the platform Thread API and reopens the new Thread.
    await expect(runtime.chat({ ...branch })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...branch, messageIds: ['msg-1', 'msg-2'] }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects malformed branch targets before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-78/unused')
    for (const patch of [
      { messageId: '' }, { messageId: 'bad id!' }, { messageId: 42 }, { messageId: 'x'.repeat(129) },
      { messageIds: [] }, { messageIds: 'msg-1' }, { messageIds: ['bad id!'] },
      { messageIds: ['msg-1', 'msg-1'] },
      { messageIds: Array.from({ length: 65 }, (_, i) => `msg-${i}`) }
    ]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ ...branch, ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    // A title or any other content may not ride the branch command: the
    // Server's own default naming applies.
    await expect(runtime.chat(JSON.parse(JSON.stringify({ ...branch, title: '改名' }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    await expect(runtime.chat(JSON.parse(JSON.stringify({
      action: 'open', scope: 'A', threadId: 'thread', messageIds: ['msg-1'] }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
})

describe('attachment destinations (#93)', () => {
  const send = { action: 'send', scope: 'A', threadId: 'thread', turnId: 'turn', text: 'hello' }
  const view = { action: 'attachment-view', scope: 'A', threadId: 'thread', id: 'v1', path: 'C:/work/notes.txt', name: 'notes.txt' }
  const attachment: ChatAttachment = { id: 'a1', path: 'C:/work/notes.txt', name: 'notes.txt', destination: 'parsed-text' }
  it('lets the explicit destinations ride the send and the local view pass validation', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-93/unused')
    // The default parsed-text destination and the explicit upload original
    // both pass as structured facts; the standalone local-view command does
    // too. Nothing executes on a stopped runtime — the shape is what is
    // pinned here.
    await expect(runtime.chat({ ...send, attachments: [attachment] })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...send, attachments: [{ ...attachment, destination: 'upload' }] }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...send, attachments: [attachment, { ...attachment, id: 'a2', destination: 'upload' }] }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.chat({ ...view })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects malformed attachment lists before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-93/unused')
    for (const patch of [
      { attachments: [] }, { attachments: 'a1' }, { attachments: ['nope'] },
      { attachments: [{ ...attachment, id: '' }] }, { attachments: [{ ...attachment, id: 'x'.repeat(129) }] },
      { attachments: [{ ...attachment, path: '' }] }, { attachments: [{ ...attachment, path: 'p'.repeat(4097) }] },
      { attachments: [{ ...attachment, name: '' }] }, { attachments: [{ ...attachment, name: 'n'.repeat(257) }] },
      { attachments: [{ ...attachment, destination: 'local-view' }] }, { attachments: [{ ...attachment, destination: 'auto' }] },
      { attachments: [{ ...attachment, extra: 'x' }] },
      { attachments: [attachment, { ...attachment, name: 'b.txt' }] },
      { attachments: Array.from({ length: 9 }, (_, i) => ({ ...attachment, id: `a${i}` })) }
    ]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ ...send, ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    // The destinations ride the send action only; 仅本机查看 is its own
    // command and never hides inside an answer.
    await expect(runtime.chat(JSON.parse(JSON.stringify({
      action: 'answer', scope: 'A', threadId: 'thread', turnId: 'turn', requestId: 'req', text: 'ok',
      attachments: [attachment] }))))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    expect(runtime.status().process).toBe('stopped')
  })
  it('rejects malformed local-view commands before starting Runtime', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-93/unused')
    for (const patch of [
      { id: '' }, { id: 'x'.repeat(129) }, { id: 42 },
      { path: '' }, { path: 'p'.repeat(4097) },
      { name: '' }, { name: 'n'.repeat(257) }, { extra: 'x' }
    ]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ ...view, ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })
})

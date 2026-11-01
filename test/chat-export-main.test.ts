import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportChatTranscript } from '../src/main/chat-export'
import type { ChatCommand, ChatSnapshot } from '../src/shared/desktop'

const stateWith = (overrides: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  scope: 'scope-1',
  resources: [],
  threads: [{ id: 'thread-1', title: '结构计算助手', status: 'idle' }],
  thread: { id: 'thread-1', status: 'idle', agentId: 'agent-1', skillId: '' },
  messages: [
    { id: 'human-id-1', role: 'human', text: '请核对', name: '' },
    { id: 'ai-id-1', role: 'ai', text: '结论：成立。', name: '' }
  ],
  events: [], stream: 'idle', error: '', lastEventId: '',
  ...overrides
})

const at = new Date('2026-11-01T10:00:00')

describe('main-process conversation export (#79)', () => {
  const directories: string[] = []
  const scratch = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'issue79-export-'))
    directories.push(directory)
    return directory
  }
  afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
  })

  const run = async (state: ChatSnapshot, command: ChatCommand,
    destination: ((name: string) => Promise<string | undefined>) | string | undefined) => {
    const chat = vi.fn(async () => state)
    const chooser = typeof destination === 'function' ? vi.fn(destination)
      : vi.fn(async () => (typeof destination === 'string' ? destination : undefined))
    const result = await exportChatTranscript({ chat } as never, command as never, chooser as never, () => at)
    return { chat, chooser: chooser as (name: string) => Promise<string | undefined>, result }
  }

  it('writes the derived document after the native dialog and reports saved', async () => {
    const directory = scratch()
    const state = stateWith()
    const { chat, chooser, result } = await run(state,
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session' } as ChatCommand,
      async (name) => {
        expect(name).toMatch(/^结构计算助手-导出-\d{8}-\d{4}\.md$/)
        return join(directory, name)
      })
    // One state read before the dialog, one identity re-check after it — the
    // same discipline the artifact download uses.
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls.every(([command]) => (command as { action: string }).action === 'state')).toBe(true)
    expect(result.exportStatus).toBe('saved')
    expect(result.scope).toBe('scope-1')
    const written = readdirSync(directory)[0]
    expect(written).toMatch(/^结构计算助手-导出-\d{8}-\d{4}\.md$/)
    expect(readFileSync(join(directory, written), 'utf8')).toContain('结论：成立。')
    expect(chooser).toHaveBeenCalledOnce()
  })

  it('reports cancelled and writes nothing when the dialog is dismissed', async () => {
    const directory = scratch()
    const { chat, result } = await run(stateWith(),
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session' } as ChatCommand, undefined)
    expect(result.exportStatus).toBe('cancelled')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(readdirSync(directory)).toEqual([])
  })

  it('rejects malformed commands before touching the runtime or dialog', async () => {
    const chooser = vi.fn(async () => undefined)
    const runtime = { chat: vi.fn(async () => stateWith()) }
    const malformed = [
      undefined,
      { action: 'export', scope: 'scope-1', threadId: 'thread-1' },
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'everything' },
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session', extra: 1 },
      { action: 'export', scope: '', threadId: 'thread-1', mode: 'session' },
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'message' },
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'message', messageId: 7 },
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'message', messageId: 'x'.repeat(257) }
    ]
    for (const command of malformed) {
      await expect(exportChatTranscript(runtime as never, command as never, chooser, () => at))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    expect(runtime.chat).not.toHaveBeenCalled()
    expect(chooser).not.toHaveBeenCalled()
  })

  it('passes an errored runtime state through untouched', async () => {
    const errored = stateWith({ error: 'SERVER_UNREACHABLE', thread: null })
    const { result, chat } = await run(errored,
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session' } as ChatCommand, 'x.md')
    expect(result).toEqual(errored)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('refuses a thread other than the currently open one', async () => {
    await expect(run(stateWith(),
      { action: 'export', scope: 'scope-1', threadId: 'thread-other', mode: 'session' } as ChatCommand, 'x.md'))
      .rejects.toThrow('CHAT_EXPORT_SCOPE_CHANGED')
    await expect(run(stateWith(),
      { action: 'export', scope: 'scope-other', threadId: 'thread-1', mode: 'session' } as ChatCommand, 'x.md'))
      .rejects.toThrow('CHAT_EXPORT_SCOPE_CHANGED')
  })

  it('exports a single reply only by its own message id', async () => {
    const directory = scratch()
    const { result } = await run(stateWith(),
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'message', messageId: 'ai-id-1' } as ChatCommand,
      async (name) => {
        expect(name).toMatch(/^结构计算助手-单条回复-\d{8}-\d{4}\.md$/)
        return join(directory, name)
      })
    expect(result.exportStatus).toBe('saved')
    expect(readFileSync(join(directory, '结构计算助手-单条回复-20261101-1000.md'), 'utf8'))
      .toContain('结论：成立。')
  })

  it('refuses message targets that are missing or not replies', async () => {
    for (const messageId of ['missing-id', 'human-id-1']) {
      await expect(run(stateWith(),
        { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'message', messageId } as ChatCommand, 'x.md'))
        .rejects.toThrow('CHAT_EXPORT_TARGET_MISSING')
    }
  })

  it('maps an unwritable destination to an explicit save failure', async () => {
    const directory = scratch()
    const blocker = join(directory, 'file-blocks-the-way')
    writeFileSync(blocker, 'not a directory')
    await expect(run(stateWith(),
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session' } as ChatCommand,
      join(blocker, 'out.md')))
      .rejects.toThrow('CHAT_EXPORT_SAVE_FAILED')
    expect(readFileSync(blocker, 'utf8')).toBe('not a directory')
  })

  it('aborts when the identity changes while the dialog is pending', async () => {
    const directory = scratch()
    const state = stateWith()
    let dialogPending = false
    const chat = vi.fn(async () => (dialogPending ? stateWith({ scope: 'scope-2' }) : state))
    await expect(exportChatTranscript({ chat } as never,
      { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session' } as ChatCommand,
      async () => { dialogPending = true; return join(directory, 'out.md') }, () => at))
      .rejects.toThrow('CHAT_EXPORT_IDENTITY_CHANGED')
    expect(readdirSync(directory)).toEqual([])
  })

  it('sanitizes forbidden characters out of the suggested file name', async () => {
    const state = stateWith({ threads: [{ id: 'thread-1', title: '设计<复核>:方案/一?', status: 'idle' }] })
    const seen: string[] = []
    await run(state, { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session' } as ChatCommand,
      async (name) => { seen.push(name); return undefined })
    expect(seen[0]).not.toMatch(/[<>:"/\\|?*\x00-\x1f]/)
    expect(seen[0]).toContain('设计-复核-方案-一')
    expect(seen[0]).toMatch(/\.md$/)
  })

  it('keeps a directory destination writable repeatedly without clobber checks', async () => {
    const directory = scratch()
    const state = stateWith()
    // Two exports to the same path in one turn: the staged write uses wx on a
    // random temporary name and the final rename replaces the previous file.
    for (let i = 0; i < 2; i++) {
      const { result } = await run(state,
        { action: 'export', scope: 'scope-1', threadId: 'thread-1', mode: 'session' } as ChatCommand,
        join(directory, 'again.md'))
      expect(result.exportStatus).toBe('saved')
    }
    expect(readFileSync(join(directory, 'again.md'), 'utf8')).toContain('## Agent')
  })
})

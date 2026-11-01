import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('threads bridge contract (#72)', () => {
  it('accepts only the exact per-action shapes before any Runtime starts', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-72/unused')
    const longTitle = 'x'.repeat(201)
    const cases: unknown[] = [
      null,
      { action: 'archive' },
      { action: 'list', query: 'extra' },
      { action: 'search' },
      { action: 'search', query: 42 },
      { action: 'search', query: 'x'.repeat(129) },
      { action: 'search', query: 'ok', threadId: 'extra' },
      { action: 'rename', threadId: 'thread-A' },
      { action: 'rename', threadId: 'thread-A', title: '   ' },
      { action: 'rename', threadId: 'thread-A', title: longTitle },
      { action: 'rename', threadId: '../escape', title: 'ok' },
      { action: 'rename', threadId: 'thread-A', title: 'ok', extra: true },
      { action: 'delete' },
      { action: 'delete', threadId: 'bad id!' },
      { action: 'delete', threadId: 'thread-A', title: 'extra' }
    ]
    for (const command of cases) {
      await expect(runtime.threads(command as never)).rejects.toThrow('THREADS_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('rejects through the actual bundled Runtime with the fixed unauthenticated category', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-threads-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await expect(runtime.threads({ action: 'list' })).rejects.toThrow('CHAT_UNAUTHENTICATED')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

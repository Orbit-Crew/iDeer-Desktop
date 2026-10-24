import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

const UPLOAD = { action: 'upload', scope: 'A', threadId: 'thread', runId: 'run', taskId: 'task', decision: 'allow' } as const

describe('restricted local result upload bridge', () => {
  it('accepts only an exact explicit-allow upload command', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-105/unused')
    for (const patch of [{ decision: 'auto' }, { decision: 'allow-directory' }, { content: 'FORCED' }, { artifactId: 'art-1' }]) {
      await expect(runtime.chat(JSON.parse(JSON.stringify({ ...UPLOAD, ...patch }))))
        .rejects.toThrow('CHAT_COMMAND_INVALID')
    }
    await expect(runtime.chat(JSON.parse('{"action":"upload","scope":"A","threadId":"thread","runId":"run","taskId":"task"}')))
      .rejects.toThrow('CHAT_COMMAND_INVALID')
    // A well-formed allow upload still needs the owned Runtime process.
    await expect(runtime.chat({ ...UPLOAD })).rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })
  it.skipIf(process.platform !== 'win32')('delivers an allow upload through the actual bundled Runtime', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-upload-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      const snapshot = await runtime.chat({ ...UPLOAD, scope: '' })
      // The unauthenticated boundary rejects the upload before any Server call.
      expect(snapshot.error).toBe('CHAT_UNAUTHENTICATED')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

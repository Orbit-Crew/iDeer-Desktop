import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('projects bridge contract (#91)', () => {
  it('accepts only the exact per-action shapes before any Runtime starts', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-91/unused')
    const longName = 'x'.repeat(129)
    const cases: unknown[] = [
      null,
      { action: 'destroy' },
      { action: 'list', name: 'extra' },
      { action: 'create' },
      { action: 'create', name: '   ' },
      { action: 'create', name: longName },
      { action: 'create', name: 'ok', projectId: 'extra' },
      { action: 'rename', projectId: 'proj-1' },
      { action: 'rename', projectId: 'proj-1', name: '' },
      { action: 'rename', projectId: '../escape', name: 'ok' },
      { action: 'rename', projectId: 'proj-1', name: 'ok', extra: true },
      { action: 'archive' },
      { action: 'restore', projectId: 'bad id!' },
      { action: 'delete', projectId: 'proj-1', name: 'extra' }
    ]
    for (const command of cases) {
      await expect(runtime.projects(command as never)).rejects.toThrow('PROJECTS_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it('accepts only the exact bind-folder and unbind-folder shapes before any Runtime starts (#92)', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-92/unused')
    const longPath = 'C:\\' + 'x'.repeat(1024)
    // Invalid shapes are refused exactly like the #91 actions.
    const invalid: unknown[] = [
      { action: 'bind-folder' },
      { action: 'bind-folder', projectId: 'bad id!' },
      { action: 'bind-folder', projectId: 'proj-1', path: '' },
      { action: 'bind-folder', projectId: 'proj-1', path: longPath },
      { action: 'bind-folder', projectId: 'proj-1', path: 'C:\\ok', name: 'extra' },
      { action: 'unbind-folder' },
      { action: 'unbind-folder', projectId: 'bad id!' },
      { action: 'unbind-folder', projectId: 'proj-1', path: 'C:\\ok' }
    ]
    for (const command of invalid) {
      await expect(runtime.projects(command as never)).rejects.toThrow('PROJECTS_COMMAND_INVALID')
    }
    // The renderer never supplies a path: bind-folder's path is main-resolved
    // and the exact confirmed shape passes the gate, failing only because no
    // Runtime runs in this test.
    await expect(runtime.projects({ action: 'bind-folder', projectId: 'proj-1', path: 'C:\\work\\proj' }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    await expect(runtime.projects({ action: 'unbind-folder', projectId: 'proj-1' }))
      .rejects.toThrow('RUNTIME_UNAVAILABLE')
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('rejects through the actual bundled Runtime with the fixed unauthenticated category', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-projects-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await expect(runtime.projects({ action: 'list' })).rejects.toThrow('CHAT_UNAUTHENTICATED')
      // Issue 92: the binding actions ride the same envelope gate and the
      // same chat-session fence; binding read-write state is device-local.
      await expect(runtime.projects({ action: 'bind-folder', projectId: 'proj-1', path: 'C:\\work\\proj' }))
        .rejects.toThrow('CHAT_UNAUTHENTICATED')
      await expect(runtime.projects({ action: 'unbind-folder', projectId: 'proj-1' }))
        .rejects.toThrow('CHAT_UNAUTHENTICATED')
      // The snapshot carries the (empty) device-local binding view without
      // breaking the 0.5 s status parse.
      expect(runtime.status().process).toBe('running')
      expect(runtime.status().projectBindings).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

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

  it.skipIf(process.platform !== 'win32')('rejects through the actual bundled Runtime with the fixed unauthenticated category', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-projects-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      await expect(runtime.projects({ action: 'list' })).rejects.toThrow('CHAT_UNAUTHENTICATED')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

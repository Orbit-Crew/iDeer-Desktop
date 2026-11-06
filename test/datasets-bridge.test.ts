import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess } from '../src/main/runtime'

describe('datasets bridge contract (#102)', () => {
  it('accepts only the exact per-action shapes before any Runtime starts', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-102/unused')
    const cases: unknown[] = [
      null,
      { action: 'list' },
      { action: 'import' },
      { action: 'import', projectId: '' },
      { action: 'import', path: '', projectId: '' },
      { action: 'import', path: 'x'.repeat(32769), projectId: '' },
      { action: 'import', path: 'C:/t.csv', projectId: 'p'.repeat(129) },
      { action: 'import', path: 'C:/t.csv', projectId: 'bad id!' },
      { action: 'import', path: 'C:/t.csv', projectId: 'proj-1', extra: true },
      { action: 'delete' },
      { action: 'delete', datasetId: '' },
      { action: 'delete', datasetId: 'not-hex' },
      { action: 'delete', datasetId: 'f'.repeat(64), extra: true }
    ]
    for (const command of cases) {
      await expect(runtime.datasets(command as never)).rejects.toThrow('DATASETS_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('answers through the actual bundled Runtime with the fixed unauthenticated category and carries the new status field', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-datasets-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      // Device-local family: the workspace scope matches an unauthenticated
      // fresh profile, so the fence passes and the missing owner binding is
      // what answers — the honest category, before any file is read.
      await expect(runtime.datasets({ action: 'import', path: 'C:/nonexistent.csv', projectId: '' }))
        .rejects.toThrow('DATASETS_UNAUTHENTICATED')
      await expect(runtime.datasets({ action: 'delete', datasetId: 'f'.repeat(64) }))
        .rejects.toThrow('DATASETS_UNAUTHENTICATED')
      // The status snapshot's new field parsed without killing the child.
      expect(runtime.status().process).toBe('running')
      expect(runtime.status().datasets).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)
})

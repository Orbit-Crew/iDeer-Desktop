// Issue 92: the human terminal's start-dir chain — the selected project's
// bound folder first (起始输入), then the confirmed workspace locate, user
// home as the final fallback (decision #59.2). The path always resolves in
// the trusted main process from the Runtime's own binding snapshot: the
// renderer supplies an id selector only, never a path.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startDirForProject } from '../src/main/terminal'

const bindings = [
  { projectId: 'proj-1', path: 'C:\\work\\proj-1', deviceName: '本机设备', createdAt: '2026-11-01T00:00:00+00:00' },
  { projectId: 'proj-2', path: 'C:\\work\\gone', deviceName: '本机设备', createdAt: '2026-11-01T00:00:00+00:00' }
]

describe('terminal start dir chain (#92)', () => {
  it('prefers the selected project\'s bound folder when it still exists', async () => {
    const workspace = vi.fn(() => Promise.resolve('D:\\workspace'))
    expect(await startDirForProject('proj-1', bindings, workspace, () => true)).toBe('C:\\work\\proj-1')
    // A satisfied binding never consults the workspace locate.
    expect(workspace).not.toHaveBeenCalled()
  })

  it('falls through to the workspace when the bound folder disappeared from disk', async () => {
    const workspace = vi.fn(() => Promise.resolve('D:\\workspace'))
    expect(await startDirForProject('proj-2', bindings, workspace, () => false)).toBe('D:\\workspace')
    expect(workspace).toHaveBeenCalledTimes(1)
  })

  it('uses a real directory check: a bound folder replaced by a file falls through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ideer-start-dir-'))
    try {
      const replaced = join(dir, 'a-file.txt')
      writeFileSync(replaced, 'x', 'utf8')
      const asBindings = (path: string) =>
        [{ projectId: 'proj-1', path, deviceName: '本机设备', createdAt: '2026-11-01T00:00:00+00:00' }]
      const workspace = vi.fn(() => Promise.resolve('D:\\workspace'))
      // A file where the folder was: the stat-based check refuses it, so the
      // pty never receives a cwd that would fail opaquely.
      expect(await startDirForProject('proj-1', asBindings(replaced), workspace)).toBe('D:\\workspace')
      expect(await startDirForProject('proj-1', asBindings(dir), workspace)).toBe(dir)
      expect(workspace).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls through with no selection, an unknown project or an empty snapshot', async () => {
    const workspace = vi.fn(() => Promise.resolve('D:\\workspace'))
    await expect(startDirForProject('', bindings, workspace)).resolves.toBe('D:\\workspace')
    await expect(startDirForProject('proj-unknown', bindings, workspace)).resolves.toBe('D:\\workspace')
    await expect(startDirForProject('proj-1', undefined, workspace)).resolves.toBe('D:\\workspace')
    expect(workspace).toHaveBeenCalledTimes(3)
  })

  it('propagates the workspace refusal so the caller falls back to the user home', async () => {
    const workspace = vi.fn(() => Promise.reject(new Error('TERMINAL_START_DIR_UNAVAILABLE')))
    await expect(startDirForProject('proj-unknown', bindings, workspace)).rejects.toThrow('TERMINAL_START_DIR_UNAVAILABLE')
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess, toLegacyWorkspaceView, toMigrationLedgerView } from '../src/main/runtime'

describe('migration wizard bridge contract (#118)', () => {
  it('accepts only the exact per-action shapes before any Runtime starts', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-118/unused')
    const cases: unknown[] = [
      null,
      { action: 'list' },
      { action: 'destroy' },
      { action: 'scan', extra: true },
      { action: 'migrate' },
      { action: 'migrate', workspaceId: '' },
      { action: 'migrate', workspaceId: 'ws-a' },
      { action: 'migrate', workspaceId: 'ws-a', name: '   ' },
      { action: 'migrate', workspaceId: 'ws-a', name: 'x'.repeat(129), folder: '' },
      { action: 'migrate', workspaceId: 'ws-a', name: '结构仿真', folder: 'x'.repeat(1025) },
      { action: 'migrate', workspaceId: 'ws-a', name: '结构仿真', folder: 'C:/bind', bind: true },
      { action: 'migrate', workspaceId: 'ws-a', name: '结构仿真', folder: 'C:/bind', extra: 1 }
    ]
    for (const command of cases) {
      await expect(runtime.migration(command as never)).rejects.toThrow('MIGRATION_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('answers through the actual bundled Runtime with honest facts and the unauthenticated category', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-migration-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      // The scan is read-only and needs no owner binding, so an
      // unauthenticated fresh profile still gets the honest listing of
      // whatever this machine's %APPDATA%/linz holds (possibly nothing).
      const scan = await runtime.migration({ action: 'scan' }) as { root: string; workspaces: unknown[]; configError: string; truncated: boolean }
      expect(typeof scan.root).toBe('string')
      expect(Array.isArray(scan.workspaces)).toBe(true)
      expect(scan.configError).toBe('')
      expect(scan.truncated).toBe(false)
      // A migrate without an owner binding is refused before any platform
      // round-trip — the fixed category, never a guessed success.
      await expect(runtime.migration({ action: 'migrate', workspaceId: 'ws-a', name: '任意名', folder: '' }))
        .rejects.toThrow('MIGRATION_UNAUTHENTICATED')
      // The status snapshot's new fields parsed without killing the child.
      expect(runtime.status().process).toBe('running')
      expect(runtime.status().migrationLedger).toEqual([])
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)

  it('accepts the scan and ledger wire shapes instead of crash-looping the child', () => {
    // Fixtures mirror the Runtime's own scan rows and ledger view
    // (local-runtime/core/workspace_migration.py) field-for-field, exactly
    // as the desktop loop emits them. Evidence is stat-only presence and
    // size — the bytes never ride the wire.
    const scanRow = {
      id: 'ws-a', name: '结构仿真', folder: 'C:/data/结构仿真', current: true, orphan: false,
      createdAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-05T00:00:00.000Z',
      files: { data: { present: true, size: 33 }, kb: { present: false, size: 0 }, tables: { present: true, size: 11 } }
    }
    expect(toLegacyWorkspaceView(scanRow)).toEqual(scanRow)
    // An orphan dir without a roster entry still lists, nameless but honest.
    expect(toLegacyWorkspaceView({ ...scanRow, id: 'ws-orphan', name: '', folder: '', current: false,
      orphan: true, createdAt: '', lastOpenedAt: '' })).toEqual({ ...scanRow, id: 'ws-orphan', name: '',
      folder: '', current: false, orphan: true, createdAt: '', lastOpenedAt: '' })
    expect(() => toLegacyWorkspaceView({ ...scanRow, files: { ...scanRow.files, data: { present: true, size: -1 } } }))
      .toThrow('Invalid legacy workspace row')
    const ledgerRow = {
      workspaceId: 'ws-a', workspaceName: '结构仿真', projectId: 'proj-new-1', projectName: '结构仿真',
      folder: 'C:/bind', status: 'migrated', errorCode: '', createdAt: '2026-11-08T00:00:00', updatedAt: '2026-11-08T00:00:00'
    }
    expect(toMigrationLedgerView(ledgerRow)).toEqual(ledgerRow)
    // A failed row always names its fixed category; a migrated row carries
    // none — either half of that invariant is a protocol failure.
    expect(toMigrationLedgerView({ ...ledgerRow, status: 'failed', errorCode: 'CHAT_FORBIDDEN', projectId: '' })
      .status).toBe('failed')
    expect(() => toMigrationLedgerView({ ...ledgerRow, status: 'failed' })).toThrow('Invalid migration ledger row')
    expect(() => toMigrationLedgerView({ ...ledgerRow, errorCode: 'SHOULD_NOT_BE_HERE' }))
      .toThrow('Invalid migration ledger row')
  })
})

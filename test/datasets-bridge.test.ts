import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess, toDatasetView } from '../src/main/runtime'

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
      // Issue 101: the optional revision binding's malformed shapes refuse.
      { action: 'import', path: 'C:/t.csv', projectId: 'proj-1', kbId: '', revisionId: 'r', revisionNo: 1 },
      { action: 'import', path: 'C:/t.csv', projectId: 'proj-1', kbId: 'kb', revisionId: '', revisionNo: 1 },
      { action: 'import', path: 'C:/t.csv', projectId: 'proj-1', kbId: 'kb', revisionId: 'r', revisionNo: -1 },
      { action: 'import', path: 'C:/t.csv', projectId: 'proj-1', kbId: 'kb', revisionId: 'r', revisionNo: 1000001 },
      { action: 'import', path: 'C:/t.csv', projectId: 'proj-1', kbId: 'kb', revisionId: 'r' },
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

  it('accepts the registry\'s real failed-row wire shape instead of crash-looping the child', () => {
    // Regression (#102 review): a corrupt import records a failed row, and
    // that row rides BOTH the import reply and every 0.5 s status frame —
    // both under the runtime's protocol-failure kill switch. The fixtures
    // below mirror DatasetRegistry._view (local-runtime/core/datasets.py)
    // field-for-field, exactly as the desktop loop emits them.
    const recognizedFormat = {
      id: 'a'.repeat(64), filename: 'broken.xlsx', sourcePath: 'C:/data/broken.xlsx',
      format: 'xlsx', fileSha256: 'b'.repeat(64), sheets: [], rowCount: 0,
      projectId: 'proj-1', deviceId: 'device-102', status: 'failed',
      errorCode: 'DATASETS_PARSE_FAILED', createdAt: '2026-11-07T00:00:00'
    }
    expect(toDatasetView(recognizedFormat)).toEqual({
      ...recognizedFormat, format: 'xlsx', sheets: [], errorCode: 'DATASETS_PARSE_FAILED',
      // Issue 101: an unbound row reads as exactly null, never a made-up identity.
      revision: null
    })
    // A suffix that named no supported format is an honest '' — on failed rows only.
    const unknownFormat = { ...recognizedFormat, filename: 'legacy.xls', format: '',
      errorCode: 'DATASETS_FORMAT_UNSUPPORTED' }
    expect(toDatasetView(unknownFormat).format).toBe('')
    // A ready row can never lack its format: that shape stays a protocol failure.
    expect(() => toDatasetView({ ...recognizedFormat, status: 'ready', format: '', errorCode: '' }))
      .toThrow('Invalid dataset row')
    // The ready-row sheet shape carries the honest column-cut marker.
    const readyRow = {
      id: 'c'.repeat(64), filename: 'wide.csv', sourcePath: 'C:/data/wide.csv',
      format: 'csv', fileSha256: 'd'.repeat(64),
      sheets: [{ name: 'wide', fingerprint: 'e'.repeat(64), schema: 'c0:number',
        rowCount: 1, colCount: 128, truncated: false, columnsTruncated: true }],
      rowCount: 1, projectId: '', deviceId: 'device-102', status: 'ready',
      errorCode: '', createdAt: '2026-11-07T00:00:00'
    }
    expect(toDatasetView(readyRow).sheets[0].columnsTruncated).toBe(true)
    expect(() => toDatasetView({ ...readyRow, sheets: [
      { name: 'wide', fingerprint: 'e'.repeat(64), schema: '', rowCount: 1, colCount: 128,
        truncated: false }] })).toThrow('Invalid dataset sheet')
    // Issue 101: the revision binding parses exactly as recorded, and a
    // partial one degrades to unbound instead of inventing an identity.
    const bound = {
      ...readyRow,
      revision: { kbId: '33333333-3333-4333-8333-333333333333',
        revisionId: '77777777-7777-4777-8777-777777777777', revisionNo: 3 }
    }
    expect(toDatasetView(bound).revision).toEqual({
      kbId: '33333333-3333-4333-8333-333333333333',
      revisionId: '77777777-7777-4777-8777-777777777777', revisionNo: 3 })
    expect(toDatasetView({ ...bound, revision: { kbId: '', revisionId: 'r', revisionNo: 1 } }).revision).toBeNull()
    expect(toDatasetView({ ...bound, revision: 'not-an-object' }).revision).toBeNull()
  })
})

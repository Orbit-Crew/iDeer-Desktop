import { mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { RuntimeProcess, toSqlQueryResultView } from '../src/main/runtime'

describe('sql bridge contract (#103)', () => {
  it('accepts only the exact query shape before any Runtime starts', async () => {
    const runtime = new RuntimeProcess('.runtime', 'artifacts/issue-103/unused')
    const cases: unknown[] = [
      null,
      { action: 'list', datasetId: 'f'.repeat(64), sql: 'SELECT 1' },
      { action: 'query' },
      { action: 'query', datasetId: 'nothex', sql: 'SELECT 1' },
      { action: 'query', datasetId: 'F'.repeat(64), sql: 'SELECT 1' },
      { action: 'query', datasetId: 'f'.repeat(64) },
      { action: 'query', datasetId: 'f'.repeat(64), sql: '' },
      { action: 'query', datasetId: 'f'.repeat(64), sql: '   ' },
      { action: 'query', datasetId: 'f'.repeat(64), sql: 'x'.repeat(10001) },
      { action: 'query', datasetId: 7, sql: 'SELECT 1' },
      { action: 'query', datasetId: 'f'.repeat(64), sql: 'SELECT 1', extra: true }
    ]
    for (const command of cases) {
      await expect(runtime.sqlQuery(command as never)).rejects.toThrow('SQL_QUERY_COMMAND_INVALID')
    }
    expect(runtime.status().process).toBe('stopped')
  })

  it.skipIf(process.platform !== 'win32')('answers through the actual bundled Runtime with the fixed unauthenticated category', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ideer-sql-bridge-'))
    const runtime = new RuntimeProcess(resolve('.runtime'), profile)
    try {
      await runtime.start()
      const deadline = Date.now() + 15000
      while (runtime.status().process !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      // Device-local family: the workspace scope matches an unauthenticated
      // fresh profile, so the fence passes and the missing owner binding is
      // what answers — the honest category, before any file is read.
      await expect(runtime.sqlQuery({ action: 'query', datasetId: 'f'.repeat(64), sql: 'SELECT 1' }))
        .rejects.toThrow('SQL_QUERY_UNAUTHENTICATED')
      expect(runtime.status().process).toBe('running')
    } finally {
      await runtime.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  }, 30000)

  it('accepts the engine\'s real wire shape and rejects drift instead of crash-looping the child', () => {
    // The fixtures below mirror sql_query's reply (local-runtime/core/
    // sql_query.py) field-for-field, exactly as the desktop loop emits it:
    // bounded axes, honest cut markers, values the wire can carry honestly.
    const engineView = {
      tables: [
        { table: 'sheet1', name: '销售', columns: ['编号', '名称', '生效'] },
        { table: 'sheet2', name: '对照', columns: ['c1'] }
      ],
      columns: ['编号', 'sum(编号)'],
      rows: [[1, 3], [2, null], ['7', 6.5]],
      rowCount: 3,
      truncated: false,
      columnsTruncated: false,
      cellsTruncated: false
    }
    expect(toSqlQueryResultView(structuredClone(engineView))).toEqual(engineView)
    // A null cell is the engine's honest answer for NULL and for values the
    // wire cannot carry; a boolean or non-finite number never occurs — a
    // shape drift there is a protocol failure, not a display oddity.
    expect(() => toSqlQueryResultView({ ...engineView, rows: [[true]] }))
      .toThrow('Invalid sql result cell')
    expect(() => toSqlQueryResultView({ ...engineView, rows: [[Number.POSITIVE_INFINITY]] }))
      .toThrow('Invalid sql result cell')
    expect(() => toSqlQueryResultView({ ...engineView, rows: [{}] }))
      .toThrow('Invalid sql result row')
    expect(() => toSqlQueryResultView({ ...engineView, columns: ['ok', 42] }))
      .toThrow('Invalid sql result column')
    // The table name is the engine's deterministic sheetN registration; a
    // non-identifier name cannot come from it.
    expect(() => toSqlQueryResultView({ ...engineView, tables: [{ table: '1bad', name: 'x', columns: [] }] }))
      .toThrow('Invalid sql table map')
    expect(() => toSqlQueryResultView({ ...engineView, tables: [{ table: 'sheet1', name: 'x' }] }))
      .toThrow('Invalid sql table map')
    expect(() => toSqlQueryResultView({ ...engineView, truncated: 'no' }))
      .toThrow('Invalid sql result')
  })
})

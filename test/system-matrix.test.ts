import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateMatrix } from '../scripts/verify-system-matrix.cjs'

// The validator runs against in-memory fixtures with a fake path resolver so
// failure modes are exercised without touching the repository tree. The final
// two cases bind the shipped matrix (and its ledger lockstep) to the real
// checkout.
const existing = new Set([
  'docs/acceptance/issue-71/report.md',
  'docs/acceptance/capability-ledger.json',
  'test/dock-store.test.ts'
])
const resolvePath = (path: string) => existing.has(path)
const date = '2026-11-09'

function cell(status: string, overrides: Record<string, unknown> = {}) {
  return {
    status,
    evidence: [] as string[],
    entries: [{ kind: 'command', ref: 'npm run dist:win' }] as unknown[],
    lastVerified: null as string | null,
    note: null as string | null,
    ...overrides
  }
}

// status/evidence mirror the ledger row's candidateAcceptance so the lockstep
// check passes.
function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1-01',
    issue: 71,
    kind: '能力',
    name: 'Dock 多窗格框架',
    layers: {
      candidateAcceptance: { status: '未执行', evidence: ['docs/acceptance/issue-71/report.md'], lastVerified: date }
    },
    ...overrides
  }
}

function matrixRow(ledger: ReturnType<typeof ledgerRow>) {
  const candidate = ledger.layers.candidateAcceptance
  return {
    id: ledger.id,
    issue: ledger.issue,
    kind: ledger.kind,
    name: ledger.name,
    systems: {
      modernWindows: cell(candidate.status, {
        evidence: [...candidate.evidence],
        lastVerified: candidate.lastVerified,
        entries: [
          { kind: 'automated', ref: 'test/dock-store.test.ts' },
          { kind: 'command', ref: 'npm run dist:win' },
          { kind: 'manual', ref: '候选包安装后走查布局预设与重启恢复' }
        ]
      }),
      win7: cell('未执行', {
        entries: [
          { kind: 'scenario', ref: 'T131-06' },
          { kind: 'command', ref: 'npm run dist:win' }
        ]
      })
    }
  }
}

function governanceLedgerRow() {
  return ledgerRow({ id: 'p6-48', issue: 89, kind: '治理', name: '三层验收记账' })
}

function fixture() {
  const ledgerRows = [ledgerRow(), governanceLedgerRow()]
  const matrixRows = [
    matrixRow(ledgerRows[0]),
    {
      ...matrixRow(governanceLedgerRow()),
      systems: {
        modernWindows: cell('不适用', { entries: [], note: '记账框架自身，无候选安装面' }),
        win7: cell('不适用', { entries: [], note: '记账框架自身，无 Win7 场景' })
      }
    }
  ]
  return {
    matrix: baseMatrix(matrixRows),
    ledger: { version: 1, updated: date, capabilities: ledgerRows }
  }
}

function baseMatrix(rows: unknown[]) {
  return {
    version: 1,
    updated: date,
    frameworkDoc: 'docs/acceptance/issue-71/report.md',
    ledgerDoc: 'docs/acceptance/capability-ledger.json',
    systems: {
      modernWindows: { label: '现代 Windows', description: '开发与 CI 主环境的候选验收列' },
      win7: { label: 'Windows 7', description: '退役目标真机的专项验收列' }
    },
    capabilities: rows
  }
}

function check(matrix: unknown, ledger: unknown): string[] {
  return validateMatrix(matrix, ledger, resolvePath).findings
}

describe('system matrix validator', () => {
  it('accepts a complete fixture covering every ledger row', () => {
    const { matrix, ledger } = fixture()
    const result = validateMatrix(matrix, ledger, resolvePath)
    expect(result.findings).toEqual([])
    expect(result.counts.rows).toBe(2)
    expect(result.counts.modernAccepted).toBe(0)
    expect(result.counts.win7Accepted).toBe(0)
    // The capability row is short of acceptance; the governance row never
    // counts towards the below-bar list.
    expect(result.counts.belowBar).toEqual(['p1-01 Dock 多窗格框架'])
  })

  it('rejects top-level shape deviations and the wrong ledger lockstep file', () => {
    const { matrix, ledger } = fixture()
    expect(check({ ...matrix, version: 2 }, ledger)[0]).toContain('matrix.version must be 1')
    const noKey = { ...matrix } as Record<string, unknown>
    delete noKey.systems
    expect(check(noKey, ledger)[0]).toContain('matrix keys')
    expect(check({ ...matrix, updated: '2026-11-9' }, ledger)[0]).toContain('matrix.updated must be a YYYY-MM-DD date')
    expect(check({ ...matrix, ledgerDoc: 'docs/acceptance/other-ledger.json' }, ledger)[0]).toContain(
      'matrix.ledgerDoc must be docs/acceptance/capability-ledger.json'
    )
    expect(check({ ...matrix, frameworkDoc: 'docs/gone.md' }, ledger)[0]).toContain('frameworkDoc does not exist')
    expect(check({ ...matrix, systems: { modernWindows: { label: 'x', description: 'y' } } }, ledger)[0]).toContain(
      'systems keys must be exactly modernWindows, win7'
    )
  })

  it('requires exactly the ledger row set: no missing, unknown or duplicate rows', () => {
    const { matrix, ledger } = fixture()
    const short = baseMatrix([matrix.capabilities[0]])
    expect(check(short, ledger).join('\n')).toContain('matrix is missing ledger row for issue 89')
    const ghostLedger = ledgerRow({ id: 'p9-99', issue: 999, kind: '能力', name: '幽灵行' })
    const extra = baseMatrix([...matrix.capabilities, matrixRow(ghostLedger)])
    expect(check(extra, ledger).join('\n')).toContain('matrix row issue 999 is not present in capability ledger')
    const dup = baseMatrix([matrix.capabilities[0], matrix.capabilities[0]])
    expect(check(dup, ledger).join('\n')).toContain('duplicate matrix row issue 71')
  })

  it('pins row identity (id/kind/name) to the ledger row', () => {
    const { matrix, ledger } = fixture()
    const drifted = JSON.parse(JSON.stringify(matrix))
    drifted.capabilities[0].name = '改名后的能力'
    expect(check(drifted, ledger).join('\n')).toContain('matrix row issue 71 name must match ledger')
    const wrongKind = JSON.parse(JSON.stringify(matrix))
    wrongKind.capabilities[0].kind = '治理'
    expect(check(wrongKind, ledger).join('\n')).toContain('matrix row issue 71 kind must match ledger')
    const wrongId = JSON.parse(JSON.stringify(matrix))
    wrongId.capabilities[0].id = 'p9-01'
    expect(check(wrongId, ledger).join('\n')).toContain('matrix row issue 71 id must match ledger')
  })

  it('closes the status vocabulary and cell key set for both system cells', () => {
    const { matrix, ledger } = fixture()
    const bad = JSON.parse(JSON.stringify(matrix))
    bad.capabilities[0].systems.modernWindows.status = '差不多'
    expect(check(bad, ledger).join('\n')).toContain('modernWindows status must be one of')
    const badWin7 = JSON.parse(JSON.stringify(matrix))
    badWin7.capabilities[0].systems.win7.status = '通过'
    expect(check(badWin7, ledger).join('\n')).toContain('win7 status must be one of')
    const extraKey = JSON.parse(JSON.stringify(matrix))
    extraKey.capabilities[0].systems.win7.mood = '乐观'
    expect(check(extraKey, ledger).join('\n')).toContain(
      'issue 71 win7 keys must be exactly status, evidence, entries, lastVerified, note'
    )
  })

  it('requires evidence, entries and a date for accepted states, with existing repo-relative paths', () => {
    const { matrix, ledger } = fixture()
    const accepted = JSON.parse(JSON.stringify(matrix))
    accepted.capabilities[0].systems.modernWindows = cell('已验收', {
      note: '与账本候选层分歧：新候选报告已落地',
      evidence: [],
      entries: [],
      lastVerified: null
    })
    const findings = check(accepted, ledger).join('\n')
    expect(findings).toContain('issue 71 modernWindows 已验收 needs at least one evidence path')
    expect(findings).toContain('issue 71 modernWindows 已验收 needs at least one execution entry')
    expect(findings).toContain('issue 71 modernWindows 已验收 needs lastVerified as YYYY-MM-DD')
    const missingPath = JSON.parse(JSON.stringify(matrix))
    missingPath.capabilities[0].systems.modernWindows.evidence = ['docs/acceptance/nope.md']
    missingPath.capabilities[0].systems.modernWindows.lastVerified = date
    expect(check(missingPath, ledger).join('\n')).toContain('evidence path does not exist: docs/acceptance/nope.md')
    const backslash = JSON.parse(JSON.stringify(matrix))
    backslash.capabilities[0].systems.modernWindows.evidence = ['docs\\other.md']
    backslash.capabilities[0].systems.modernWindows.lastVerified = date
    expect(check(backslash, ledger).join('\n')).toContain('evidence path must be repository-relative')
  })

  it('requires entries for 未执行 cells and validates their optional tracking evidence', () => {
    const { matrix, ledger } = fixture()
    const bare = JSON.parse(JSON.stringify(matrix))
    bare.capabilities[0].systems.modernWindows.entries = []
    expect(check(bare, ledger).join('\n')).toContain('issue 71 modernWindows 未执行 needs at least one execution entry')
    const staleEvidence = JSON.parse(JSON.stringify(matrix))
    staleEvidence.capabilities[0].systems.win7.evidence = ['docs/gone.md']
    expect(check(staleEvidence, ledger).join('\n')).toContain('evidence path does not exist: docs/gone.md')
    const badDate = JSON.parse(JSON.stringify(matrix))
    badDate.capabilities[0].systems.win7.lastVerified = '2026-02-30'
    expect(check(badDate, ledger).join('\n')).toContain('issue 71 win7 未执行 needs lastVerified as YYYY-MM-DD')
  })

  it('keeps 未记录 honest: zero evidence, no date, but a registered execution entry', () => {
    const { matrix, ledger } = fixture()
    const unrecorded = JSON.parse(JSON.stringify(matrix))
    unrecorded.capabilities[0].systems.modernWindows.status = '未记录'
    unrecorded.capabilities[0].systems.modernWindows.evidence = ['docs/acceptance/issue-71/report.md']
    unrecorded.capabilities[0].systems.modernWindows.lastVerified = date
    unrecorded.capabilities[0].systems.modernWindows.note = '与账本候选层分歧：说明原因'
    const findings = check(unrecorded, ledger).join('\n')
    expect(findings).toContain('issue 71 modernWindows 未记录 must carry no evidence')
    expect(findings).toContain('issue 71 modernWindows 未记录 must carry no lastVerified')
    const noEntry = JSON.parse(JSON.stringify(matrix))
    noEntry.capabilities[0].systems.modernWindows.status = '未记录'
    noEntry.capabilities[0].systems.modernWindows.note = '与账本候选层分歧：说明原因'
    noEntry.capabilities[0].systems.modernWindows.entries = []
    expect(check(noEntry, ledger).join('\n')).toContain('issue 71 modernWindows 未记录 needs at least one execution entry')
    // a non-array evidence value is a violation too, never a silent pass
    const notArray = JSON.parse(JSON.stringify(matrix))
    notArray.capabilities[0].systems.modernWindows.status = '未记录'
    notArray.capabilities[0].systems.modernWindows.note = '与账本候选层分歧：说明原因'
    notArray.capabilities[0].systems.modernWindows.evidence = 'docs/acceptance/issue-71/report.md'
    expect(check(notArray, ledger).join('\n')).toContain('issue 71 modernWindows 未记录 must carry no evidence')
  })

  it('reserves 不适用 for governance rows, demands a note, and guards Win7 能力 exclusations with evidence', () => {
    const { matrix, ledger } = fixture()
    // A capability row may never opt out on modern Windows — it must be
    // attempted there first.
    const modernNa = JSON.parse(JSON.stringify(matrix))
    modernNa.capabilities[0].systems.modernWindows = cell('不适用', { entries: [], note: '无从执行' })
    expect(check(modernNa, ledger).join('\n')).toContain('issue 71 modernWindows 不适用 is reserved for 治理 rows')
    // On Win7 the issue allows per-item exclusation, but only with the
    // in-tree incompatibility analysis attached (不硬凑).
    const win7Na = JSON.parse(JSON.stringify(matrix))
    win7Na.capabilities[0].systems.win7 = cell('不适用', { entries: [], note: '无从执行' })
    const win7Findings = check(win7Na, ledger).join('\n')
    expect(win7Findings).toContain('issue 71 win7 能力行 不适用 needs in-tree incompatibility evidence')
    expect(win7Findings).not.toContain('is reserved for 治理 rows')
    const noNote = JSON.parse(JSON.stringify(matrix))
    noNote.capabilities[1].systems.win7.note = null
    expect(check(noNote, ledger).join('\n')).toContain('issue 89 win7 不适用 needs a note stating the reason')
  })

  it('locks the modern column to the ledger candidate layer unless a note explains the divergence', () => {
    const { matrix, ledger } = fixture()
    const diverged = JSON.parse(JSON.stringify(matrix))
    diverged.capabilities[0].systems.modernWindows.status = '未记录'
    diverged.capabilities[0].systems.modernWindows.evidence = []
    diverged.capabilities[0].systems.modernWindows.lastVerified = null
    expect(check(diverged, ledger).join('\n')).toContain(
      'issue 71 modernWindows status diverges from the ledger candidate layer (未执行) without a note'
    )
    diverged.capabilities[0].systems.modernWindows.note = '账本更新滞后，2026-11-09 报告已记录该非执行事实'
    expect(check(diverged, ledger)).toEqual([])
  })

  it('demands a T131/W7 scenario entry on every open Win7 cell', () => {
    const { matrix, ledger } = fixture()
    const noScenario = JSON.parse(JSON.stringify(matrix))
    noScenario.capabilities[0].systems.win7.entries = [{ kind: 'command', ref: 'npm run dist:win' }]
    expect(check(noScenario, ledger).join('\n')).toContain('issue 71 win7 未执行 needs at least one T131/W7 scenario entry')
    const badScenario = JSON.parse(JSON.stringify(matrix))
    badScenario.capabilities[0].systems.win7.entries = [
      { kind: 'scenario', ref: 'T131-998' },
      { kind: 'command', ref: 'npm run dist:win' }
    ]
    const scenarioFindings = check(badScenario, ledger).join('\n')
    expect(scenarioFindings).toContain('scenario ref must be a known T131-01..08 or W7-01..08 id: T131-998')
    // shape-valid but unknown ids are fabricated anchors: flagged too
    const unknownScenario = JSON.parse(JSON.stringify(matrix))
    unknownScenario.capabilities[0].systems.win7.entries = [
      { kind: 'scenario', ref: 'T131-09' },
      { kind: 'command', ref: 'npm run dist:win' }
    ]
    expect(check(unknownScenario, ledger).join('\n')).toContain(
      'scenario ref must be a known T131-01..08 or W7-01..08 id: T131-09'
    )
  })

  it('validates entry shapes: kinds, existing automated paths, command whitelist, manual bounds', () => {
    const { matrix, ledger } = fixture()
    const badKind = JSON.parse(JSON.stringify(matrix))
    badKind.capabilities[0].systems.modernWindows.entries[0].kind = 'sometimes'
    expect(check(badKind, ledger).join('\n')).toContain('entry kind must be one of automated/manual/scenario/command: sometimes')
    const missingAuto = JSON.parse(JSON.stringify(matrix))
    missingAuto.capabilities[0].systems.modernWindows.entries[0].ref = 'test/gone.test.ts'
    expect(check(missingAuto, ledger).join('\n')).toContain('automated entry path does not exist: test/gone.test.ts')
    const offWhitelist = JSON.parse(JSON.stringify(matrix))
    offWhitelist.capabilities[0].systems.modernWindows.entries[1].ref = 'npm run dream'
    expect(check(offWhitelist, ledger).join('\n')).toContain('command entry is not whitelisted: npm run dream')
    const longManual = JSON.parse(JSON.stringify(matrix))
    longManual.capabilities[0].systems.modernWindows.entries[2].ref = '走'.repeat(161)
    expect(check(longManual, ledger).join('\n')).toContain('manual entry must be 1-160 characters')
    const extraKey = JSON.parse(JSON.stringify(matrix))
    extraKey.capabilities[0].systems.modernWindows.entries[0].note = 'x'
    expect(check(extraKey, ledger).join('\n')).toContain('entry keys must be exactly kind, ref')
  })

  it('computes belowBar per row: any capability short of 已验收 on both systems', () => {
    const { matrix, ledger } = fixture()
    const allAccepted = JSON.parse(JSON.stringify(matrix))
    for (const row of allAccepted.capabilities) {
      row.systems.modernWindows = cell('已验收', {
        evidence: ['docs/acceptance/issue-71/report.md'],
        entries: [{ kind: 'scenario', ref: 'T131-06' }],
        lastVerified: date,
        note: '与账本候选层分歧：新候选报告已落地'
      })
      row.systems.win7 = cell('已验收', {
        evidence: ['docs/acceptance/issue-71/report.md'],
        entries: [{ kind: 'scenario', ref: 'T131-06' }],
        lastVerified: date
      })
    }
    const result = validateMatrix(allAccepted, ledger, resolvePath)
    expect(result.findings).toEqual([])
    expect(result.counts.belowBar).toEqual([])
    // only capability rows count towards the 已验收 story; the governance
    // row (p6-48) is excluded even when its cells say 已验收
    expect(result.counts.modernAccepted).toBe(1)
    expect(result.counts.win7Accepted).toBe(1)
  })

  it('bounds every non-null note, not just the mandatory ones', () => {
    const { matrix, ledger } = fixture()
    const longNote = JSON.parse(JSON.stringify(matrix))
    longNote.capabilities[0].systems.modernWindows.note = '长'.repeat(201)
    expect(check(longNote, ledger).join('\n')).toContain(
      'issue 71 modernWindows note must be null or a 1-200 character single-line string'
    )
    const fine = JSON.parse(JSON.stringify(matrix))
    fine.capabilities[0].systems.modernWindows.note = '普通格可以有界说明'
    expect(check(fine, ledger)).toEqual([])
  })

  it('keeps the command whitelist in lockstep with package.json scripts', () => {
    const { COMMAND_WHITELIST } = require('../scripts/verify-system-matrix.cjs')
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
    const missing = COMMAND_WHITELIST.filter((command: string) => {
      if (command === 'npm test') return false
      const name = command.replace(/^npm run /, '')
      return !(name in scripts)
    })
    expect(missing).toEqual([])
  })

  it('rejects calendar-invalid dates that pass the shape check', () => {
    const { matrix, ledger } = fixture()
    const impossible = JSON.parse(JSON.stringify(matrix))
    impossible.updated = '2026-02-30'
    expect(check(impossible, ledger)[0]).toContain('matrix.updated must be a YYYY-MM-DD date')
    const cellDate = JSON.parse(JSON.stringify(matrix))
    cellDate.capabilities[0].systems.modernWindows.lastVerified = '2026-13-01'
    expect(check(cellDate, ledger).join('\n')).toContain('issue 71 modernWindows 未执行 needs lastVerified as YYYY-MM-DD')
  })

  it('binds the shipped matrix in this checkout, locked to the shipped ledger', () => {
    const ledger = JSON.parse(readFileSync('docs/acceptance/capability-ledger.json', 'utf8'))
    const matrix = JSON.parse(readFileSync('docs/acceptance/system-matrix.json', 'utf8'))
    const result = validateMatrix(matrix, ledger, (path: string) => {
      try {
        readFileSync(join('.', path))
        return true
      } catch {
        return false
      }
    })
    expect(result.findings).toEqual([])
    expect(result.counts.rows).toBe(48)
    // The honest initial accounting: zero capability is accepted on either
    // system yet, so every capability row is below the bar.
    expect(result.counts.belowBar).toHaveLength(46)
    expect(result.counts.modernAccepted).toBe(0)
    expect(result.counts.win7Accepted).toBe(0)
  })

  it('runs green through the CLI entry point', () => {
    const run = spawnSync(process.execPath, ['scripts/verify-system-matrix.cjs'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('system matrix verified')
    expect(run.stdout).toContain('below bar')
  })
})

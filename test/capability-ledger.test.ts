import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateLedger, ENUMERATED_CAPABILITIES } from '../scripts/verify-capability-ledger.cjs'

// The validator runs against in-memory fixtures with a fake path resolver so
// failure modes are exercised without touching the repository tree. The final
// two cases bind the shipped ledger and the CLI to the real checkout.
const existing = new Set(['docs/acceptance/issue-71/report.md', 'docs/porting.md', 'test/dock-store.test.ts'])
const resolvePath = (path: string) => existing.has(path)
const date = '2026-11-08'

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1-01',
    issue: 71,
    phase: '一期',
    index: 1,
    kind: '能力',
    name: '示例能力',
    originalEntry: 'linz src/renderer/src/dock',
    newPath: 'src/renderer/src/dock',
    allowedDifferences: '待补',
    layers: {
      entryRestoration: { status: '已恢复', evidence: ['docs/porting.md'], lastVerified: date },
      businessWiring: { status: '已接线', evidence: ['test/dock-store.test.ts'], lastVerified: date },
      candidateAcceptance: { status: '未记录', evidence: [], lastVerified: null }
    },
    scenarios: [
      { name: '布局重启恢复', state: '恢复', evidence: ['docs/acceptance/issue-71/report.md'] },
      { name: '损坏布局载荷拒绝', state: '拒绝', evidence: ['docs/acceptance/issue-71/report.md'] }
    ],
    ...overrides
  }
}

function baseLedger(capabilities: any[]) {
  return { version: 1, updated: date, frameworkDoc: 'docs/porting.md', capabilities }
}

function fullLedger() {
  return baseLedger(
    ENUMERATED_CAPABILITIES.map((c: any) =>
      baseEntry({
        id: `p${c.phaseOrder}-${String(c.index).padStart(2, '0')}`,
        issue: c.issue,
        phase: c.phase,
        index: c.index,
        kind: c.governance ? '治理' : '能力'
      })
    )
  )
}

function check(ledger: unknown): string[] {
  const result = validateLedger(ledger, resolvePath)
  return result.findings
}

describe('capability ledger validator', () => {
  it('accepts a complete fixture of the enumerated 48 children', () => {
    const result = validateLedger(fullLedger(), resolvePath)
    expect(result.findings).toEqual([])
    expect(result.counts).toEqual({ total: 48, capabilities: 46, governance: 2 })
  })

  it('enumerates 48 children: 46 capability items plus governance #89 and #120', () => {
    expect(ENUMERATED_CAPABILITIES).toHaveLength(48)
    expect(ENUMERATED_CAPABILITIES.filter((c) => c.governance)).toHaveLength(2)
    const issues = ENUMERATED_CAPABILITIES.map((c) => c.issue)
    expect(issues).toEqual([...new Set(issues)])
    for (const phase of ['一期', '二期', '三期', '四期', '五期', '六期']) {
      expect(ENUMERATED_CAPABILITIES.filter((c) => c.phase === phase).length).toBeGreaterThan(0)
    }
  })

  it('rejects top-level shape deviations', () => {
    expect(check({ version: 2, updated: date, frameworkDoc: 'docs/porting.md', capabilities: [] })).toContain(
      'ledger.version must be 1'
    )
    const noKey = { ...fullLedger() }
    delete (noKey as Record<string, unknown>).frameworkDoc
    expect(check(noKey)[0]).toContain('ledger keys')
    expect(check({ ...fullLedger(), updated: '2026-11-8' })[0]).toContain('ledger.updated must be a YYYY-MM-DD date')
    expect(check(baseLedger('nope'))[0]).toContain('capabilities must be an array')
  })

  it('requires the framework doc path to exist on disk', () => {
    expect(check({ ...fullLedger(), frameworkDoc: 'docs/missing.md' })[0]).toContain('frameworkDoc does not exist')
  })

  it('requires exactly the enumerated issue/phase/index triples', () => {
    const wrong = fullLedger()
    wrong.capabilities[0].issue = 999
    expect(check(wrong)[0]).toContain('issue 999 is not in the enumerated set')
    const dup = fullLedger()
    dup.capabilities[1].issue = 71
    expect(check(dup).join('\n')).toContain('duplicate issue 71')
    const swapped = fullLedger()
    swapped.capabilities[2].index = 9
    expect(check(swapped).join('\n')).toContain('issue 73 must have index 3 in 一期')
  })

  it('enforces the 46 capability + 2 governance split', () => {
    const miscategorized = fullLedger()
    const row = miscategorized.capabilities.find((c: { issue: number }) => c.issue === 71)
    row.kind = '治理'
    expect(check(miscategorized).join('\n')).toContain('issue 71 must be kind 能力')
    const missing = fullLedger()
    const gov = missing.capabilities.find((c: { issue: number }) => c.issue === 89)
    gov.kind = '能力'
    expect(check(missing).join('\n')).toContain('issue 89 must be kind 治理')
  })

  it('pins entry keys, id format and id uniqueness', () => {
    const extra = fullLedger()
    extra.capabilities[0].extra = true
    expect(check(extra)[0]).toContain('entry #71 keys')
    const badId = fullLedger()
    badId.capabilities[0].id = 'wrong'
    expect(check(badId).join('\n')).toContain('id must match')
    const dupId = fullLedger()
    dupId.capabilities[1].id = dupId.capabilities[0].id
    expect(check(dupId).join('\n')).toContain('duplicate id')
  })

  it('rejects unknown layer names and status vocabulary', () => {
    const keys = fullLedger()
    keys.capabilities[0].layers.fourth = { status: '已恢复', evidence: ['docs/porting.md'], lastVerified: date }
    expect(check(keys)[0]).toContain('layers keys')
    const status = fullLedger()
    status.capabilities[0].layers.entryRestoration.status = '差不多'
    expect(check(status)[0]).toContain('entryRestoration status must be one of')
    const wiring = fullLedger()
    wiring.capabilities[0].layers.businessWiring.status = '已恢复'
    expect(check(wiring)[0]).toContain('businessWiring status must be one of')
  })

  it('requires evidence paths on disk for recorded states and forbids them on 未记录', () => {
    const missingPath = fullLedger()
    missingPath.capabilities[0].layers.entryRestoration.evidence = ['docs/acceptance/nope.md']
    expect(check(missingPath)[0]).toContain('evidence path does not exist: docs/acceptance/nope.md')
    const unrecorded = fullLedger()
    unrecorded.capabilities[0].layers.candidateAcceptance = {
      status: '未记录',
      evidence: ['docs/porting.md'],
      lastVerified: date
    }
    expect(check(unrecorded)[0]).toContain('candidateAcceptance 未记录 must carry no evidence')
    const empty = fullLedger()
    empty.capabilities[0].layers.entryRestoration = { status: '已恢复', evidence: [], lastVerified: date }
    expect(check(empty)[0]).toContain('entryRestoration 已恢复 needs at least one evidence path')
    const noDate = fullLedger()
    noDate.capabilities[0].layers.entryRestoration.lastVerified = null
    expect(check(noDate)[0]).toContain('entryRestoration 已恢复 needs lastVerified')
  })

  it('reserves 不适用 for governance rows', () => {
    const product = fullLedger() as { capabilities: any[] }
    product.capabilities[0].layers.entryRestoration = { status: '不适用', evidence: [], lastVerified: null }
    expect(check(product)[0]).toContain('不适用 is reserved for 治理 rows')
    const gov = fullLedger() as { capabilities: any[] }
    const row = gov.capabilities.find((c: { issue: number }) => c.issue === 120)
    row.layers.businessWiring = { status: '不适用', evidence: [], lastVerified: null }
    expect(check(gov)).toEqual([])
  })

  it('validates six-state scenario slots', () => {
    const badState = fullLedger()
    badState.capabilities[0].scenarios[0].state = '成功了吧'
    expect(check(badState)[0]).toContain('scenario state must be one of')
    const noEvidence = fullLedger()
    noEvidence.capabilities[0].scenarios[0] = { name: '导出成功', state: '成功', evidence: [] }
    expect(check(noEvidence)[0]).toContain('scenario 导出成功 with state 成功 needs at least one evidence path')
    const unexecuted = fullLedger()
    unexecuted.capabilities[0].scenarios[0] = { name: '候选包断线', state: '未执行', evidence: [] }
    expect(check(unexecuted)).toEqual([])
    const badPath = fullLedger()
    badPath.capabilities[0].scenarios[1].evidence = ['docs/gone.md']
    expect(check(badPath)[0]).toContain('evidence path does not exist: docs/gone.md')
    const extraKey = fullLedger()
    extraKey.capabilities[0].scenarios[0].note = 'x'
    expect(check(extraKey)[0]).toContain('scenario keys')
  })

  it('rejects calendar-invalid dates that pass the YYYY-MM-DD shape check', () => {
    const impossible = fullLedger()
    impossible.updated = '2026-02-30'
    expect(check(impossible)[0]).toContain('ledger.updated must be a YYYY-MM-DD date')
    const layer = fullLedger()
    layer.capabilities[0].layers.entryRestoration.lastVerified = '2026-13-01'
    expect(check(layer).join('\n')).toContain('entryRestoration 已恢复 needs lastVerified as YYYY-MM-DD')
  })

  it('rejects evidence paths containing backslashes', () => {
    const backslash = fullLedger()
    backslash.capabilities[0].layers.entryRestoration.evidence = ['docs\\acceptance\\issue-71\\report.md']
    expect(check(backslash)[0]).toContain('evidence path must be repository-relative')
  })

  it('guards 未执行 scenario slots: empty evidence, array shape, repository-relative paths', () => {
    // 尚无证据: a 未执行 slot must carry no evidence at all
    const filled = fullLedger()
    filled.capabilities[0].scenarios[0] = { name: '候选包断线', state: '未执行', evidence: ['docs/porting.md'] }
    expect(check(filled)[0]).toContain('候选包断线 未执行 must carry no evidence')
    // a non-array evidence value yields a finding instead of a TypeError
    const notArray = fullLedger()
    notArray.capabilities[0].scenarios[0] = { name: '候选包断线', state: '未执行', evidence: 'docs/porting.md' }
    expect(check(notArray)[0]).toContain('候选包断线 evidence must be an array')
    // entries that do appear still face the shared repository-relative shape guard
    const absolute = fullLedger()
    absolute.capabilities[0].scenarios[0] = { name: '候选包断线', state: '未执行', evidence: ['C:\\tmp\\report.md'] }
    expect(check(absolute).join('\n')).toContain('evidence path must be repository-relative: C:\\tmp\\report.md')
    const traversal = fullLedger()
    traversal.capabilities[0].scenarios[0] = { name: '候选包断线', state: '未执行', evidence: ['../outside.md'] }
    expect(check(traversal).join('\n')).toContain('evidence path must be repository-relative: ../outside.md')
  })

  it('requires every 一期 demo row to carry at least one evidence citation', () => {
    const bare = fullLedger()
    for (const row of bare.capabilities.filter((c: { phase: string }) => c.phase === '一期')) {
      row.layers = {
        entryRestoration: { status: '未记录', evidence: [], lastVerified: null },
        businessWiring: { status: '已接线', evidence: [], lastVerified: null },
        candidateAcceptance: { status: '未记录', evidence: [], lastVerified: null }
      }
      row.scenarios = []
    }
    // 已接线 without evidence is already flagged; make wiring 未记录 so only the demo rule fires
    for (const row of bare.capabilities.filter((c: { phase: string }) => c.phase === '一期')) {
      row.layers.businessWiring = { status: '未记录', evidence: [], lastVerified: null }
    }
    const phase1 = bare.capabilities.filter((c: { phase: string }) => c.phase === '一期')
    expect(phase1).toHaveLength(10)
    expect(check(bare).join('\n')).toContain('一期 demo row #71 needs at least one evidence citation')
  })

  it('binds the shipped ledger in this checkout', () => {
    const ledger = JSON.parse(readFileSync('docs/acceptance/capability-ledger.json', 'utf8'))
    const result = validateLedger(ledger, (path: string) => {
      try {
        readFileSync(join('.', path))
        return true
      } catch {
        return false
      }
    })
    expect(result.findings).toEqual([])
    expect(result.counts.total).toBe(48)
  })

  it('runs green through the CLI entry point', () => {
    const run = spawnSync(process.execPath, ['scripts/verify-capability-ledger.cjs'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('capability ledger verified')
  })
})

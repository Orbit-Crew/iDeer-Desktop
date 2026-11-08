'use strict'
// Issue #89 validator for docs/acceptance/capability-ledger.json.
// Usage: node scripts/verify-capability-ledger.cjs [ledger-path]
// Exits non-zero with one finding per line when the ledger breaks the
// three-layer / six-state contract described in capability-ledger.md.

const { existsSync, readFileSync } = require('node:fs')
const { join, isAbsolute } = require('node:path')

// The authoritative enumeration of the #70 child issues (48 numbered items;
// see capability-ledger.md for the 46+2 derivation). phaseOrder + index are
// the global 一期·1 .. 六期·48 slot numbers from the spec.
const ENUMERATED_CAPABILITIES = [
  { issue: 71, phase: '一期', phaseOrder: 1, index: 1 },
  { issue: 72, phase: '一期', phaseOrder: 1, index: 2 },
  { issue: 73, phase: '一期', phaseOrder: 1, index: 3 },
  { issue: 74, phase: '一期', phaseOrder: 1, index: 4 },
  { issue: 75, phase: '一期', phaseOrder: 1, index: 5 },
  { issue: 76, phase: '一期', phaseOrder: 1, index: 6 },
  { issue: 77, phase: '一期', phaseOrder: 1, index: 7 },
  { issue: 78, phase: '一期', phaseOrder: 1, index: 8 },
  { issue: 79, phase: '一期', phaseOrder: 1, index: 9 },
  { issue: 80, phase: '一期', phaseOrder: 1, index: 10 },
  { issue: 91, phase: '二期', phaseOrder: 2, index: 11 },
  { issue: 92, phase: '二期', phaseOrder: 2, index: 12 },
  { issue: 81, phase: '二期', phaseOrder: 2, index: 13 },
  { issue: 93, phase: '二期', phaseOrder: 2, index: 14 },
  { issue: 94, phase: '二期', phaseOrder: 2, index: 15 },
  { issue: 95, phase: '二期', phaseOrder: 2, index: 16 },
  { issue: 96, phase: '三期', phaseOrder: 3, index: 17 },
  { issue: 97, phase: '三期', phaseOrder: 3, index: 18 },
  { issue: 98, phase: '三期', phaseOrder: 3, index: 19 },
  { issue: 99, phase: '三期', phaseOrder: 3, index: 20 },
  { issue: 100, phase: '三期', phaseOrder: 3, index: 21 },
  { issue: 101, phase: '三期', phaseOrder: 3, index: 22 },
  { issue: 102, phase: '四期', phaseOrder: 4, index: 23 },
  { issue: 103, phase: '四期', phaseOrder: 4, index: 24 },
  { issue: 82, phase: '四期', phaseOrder: 4, index: 25 },
  { issue: 104, phase: '四期', phaseOrder: 4, index: 26 },
  { issue: 105, phase: '四期', phaseOrder: 4, index: 27 },
  { issue: 83, phase: '四期', phaseOrder: 4, index: 28 },
  { issue: 84, phase: '四期', phaseOrder: 4, index: 29 },
  { issue: 106, phase: '四期', phaseOrder: 4, index: 30 },
  { issue: 107, phase: '五期', phaseOrder: 5, index: 31 },
  { issue: 108, phase: '五期', phaseOrder: 5, index: 32 },
  { issue: 109, phase: '五期', phaseOrder: 5, index: 33 },
  { issue: 110, phase: '五期', phaseOrder: 5, index: 34 },
  { issue: 111, phase: '五期', phaseOrder: 5, index: 35 },
  { issue: 85, phase: '五期', phaseOrder: 5, index: 36 },
  { issue: 86, phase: '五期', phaseOrder: 5, index: 37 },
  { issue: 112, phase: '五期', phaseOrder: 5, index: 38 },
  { issue: 113, phase: '五期', phaseOrder: 5, index: 39 },
  { issue: 115, phase: '六期', phaseOrder: 6, index: 40 },
  { issue: 116, phase: '六期', phaseOrder: 6, index: 41 },
  { issue: 117, phase: '六期', phaseOrder: 6, index: 42 },
  { issue: 87, phase: '六期', phaseOrder: 6, index: 43 },
  { issue: 118, phase: '六期', phaseOrder: 6, index: 44 },
  { issue: 119, phase: '六期', phaseOrder: 6, index: 45 },
  { issue: 88, phase: '六期', phaseOrder: 6, index: 46 },
  { issue: 120, phase: '六期', phaseOrder: 6, index: 47, governance: true },
  { issue: 89, phase: '六期', phaseOrder: 6, index: 48, governance: true }
]

const LAYER_STATUS = {
  entryRestoration: ['已恢复', '占位', '未迁移', '未记录', '不适用'],
  businessWiring: ['已接线', '未接线', '未记录', '不适用'],
  candidateAcceptance: ['已验收', '部分验收', '未执行', '未记录', '不适用']
}
const SCENARIO_STATES = ['成功', '拒绝', '失败', '断线', '停止', '恢复', '未执行']
const INACTIVE = ['未记录', '不适用']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ENTRY_KEYS = [
  'id', 'issue', 'phase', 'index', 'kind', 'name',
  'originalEntry', 'newPath', 'allowedDifferences', 'layers', 'scenarios'
]
const LAYER_KEYS = Object.keys(LAYER_STATUS)
const LEDGER_KEYS = ['version', 'updated', 'frameworkDoc', 'capabilities']

function exactKeys(object, keys, label, findings) {
  const actual = Object.keys(object)
  const missing = keys.filter((k) => !(k in object))
  const extra = actual.filter((k) => !keys.includes(k))
  if (missing.length || extra.length) {
    findings.push(`${label} keys must be exactly ${keys.join(', ')} (missing: ${missing.join(', ') || '—'}, extra: ${extra.join(', ') || '—'})`)
    return false
  }
  return true
}

function checkEvidence(list, label, findings, resolvePath) {
  if (!Array.isArray(list) || list.length === 0) {
    findings.push(`${label} needs at least one evidence path`)
    return
  }
  for (const path of list) {
    if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('..')) {
      findings.push(`evidence path must be repository-relative: ${String(path)}`)
      continue
    }
    if (!resolvePath(path)) findings.push(`evidence path does not exist: ${path}`)
  }
}

// Validates a parsed ledger. resolvePath maps a repository-relative path to
// existence; the CLI resolves against the checkout root, tests inject fakes.
function validateLedger(ledger, resolvePath) {
  const findings = []
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { findings: ['ledger must be a JSON object'], counts: null }
  }
  if (!exactKeys(ledger, LEDGER_KEYS, 'ledger', findings)) return { findings, counts: null }
  if (ledger.version !== 1) findings.push('ledger.version must be 1')
  if (typeof ledger.updated !== 'string' || !DATE.test(ledger.updated)) {
    findings.push('ledger.updated must be a YYYY-MM-DD date')
  }
  if (typeof ledger.frameworkDoc !== 'string' || !resolvePath(ledger.frameworkDoc)) {
    findings.push(`frameworkDoc does not exist: ${String(ledger.frameworkDoc)}`)
  }
  if (!Array.isArray(ledger.capabilities)) {
    findings.push('capabilities must be an array')
    return { findings, counts: null }
  }

  const byIssue = new Map(ENUMERATED_CAPABILITIES.map((c) => [c.issue, c]))
  const seenIssues = new Set()
  const seenIds = new Set()
  for (const entry of ledger.capabilities) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      findings.push('capability entry must be an object')
      continue
    }
    const spec = byIssue.get(entry.issue)
    if (!spec) {
      findings.push(`issue ${String(entry.issue)} is not in the enumerated set of #70 children`)
      continue
    }
    if (!exactKeys(entry, ENTRY_KEYS, `entry #${spec.issue}`, findings)) continue
    if (seenIssues.has(spec.issue)) findings.push(`duplicate issue ${spec.issue}`)
    seenIssues.add(spec.issue)
    if (entry.id !== `p${spec.phaseOrder}-${String(spec.index).padStart(2, '0')}`) {
      findings.push(`id must match p<phaseOrder>-<index> for issue ${spec.issue}: ${String(entry.id)}`)
    }
    if (seenIds.has(entry.id)) findings.push(`duplicate id ${entry.id}`)
    seenIds.add(entry.id)
    if (entry.phase !== spec.phase || entry.index !== spec.index) {
      findings.push(`issue ${spec.issue} must have index ${spec.index} in ${spec.phase}`)
    }
    const expectedKind = spec.governance ? '治理' : '能力'
    if (entry.kind !== expectedKind) {
      findings.push(`issue ${spec.issue} must be kind ${expectedKind}`)
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      findings.push(`entry #${spec.issue} needs a non-empty name`)
    }
    for (const field of ['originalEntry', 'newPath', 'allowedDifferences']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        findings.push(`entry #${spec.issue} field ${field} must be a non-empty string (待补 allowed)`)
      }
    }

    if (entry.layers === null || typeof entry.layers !== 'object' || Array.isArray(entry.layers)) {
      findings.push(`entry #${spec.issue} layers must be an object`)
      continue
    }
    if (!exactKeys(entry.layers, LAYER_KEYS, `entry #${spec.issue} layers`, findings)) continue
    let citations = 0
    for (const layer of LAYER_KEYS) {
      const record = entry.layers[layer]
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        findings.push(`entry #${spec.issue} ${layer} must be an object`)
        continue
      }
      if (!exactKeys(record, ['status', 'evidence', 'lastVerified'], `entry #${spec.issue} ${layer}`, findings)) continue
      if (!LAYER_STATUS[layer].includes(record.status)) {
        findings.push(`entry #${spec.issue} ${layer} status must be one of ${LAYER_STATUS[layer].join('/')}: ${String(record.status)}`)
        continue
      }
      if (record.status === '不适用' && expectedKind !== '治理') {
        findings.push(`entry #${spec.issue} ${layer} 不适用 is reserved for 治理 rows`)
      }
      if (INACTIVE.includes(record.status)) {
        if (record.evidence.length !== 0 || record.lastVerified !== null) {
          findings.push(`entry #${spec.issue} ${layer} ${record.status} must carry no evidence or lastVerified`)
        }
        continue
      }
      checkEvidence(record.evidence, `entry #${spec.issue} ${layer} ${record.status}`, findings, resolvePath)
      citations += record.evidence.length
      if (typeof record.lastVerified !== 'string' || !DATE.test(record.lastVerified)) {
        findings.push(`entry #${spec.issue} ${layer} ${record.status} needs lastVerified as YYYY-MM-DD`)
      }
    }

    if (!Array.isArray(entry.scenarios)) {
      findings.push(`entry #${spec.issue} scenarios must be an array`)
      continue
    }
    for (const scenario of entry.scenarios) {
      if (scenario === null || typeof scenario !== 'object') {
        findings.push(`entry #${spec.issue} scenario must be an object`)
        continue
      }
      if (!exactKeys(scenario, ['name', 'state', 'evidence'], `entry #${spec.issue} scenario`, findings)) continue
      if (!SCENARIO_STATES.includes(scenario.state)) {
        findings.push(`entry #${spec.issue} scenario state must be one of ${SCENARIO_STATES.join('/')}: ${String(scenario.state)}`)
        continue
      }
      if (scenario.state === '未执行') {
        for (const path of scenario.evidence) {
          if (!resolvePath(path)) findings.push(`evidence path does not exist: ${path}`)
        }
      } else {
        checkEvidence(scenario.evidence, `entry #${spec.issue} scenario ${scenario.name} with state ${scenario.state}`, findings, resolvePath)
        citations += scenario.evidence.length
      }
    }

    if (spec.phase === '一期' && citations === 0) {
      findings.push(`一期 demo row #${spec.issue} needs at least one evidence citation`)
    }
  }

  for (const spec of ENUMERATED_CAPABILITIES) {
    if (!seenIssues.has(spec.issue)) findings.push(`missing enumerated issue ${spec.issue} (${spec.phase}·${spec.index})`)
  }
  const counts = {
    total: ledger.capabilities.length,
    capabilities: ledger.capabilities.filter((e) => e && e.kind === '能力').length,
    governance: ledger.capabilities.filter((e) => e && e.kind === '治理').length
  }
  if (counts.capabilities !== 46 || counts.governance !== 2) {
    findings.push(`ledger must hold 46 能力 rows and 2 治理 rows, found ${counts.capabilities}/${counts.governance}`)
  }
  return { findings, counts }
}

function main() {
  const ledgerPath = process.argv[2] || 'docs/acceptance/capability-ledger.json'
  const root = join(__dirname, '..')
  if (!existsSync(join(root, ledgerPath))) {
    console.error(`ledger not found: ${ledgerPath}`)
    process.exit(1)
  }
  let ledger
  try {
    ledger = JSON.parse(readFileSync(join(root, ledgerPath), 'utf8'))
  } catch (error) {
    console.error(`ledger is not valid JSON: ${error.message}`)
    process.exit(1)
  }
  const { findings, counts } = validateLedger(ledger, (path) => existsSync(join(root, path)))
  if (findings.length > 0) {
    console.error(`capability ledger INVALID (${findings.length} findings):`)
    for (const finding of findings) console.error(`- ${finding}`)
    process.exit(1)
  }
  console.log(
    `capability ledger verified: ${counts.total} rows (${counts.capabilities} 能力 + ${counts.governance} 治理), ${ledgerPath}`
  )
}

if (require.main === module) main()

module.exports = { validateLedger, ENUMERATED_CAPABILITIES, LAYER_STATUS, SCENARIO_STATES }

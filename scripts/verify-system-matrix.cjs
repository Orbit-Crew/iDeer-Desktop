'use strict'
// Issue #120 validator for docs/acceptance/system-matrix.json.
// Usage: node scripts/verify-system-matrix.cjs [matrix-path]
// Exits non-zero with one finding per line when the capability × system
// matrix breaks the contract described in docs/acceptance/system-matrix.md:
// closed status vocabulary, ledger lockstep on the modern Windows column,
// honest 未记录/未执行 accounting, reserved 不适用, and per-cell registered
// execution entries (automated paths, whitelisted commands, T131/W7
// scenarios, bounded manual paths).

const { existsSync, readFileSync } = require('node:fs')
const { join, isAbsolute } = require('node:path')

// The matrix is a system-axis slice of the #89 capability ledger: its row set
// is not re-enumerated here but read from the shipped ledger, so a #70
// sub-ticket change is caught by verify:ledger and any matrix drift from it
// is caught here.
const LEDGER_PATH = 'docs/acceptance/capability-ledger.json'

const SYSTEM_IDS = ['modernWindows', 'win7']
const STATUS = ['已验收', '部分验收', '未执行', '未记录', '不适用']
const ENTRY_KINDS = ['automated', 'manual', 'scenario', 'command']
// Commands an execution entry may name, as closed as the package.json scripts
// they map to; anything else must be registered as manual or automated.
const COMMAND_WHITELIST = [
  'npm run dist:win',
  'npm run typecheck',
  'npm test',
  'npm run test:runtime',
  'npm run test:components',
  'npm run test:desktop',
  'npm run test:security',
  'npm run verify:provenance',
  'npm run verify:third-party',
  'npm run verify:ledger',
  'npm run verify:matrix'
]
// Execution entries may point at the iDeer #131 final-acceptance scenarios
// (T131-01..) or the desktop Win7 table in docs/validation.md (W7-01..).
const SCENARIO_RE = /^(?:T131|W7)-\d{2}$/

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CONTROL_CHARS = /[\u0000-\u001f]/

const MATRIX_KEYS = ['version', 'updated', 'frameworkDoc', 'ledgerDoc', 'systems', 'capabilities']
const SYSTEM_META_KEYS = ['label', 'description']
const ROW_KEYS = ['id', 'issue', 'kind', 'name', 'systems']
const CELL_KEYS = ['status', 'evidence', 'entries', 'lastVerified', 'note']
const ENTRY_KEYS = ['kind', 'ref']

// A YYYY-MM-DD string must also be a real calendar date: the shape regex
// alone accepts impossible values like 2026-02-30, so round-trip the
// constructed date and require it to match its components back.
function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

// Shared shape guard for every repository-relative path (evidence and
// automated entries): no absolute paths, no '..' traversal, and no
// backslashes — backslash separators resolve on Windows but break on POSIX
// runners.
function isRepositoryRelativePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('..') &&
    !path.includes('\\')
  )
}

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

// A note is mandatory where an explanation is owed (不适用 reasons, ledger
// divergence) and must otherwise stay null or a bounded single-line string.
// Returns true when a usable note is present.
function usableNote(note) {
  return typeof note === 'string' && note.length >= 1 && note.length <= 200 && !CONTROL_CHARS.test(note)
}

function checkEvidence(list, label, findings, resolvePath) {
  if (!Array.isArray(list)) {
    findings.push(`${label} evidence must be an array`)
    return
  }
  for (const path of list) {
    if (!isRepositoryRelativePath(path)) {
      findings.push(`evidence path must be repository-relative: ${String(path)}`)
      continue
    }
    if (!resolvePath(path)) findings.push(`evidence path does not exist: ${path}`)
  }
}

function checkEntry(entry, label, findings, resolvePath) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    findings.push(`${label} entry must be an object`)
    return
  }
  if (!exactKeys(entry, ENTRY_KEYS, `${label} entry`, findings)) return
  const { kind, ref } = entry
  if (!ENTRY_KINDS.includes(kind)) {
    findings.push(`${label} entry kind must be one of ${ENTRY_KINDS.join('/')}: ${String(kind)}`)
    return
  }
  if (kind === 'automated') {
    if (!isRepositoryRelativePath(ref)) {
      findings.push(`automated entry path must be repository-relative: ${String(ref)}`)
    } else if (!resolvePath(ref)) {
      findings.push(`automated entry path does not exist: ${ref}`)
    }
  } else if (kind === 'manual') {
    if (typeof ref !== 'string' || ref.length < 1 || ref.length > 160 || CONTROL_CHARS.test(ref)) {
      findings.push(`${label} manual entry must be 1-160 characters without control characters`)
    }
  } else if (kind === 'scenario') {
    if (typeof ref !== 'string' || !SCENARIO_RE.test(ref)) {
      findings.push(`scenario ref must match T131-NN or W7-NN: ${String(ref)}`)
    }
  } else if (!COMMAND_WHITELIST.includes(ref)) {
    findings.push(`command entry is not whitelisted: ${String(ref)}`)
  }
}

function checkCell(cell, system, row, ledgerRow, findings, resolvePath) {
  const label = `issue ${row.issue} ${system}`
  if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) {
    findings.push(`${label} cell must be an object`)
    return
  }
  if (!exactKeys(cell, CELL_KEYS, label, findings)) return
  if (!STATUS.includes(cell.status)) {
    findings.push(`${system} status must be one of ${STATUS.join('/')}: ${String(cell.status)}`)
    return
  }

  if (cell.status === '不适用') {
    // On modern Windows a capability row may never opt out — it must be
    // attempted there first. On Win7 the issue explicitly allows
    // per-item exclusation ("上不了 Win7 的能力逐项明示"), but only with the
    // in-tree incompatibility analysis attached, never a bare assertion.
    if (row.kind !== '治理') {
      if (system === 'modernWindows') {
        findings.push(`${label} 不适用 is reserved for 治理 rows`)
      } else if (!Array.isArray(cell.evidence) || cell.evidence.length === 0) {
        findings.push(`${label} 能力行 不适用 needs in-tree incompatibility evidence (不硬凑)`)
      } else {
        checkEvidence(cell.evidence, label, findings, resolvePath)
      }
    } else if (!Array.isArray(cell.evidence) || cell.evidence.length > 0) {
      findings.push(`${label} 不适用 must carry no evidence`)
    }
    if (cell.note === null) {
      findings.push(`${label} 不适用 needs a note stating the reason`)
    } else if (!usableNote(cell.note)) {
      findings.push(`${label} note must be null or a 1-200 character single-line string`)
    }
    if (Array.isArray(cell.entries) && cell.entries.length > 0) {
      findings.push(`${label} 不适用 must carry no execution entries`)
    }
    if (cell.lastVerified !== null) {
      findings.push(`${label} 不适用 must carry no lastVerified`)
    }
    return
  }

  if (cell.status === '未记录') {
    if (!Array.isArray(cell.evidence) || cell.evidence.length > 0) {
      findings.push(`${label} 未记录 must carry no evidence`)
    }
    if (cell.lastVerified !== null) {
      findings.push(`${label} 未记录 must carry no lastVerified`)
    }
  } else if (cell.status === '未执行') {
    // 未执行 may cite the document that tracks the non-execution.
    if (cell.lastVerified !== null && !isCalendarDate(cell.lastVerified)) {
      findings.push(`${label} 未执行 needs lastVerified as YYYY-MM-DD or null`)
    }
    checkEvidence(cell.evidence, label, findings, resolvePath)
  } else {
    // 已验收 / 部分验收 record what passed, so they need evidence and a date.
    if (!Array.isArray(cell.evidence) || cell.evidence.length === 0) {
      findings.push(`${label} ${cell.status} needs at least one evidence path`)
    } else {
      checkEvidence(cell.evidence, label, findings, resolvePath)
    }
    if (!isCalendarDate(cell.lastVerified)) {
      findings.push(`${label} ${cell.status} needs lastVerified as YYYY-MM-DD`)
    }
  }

  if (!Array.isArray(cell.entries) || cell.entries.length === 0) {
    findings.push(`${label} ${cell.status} needs at least one execution entry`)
  } else {
    for (const entry of cell.entries) {
      checkEntry(entry, label, findings, resolvePath)
    }
    // Open Win7 cells must keep their #131/#120 scenario anchor so the
    // pending verdict stays wired to the acceptance operations that will
    // produce it.
    if (system === 'win7' && (cell.status === '未执行' || cell.status === '未记录')) {
      const hasScenario = cell.entries.some(
        (entry) => entry && typeof entry === 'object' && entry.kind === 'scenario' && typeof entry.ref === 'string'
      )
      if (!hasScenario) {
        findings.push(`${label} ${cell.status} needs at least one T131/W7 scenario entry`)
      }
    }
  }

  // Lockstep with the #89 ledger: the modern Windows column slices the
  // ledger's candidate layer onto this matrix; any divergence must say why.
  if (system === 'modernWindows' && ledgerRow) {
    const ledgerStatus =
      ledgerRow.layers && ledgerRow.layers.candidateAcceptance
        ? ledgerRow.layers.candidateAcceptance.status
        : null
    if (ledgerStatus && ledgerStatus !== cell.status) {
      if (cell.note === null) {
        findings.push(
          `${label} status diverges from the ledger candidate layer (${ledgerStatus}) without a note`
        )
      } else if (!usableNote(cell.note)) {
        findings.push(`${label} note must be null or a 1-200 character single-line string`)
      }
    }
  }
}

// Validates a parsed matrix against its ledger. resolvePath maps a
// repository-relative path to existence; the CLI resolves against the
// checkout root, tests inject fakes.
function validateMatrix(matrix, ledger, resolvePath) {
  const findings = []
  if (matrix === null || typeof matrix !== 'object' || Array.isArray(matrix)) {
    return { findings: ['matrix must be a JSON object'], counts: null }
  }
  if (!exactKeys(matrix, MATRIX_KEYS, 'matrix', findings)) return { findings, counts: null }
  if (matrix.version !== 1) findings.push('matrix.version must be 1')
  if (!isCalendarDate(matrix.updated)) findings.push('matrix.updated must be a YYYY-MM-DD date')
  if (typeof matrix.frameworkDoc !== 'string' || !resolvePath(matrix.frameworkDoc)) {
    findings.push(`frameworkDoc does not exist: ${String(matrix.frameworkDoc)}`)
  }
  if (matrix.ledgerDoc !== LEDGER_PATH) {
    findings.push(`matrix.ledgerDoc must be ${LEDGER_PATH}`)
  }
  if (matrix.systems === null || typeof matrix.systems !== 'object' || Array.isArray(matrix.systems)) {
    findings.push('matrix.systems must be an object')
    return { findings, counts: null }
  }
  if (!exactKeys(matrix.systems, SYSTEM_IDS, 'systems', findings)) return { findings, counts: null }
  for (const system of SYSTEM_IDS) {
    const meta = matrix.systems[system]
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      findings.push(`systems.${system} must be an object`)
      return { findings, counts: null }
    }
    exactKeys(meta, SYSTEM_META_KEYS, `systems.${system}`, findings)
    for (const field of SYSTEM_META_KEYS) {
      if (typeof meta[field] !== 'string' || meta[field].length === 0) {
        findings.push(`systems.${system}.${field} must be a non-empty string`)
      }
    }
  }
  if (!Array.isArray(matrix.capabilities)) {
    findings.push('matrix.capabilities must be an array')
    return { findings, counts: null }
  }

  const ledgerByIssue = new Map()
  if (ledger !== null && typeof ledger === 'object' && Array.isArray(ledger.capabilities)) {
    for (const row of ledger.capabilities) {
      if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.issue === 'number') {
        ledgerByIssue.set(row.issue, row)
      }
    }
  }

  const seenIssues = new Set()
  const belowBar = []
  let modernAccepted = 0
  let win7Accepted = 0
  let capabilityRows = 0
  for (const row of matrix.capabilities) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      findings.push('matrix row must be an object')
      continue
    }
    if (!exactKeys(row, ROW_KEYS, `matrix row ${String(row.issue)}`, findings)) continue
    const ledgerRow = ledgerByIssue.get(row.issue)
    if (!ledgerRow) {
      findings.push(`matrix row issue ${String(row.issue)} is not present in capability ledger`)
      continue
    }
    if (seenIssues.has(row.issue)) findings.push(`duplicate matrix row issue ${row.issue}`)
    seenIssues.add(row.issue)
    if (row.id !== ledgerRow.id) {
      findings.push(`matrix row issue ${row.issue} id must match ledger (${String(ledgerRow.id)})`)
    }
    if (row.kind !== ledgerRow.kind) {
      findings.push(`matrix row issue ${row.issue} kind must match ledger (${String(ledgerRow.kind)})`)
    }
    if (row.name !== ledgerRow.name) {
      findings.push(`matrix row issue ${row.issue} name must match ledger`)
    }
    if (row.kind === '能力') capabilityRows += 1
    if (row.systems === null || typeof row.systems !== 'object' || Array.isArray(row.systems)) {
      findings.push(`matrix row issue ${row.issue} systems must be an object`)
      continue
    }
    if (!exactKeys(row.systems, SYSTEM_IDS, `matrix row issue ${row.issue} systems`, findings)) continue
    let acceptedBoth = true
    for (const system of SYSTEM_IDS) {
      checkCell(row.systems[system], system, row, ledgerRow, findings, resolvePath)
      if (row.systems[system] && row.systems[system].status === '已验收') {
        if (system === 'modernWindows') modernAccepted += 1
        else win7Accepted += 1
      } else {
        acceptedBoth = false
      }
    }
    if (row.kind === '能力' && !acceptedBoth) {
      belowBar.push(`${row.id} ${row.name}`)
    }
  }

  for (const [issue, ledgerRow] of ledgerByIssue) {
    if (!seenIssues.has(issue)) {
      findings.push(`matrix is missing ledger row for issue ${issue} (${String(ledgerRow.name)})`)
    }
  }

  const counts = {
    rows: matrix.capabilities.length,
    capabilityRows,
    modernAccepted,
    win7Accepted,
    belowBar
  }
  return { findings, counts }
}

function main() {
  const matrixPath = process.argv[2] || 'docs/acceptance/system-matrix.json'
  const root = join(__dirname, '..')
  if (!existsSync(join(root, matrixPath))) {
    console.error(`matrix not found: ${matrixPath}`)
    process.exit(1)
  }
  if (!existsSync(join(root, LEDGER_PATH))) {
    console.error(`capability ledger not found: ${LEDGER_PATH}`)
    process.exit(1)
  }
  let matrix
  let ledger
  try {
    matrix = JSON.parse(readFileSync(join(root, matrixPath), 'utf8'))
    ledger = JSON.parse(readFileSync(join(root, LEDGER_PATH), 'utf8'))
  } catch (error) {
    console.error(`input is not valid JSON: ${error.message}`)
    process.exit(1)
  }
  const { findings, counts } = validateMatrix(matrix, ledger, (path) => existsSync(join(root, path)))
  if (findings.length > 0) {
    console.error(`system matrix INVALID (${findings.length} findings):`)
    for (const finding of findings) console.error(`- ${finding}`)
    process.exit(1)
  }
  console.log(
    `system matrix verified: ${counts.rows} rows × ${SYSTEM_IDS.length} systems, ` +
      `modern 已验收 ${counts.modernAccepted}, win7 已验收 ${counts.win7Accepted}, ${matrixPath}`
  )
  console.log(
    `below bar (未达标) ${counts.belowBar.length}/${counts.capabilityRows} capability rows — ` +
      '逐项明示，无静默缩范围：'
  )
  for (const row of counts.belowBar) console.log(`- ${row}`)
}

if (require.main === module) main()

module.exports = { validateMatrix, LEDGER_PATH, STATUS, ENTRY_KINDS, COMMAND_WHITELIST }

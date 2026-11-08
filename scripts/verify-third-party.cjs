// Third-party inventory verification (issue #88).
// Checks that every third-party artifact that ships (or is deliberately not
// shipped) is recorded in resources/provenance/third-party-inventory.json,
// that mirrored pins match the existing pin files, that THIRD_PARTY_NOTICES.md
// carries the same per-item ledger, and that the only pending
// (pending-maintainer-verification) items are the compiled human-gate list.
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

if (process.argv[2] === '--root' && !process.argv[3]) throw new Error('--root requires a directory')
const root = process.argv[2] === '--root' ? resolve(process.argv[3]) : resolve(__dirname, '..')

// The tracked human gates. A pending-maintainer-verification item outside this
// list fails verification; resolving a gate requires deliberately updating
// this list together with the inventory, so the change is reviewed.
const TRACKED_HUMAN_GATES = ['linz-license-grant']

const KINDS = ['source-derivation', 'binary', 'npm-dependency', 'runtime-archive', 'runtime-source', 'framework', 'not-shipped']
const STATUSES = ['verified', 'pending-maintainer-verification', 'not-shipped']
const errors = []
const fail = (code, detail) => errors.push(`ERROR ${code}: ${detail}`)
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'))

let inventory
try {
  inventory = readJson('resources/provenance/third-party-inventory.json')
} catch (error) {
  console.error(`ERROR INVENTORY_SCHEMA: cannot read resources/provenance/third-party-inventory.json (${error.message})`)
  process.exit(1)
}

// 1. Schema: shape every later check relies on.
const items = Array.isArray(inventory.items) ? inventory.items : null
if (!items || inventory.version !== 1 || !Array.isArray(inventory.humanGates)) {
  fail('INVENTORY_SCHEMA', 'inventory must have version 1, humanGates[] and items[]')
}
const seenIds = new Set()
for (const item of items || []) {
  const where = `item ${item && item.id ? item.id : '(missing id)'}`
  if (typeof item.id !== 'string' || !item.id) fail('INVENTORY_SCHEMA', `${where}: id must be a non-empty string`)
  else if (seenIds.has(item.id)) fail('INVENTORY_SCHEMA', `duplicate item id ${item.id}`)
  seenIds.add(item.id)
  if (!KINDS.includes(item.kind)) fail('INVENTORY_SCHEMA', `${where}: unknown kind ${JSON.stringify(item.kind)}`)
  if (!STATUSES.includes(item.status)) fail('INVENTORY_SCHEMA', `${where}: unknown status ${JSON.stringify(item.status)}`)
  for (const field of ['upstream', 'license', 'distribution']) {
    if (!item[field] || typeof item[field] !== 'object') fail('INVENTORY_SCHEMA', `${where}: missing ${field}`)
  }
  if (!item.upstream?.name || !item.upstream?.source || !item.upstream?.maintainer) fail('INVENTORY_SCHEMA', `${where}: upstream needs name, source and maintainer`)
  if (!item.license?.declared || !item.license?.evidence) fail('INVENTORY_SCHEMA', `${where}: license needs declared and evidence`)
  if (typeof item.distribution?.ships !== 'boolean') fail('INVENTORY_SCHEMA', `${where}: distribution.ships must be boolean`)
  if (typeof item.maintainer !== 'string' || !item.maintainer) fail('INVENTORY_SCHEMA', `${where}: missing responsible maintainer`)
  if (item.distribution?.ships) {
    if (!['verified', 'pending-maintainer-verification'].includes(item.status)) {
      fail('INVENTORY_SCHEMA', `${where}: shipped items must be verified or pending-maintainer-verification, not ${item.status}`)
    }
  } else if (item.status !== 'not-shipped' || !item.reason || !item.userNotice) {
    fail('INVENTORY_SCHEMA', `${where}: not-shipped items need status not-shipped, reason and userNotice`)
  }
  if (item.kind === 'npm-dependency') {
    if (item.id !== `npm:${item.name}@${item.version}` || !item.pin?.integrity) fail('INVENTORY_SCHEMA', `${where}: npm items need name, version, pin.integrity and id npm:<name>@<version>`)
  }
  if (item.kind === 'runtime-archive') {
    if (item.id !== `runtime-archive:${item.pin?.name}` || !item.pin?.url || !/^[0-9a-f]{64}$/.test(item.pin?.sha256 || '')) {
      fail('INVENTORY_SCHEMA', `${where}: runtime-archive items need pin.name, pin.url, pin.sha256 and id runtime-archive:<name>`)
    }
  }
  if (item.kind === 'binary' && (!item.distribution?.files || typeof item.distribution.files !== 'object')) {
    fail('INVENTORY_SCHEMA', `${where}: binary items need distribution.files (path -> sha256)`)
  }
  if (item.kind === 'framework' && item.id !== `${item.name}@${item.version}`) {
    fail('INVENTORY_SCHEMA', `${where}: framework items need name, version and id <name>@<version>`)
  }
}
for (const gate of Array.isArray(inventory.humanGates) ? inventory.humanGates : []) {
  if (!gate.id || !gate.item || !gate.owner || !gate.reason || !gate.userNotice) fail('INVENTORY_SCHEMA', 'human gate entries need id, item, owner, reason and userNotice')
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

const shippedItems = items.filter(item => item.distribution.ships)

// 2. npm axis: the effective shipped set is the package-lock closure reachable
// from package.json dependencies (dependencies + optionalDependencies, skipping
// dev-marked entries). Auto-installed peers of typings stay out; they are
// covered by the not-shipped dev-dependency item.
const pkg = readJson('package.json')
const lock = readJson('package-lock.json')
const lockEntries = new Map()
for (const [path, entry] of Object.entries(lock.packages || {})) if (path) lockEntries.set(path, entry)
function resolveLockPath(fromPath, name) {
  let base = fromPath
  for (;;) {
    const candidate = `${base ? base + '/' : ''}node_modules/${name}`
    if (lockEntries.has(candidate)) return candidate
    if (!base) return null
    const marker = base.lastIndexOf('/node_modules/')
    base = marker === -1 ? '' : base.slice(0, marker)
  }
}
const shippedNpm = new Map()
const queue = Object.keys(pkg.dependencies || {}).map(name => resolveLockPath('', name)).filter(Boolean)
while (queue.length) {
  const path = queue.pop()
  if (shippedNpm.has(path)) continue
  const entry = lockEntries.get(path)
  if (!entry || entry.dev) continue
  shippedNpm.set(path, entry)
  for (const name of Object.keys(entry.dependencies || {}).concat(Object.keys(entry.optionalDependencies || {}))) {
    const resolved = resolveLockPath(path, name)
    if (resolved && !shippedNpm.has(resolved)) queue.push(resolved)
  }
}
const shippedNpmByName = new Map([...shippedNpm].map(([path, entry]) => [path.replace(/.*node_modules\//, ''), entry]))
const inventoryNpm = new Map(items.filter(item => item.kind === 'npm-dependency').map(item => [item.name, item]))
for (const [name, entry] of shippedNpmByName) {
  const item = inventoryNpm.get(name)
  if (!item || item.version !== entry.version) {
    fail('SHIPPED_NOT_INVENTORIED', `npm:${name}@${entry.version} ships per package-lock.json but is not inventoried`)
    continue
  }
  if (item.license.declared !== entry.license) fail('PIN_DRIFT', `npm:${name} license "${item.license.declared}" drifted from package-lock.json "${entry.license}"`)
  if (item.pin.integrity !== entry.integrity) fail('PIN_DRIFT', `npm:${name}@${entry.version} integrity pin drifted from package-lock.json`)
}
for (const item of inventoryNpm.values()) {
  const entry = shippedNpmByName.get(item.name)
  if (entry) continue
  if ((pkg.devDependencies || {})[item.name] || lockEntries.get(`node_modules/${item.name}`)?.dev) {
    fail('DEPENDENCY_CLASS_MISMATCH', `${item.id} is a dev dependency and must not be claimed as distributed`)
  } else {
    fail('INVENTORY_NOT_SHIPPED', `${item.id} claims shipment but is absent from the package-lock production closure`)
  }
}

// 3. Binary axis: every file under resources/occt must be pinned byte-for-byte
// in linz-source.json and mirrored in the inventory; the builder must still
// map the directory into the package.
const linzSource = readJson('resources/provenance/linz-source.json')
const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const builderMaps = source => new RegExp(`from:\\s*['"]?${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?`).test(builderConfig)
const pinnedFiles = new Map()
for (const item of items.filter(candidate => candidate.kind === 'binary')) {
  for (const [path, sha256] of Object.entries(item.distribution.files || {})) pinnedFiles.set(path, { item, sha256 })
  if (!item.distribution.ships) continue
  if (!builderMaps('resources/occt')) fail('INVENTORY_NOT_SHIPPED', `${item.id} claims shipment but electron-builder.yml no longer maps resources/occt`)
}
const occtDir = join(root, 'resources/occt')
for (const name of readdirSync(occtDir)) {
  const occtPath = join(occtDir, name)
  if (!statSync(occtPath).isFile()) continue
  const relative = `occt/${name}`
  const pin = pinnedFiles.get(relative)
  if (!pin) fail('SHIPPED_NOT_INVENTORIED', `resources/occt/${name} ships but no inventory binary item pins it`)
  const upstreamPin = linzSource.files[`resources/occt/${name}`]
  if (!upstreamPin) fail('SHIPPED_NOT_INVENTORIED', `resources/occt/${name} ships but is not pinned in linz-source.json`)
  const actual = createHash('sha256').update(readFileSync(occtPath)).digest('hex')
  if (upstreamPin && actual !== upstreamPin) fail('PIN_DRIFT', `resources/occt/${name} hash drifted from linz-source.json`)
  if (pin && upstreamPin && pin.sha256 !== upstreamPin) fail('PIN_DRIFT', `${pin.item.id} pin for ${relative} drifted from linz-source.json`)
}
for (const [relative, pin] of pinnedFiles) {
  if (!existsSync(join(root, 'resources', relative))) fail('INVENTORY_NOT_SHIPPED', `${pin.item.id} pins ${relative} but the file does not exist`)
}

// 4. Runtime axis: distribution.lock.json archives mirrored in the inventory,
// and the runtime evidence files the inventory points at.
const runtimeLock = readJson('local-runtime/distribution.lock.json')
const lockArtifacts = new Map(runtimeLock.artifacts.map(artifact => [artifact.name, artifact]))
const inventoryArchives = new Map(items.filter(item => item.kind === 'runtime-archive').map(item => [item.pin.name, item]))
for (const [name, artifact] of lockArtifacts) {
  const item = inventoryArchives.get(name)
  if (!item) fail('SHIPPED_NOT_INVENTORIED', `distribution.lock.json artifact ${name} is assembled into the package but not inventoried`)
  else if (item.pin.sha256 !== artifact.sha256 || item.pin.url !== artifact.url) fail('PIN_DRIFT', `${item.id} pin drifted from distribution.lock.json`)
}
for (const [name, item] of inventoryArchives) {
  if (!lockArtifacts.has(name)) fail('INVENTORY_NOT_SHIPPED', `${item.id} claims shipment but distribution.lock.json does not pin it`)
}
if (shippedItems.some(item => item.kind === 'runtime-archive') && !builderMaps('.runtime')) {
  fail('INVENTORY_NOT_SHIPPED', 'runtime archives claim shipment but electron-builder.yml no longer maps .runtime')
}
if (shippedItems.some(item => (item.distribution.path || '').includes('provenance')) && !builderMaps('resources/provenance')) {
  fail('INVENTORY_NOT_SHIPPED', 'provenance archives claim shipment but electron-builder.yml no longer maps resources/provenance')
}
for (const item of shippedItems) {
  for (const evidence of item.evidenceFiles || []) {
    if (!existsSync(join(root, evidence))) fail('INVENTORY_NOT_SHIPPED', `${item.id} evidence file ${evidence} is missing`)
  }
}

// 5. Framework axis: the Electron pin must agree across lock, builder and inventory.
const frameworks = items.filter(item => item.kind === 'framework')
if (!frameworks.length) fail('SHIPPED_NOT_INVENTORIED', 'the Electron distribution ships but no framework item records it')
if (frameworks.length > 1) fail('INVENTORY_SCHEMA', `expected one framework item, found ${frameworks.length}`)
const electronLock = lockEntries.get('node_modules/electron')
const builderElectron = /electronVersion:\s*['"]?([^\s'"]+)['"]?/.exec(builderConfig)?.[1]
for (const item of frameworks) {
  if (electronLock && item.version !== electronLock.version) fail('PIN_DRIFT', `${item.id} drifted from package-lock.json electron ${electronLock.version}`)
  if (builderElectron && item.version !== builderElectron) fail('PIN_DRIFT', `${item.id} drifted from electron-builder.yml electronVersion ${builderElectron}`)
}

// 6. Human gates: pending items must be exactly the tracked gate list.
const pending = items.filter(item => item.status === 'pending-maintainer-verification').map(item => item.id)
const gateIds = inventory.humanGates.map(gate => gate.id)
const gateItems = inventory.humanGates.map(gate => gate.item)
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set(b).size && a.every(entry => new Set(b).has(entry))
if (!sameSet(gateIds, TRACKED_HUMAN_GATES)) fail('PENDING_GATE_MISMATCH', `humanGates ${JSON.stringify(gateIds)} != tracked gates ${JSON.stringify(TRACKED_HUMAN_GATES)}`)
if (!sameSet(gateItems, pending)) fail('PENDING_GATE_MISMATCH', `pending items ${JSON.stringify(pending)} != gated items ${JSON.stringify(gateItems)}`)
for (const gate of inventory.humanGates) {
  if (!seenIds.has(gate.item)) fail('PENDING_GATE_MISMATCH', `gate ${gate.id} references unknown item ${gate.item}`)
}

// 7. Notices axis: the THIRD_PARTY_NOTICES.md ledger rows (first table cell in
// backticks) must reference exactly the inventory item ids.
let notices = ''
try {
  notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
} catch {
  fail('NOTICES_DRIFT', 'THIRD_PARTY_NOTICES.md is missing')
}
const ledgerIds = [...notices.matchAll(/^\| *`([^`]+)` *\|/gm)].map(match => match[1])
for (const id of ledgerIds) if (!seenIds.has(id)) fail('NOTICES_DRIFT', `THIRD_PARTY_NOTICES.md ledger references unknown item ${id}`)
for (const id of seenIds) if (!ledgerIds.includes(id)) fail('NOTICES_DRIFT', `inventory item ${id} has no ledger row in THIRD_PARTY_NOTICES.md`)

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
const notShipped = items.length - shippedItems.length
console.log(`Verified third-party inventory: ${items.length} items (${shippedItems.length} shipped, ${notShipped} not shipped; human gates: ${pending.join(', ') || 'none'})`)

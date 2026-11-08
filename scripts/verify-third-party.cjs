// Third-party inventory verification (issue #88).
// Checks that every third-party artifact that ships (or is deliberately not
// shipped) is recorded in resources/provenance/third-party-inventory.json,
// that mirrored pins match the existing pin files, that THIRD_PARTY_NOTICES.md
// carries the same per-item ledger, and that the only pending
// (pending-maintainer-verification) items are the compiled human-gate list.
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')

if (process.argv[2] === '--root' && !process.argv[3]) throw new Error('--root requires a directory')
const root = process.argv[2] === '--root' ? resolve(process.argv[3]) : resolve(__dirname, '..')

// The tracked human gates. A pending-maintainer-verification item outside this
// list fails verification; resolving a gate requires deliberately updating
// this list together with the inventory, so the change is reviewed.
const TRACKED_HUMAN_GATES = ['linz-license-grant']

// extraResources mappings whose contents are first-party project data (own
// provenance records, own update trust anchor, own notices). Their files are
// exempt from per-file inventory claims; third-party claims about them stay
// covered by the dedicated axes below.
// resources/components is allowlisted in advance for PR #162 (issue #119):
// it ships the first-party component catalog (catalog.json plus the
// build-written components-lock.json), so the post-merge tree verifies
// without a follow-up change here.
const FIRST_PARTY_EXTRA_RESOURCES = ['resources/provenance', 'resources/updates', 'THIRD_PARTY_NOTICES.md', 'resources/components']

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
const pinnedPaths = new Map()
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
  if (item.kind === 'binary') {
    if (!item.distribution?.files || typeof item.distribution.files !== 'object') {
      fail('INVENTORY_SCHEMA', `${where}: binary items need distribution.files (path -> sha256)`)
    } else if (item.distribution.ships) {
      for (const path of Object.keys(item.distribution.files)) {
        if (pinnedPaths.has(path)) fail('INVENTORY_SCHEMA', `duplicate pinned path ${path} in ${item.id} and ${pinnedPaths.get(path)}`)
        pinnedPaths.set(path, item.id)
      }
    }
  }
  if (item.kind === 'framework' && item.id !== `${item.name}@${item.version}`) {
    fail('INVENTORY_SCHEMA', `${where}: framework items need name, version and id <name>@<version>`)
  }
}
const seenGateIds = new Set()
for (const gate of Array.isArray(inventory.humanGates) ? inventory.humanGates : []) {
  if (!gate.id || !gate.item || !gate.owner || !gate.reason || !gate.userNotice) fail('INVENTORY_SCHEMA', 'human gate entries need id, item, owner, reason and userNotice')
  if (gate.id && seenGateIds.has(gate.id)) fail('INVENTORY_SCHEMA', `duplicate human gate id ${gate.id}`)
  if (gate.id) seenGateIds.add(gate.id)
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

const shippedItems = items.filter(item => item.distribution.ships)

// 2. npm axis: the effective shipped set is the package-lock closure reachable
// from package.json dependencies and optionalDependencies (dependencies +
// optionalDependencies edges, skipping dev-marked entries). Entry-level
// peerDependencies are deliberately NOT walked: npm auto-installs peer type
// packages as dev-marked-adjacent tooling, and electron-builder collects the
// production tree the same way (the not-shipped dev-dependency item covers
// them). Keys are name@version so same-name multi-version closures cannot
// collapse onto one inventory entry.
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
const roots = [...new Set([].concat(Object.keys(pkg.dependencies || {}), Object.keys(pkg.optionalDependencies || {}), Object.keys(pkg.peerDependencies || {})))]
const queue = roots.map(name => resolveLockPath('', name)).filter(Boolean)
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
const shippedNpmByKey = new Map()
for (const [path, entry] of shippedNpm) shippedNpmByKey.set(`${path.replace(/.*node_modules\//, '')}@${entry.version}`, entry)
const inventoryNpm = new Map()
for (const item of items.filter(candidate => candidate.kind === 'npm-dependency')) {
  const key = `${item.name}@${item.version}`
  if (inventoryNpm.has(key)) fail('INVENTORY_SCHEMA', `duplicate inventory npm item for ${key}`)
  inventoryNpm.set(key, item)
}
for (const [key, entry] of shippedNpmByKey) {
  const item = inventoryNpm.get(key)
  if (!item) {
    fail('SHIPPED_NOT_INVENTORIED', `npm:${key} ships per package-lock.json but is not inventoried`)
    continue
  }
  if (item.license.declared !== entry.license) fail('PIN_DRIFT', `npm:${key} license "${item.license.declared}" drifted from package-lock.json "${entry.license}"`)
  if (item.pin.integrity !== entry.integrity) fail('PIN_DRIFT', `npm:${key} integrity pin drifted from package-lock.json`)
}
for (const [key, item] of inventoryNpm) {
  if (shippedNpmByKey.has(key)) continue
  if ((pkg.devDependencies || {})[item.name] || lockEntries.get(`node_modules/${item.name}`)?.dev) {
    fail('DEPENDENCY_CLASS_MISMATCH', `${item.id} is a dev dependency and must not be claimed as distributed`)
  } else {
    fail('INVENTORY_NOT_SHIPPED', `${item.id} claims shipment but is absent from the package-lock production closure`)
  }
}

// 3. Shipped-surface enumeration: parse the electron-builder.yml
// extraResources block. The parser assumes the small, regular shape this
// file keeps ("- from: X" / "to: Y" / "filter: [...]" list items); a richer
// YAML shape would need a real parser and a deliberate migration.
const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
function parseExtraResources(text) {
  const mappings = []
  let inBlock = false
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (/^extraResources:\s*$/.test(line)) { inBlock = true; continue }
    if (!inBlock) continue
    const entry = /^ {2}- from:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line)
    if (entry) { current = { from: entry[1], to: entry[1], exclusions: [] }; mappings.push(current); continue }
    if (current) {
      const to = /^ {4}to:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line)
      if (to) { current.to = to[1]; continue }
      const filter = /^ {4}filter:\s*(.+)$/.exec(line)
      if (filter) current.exclusions = [...filter[1].matchAll(/'([^']*)'/g)].map(match => match[1]).filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
    }
    if (/^\S/.test(line)) { inBlock = false; current = null }
  }
  return mappings
}
const mappings = parseExtraResources(builderConfig)
// Single-pass glob conversion ('**/' crosses directories including none,
// '**' is anything, '*' and '?' stay within one segment).
function globToRegExp(pattern) {
  let expression = ''
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]
    if (character === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { expression += '(?:.*/)?'; i += 2 } else { expression += '.*'; i += 1 }
      } else expression += '[^/]*'
    } else if (character === '?') expression += '[^/]'
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${expression}$`)
}
function walkSorted(directory) {
  const files = []
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  visit(directory)
  return files.sort()
}
// A shipped inventory item claims a packaged file either by an exact
// distribution.files pin (destination- or repository-relative) or, for
// assembled trees (runtime archives, runtime core, derivations), by a
// destination path prefix.
const exactClaims = new Map()
for (const item of shippedItems) {
  for (const [path, sha256] of Object.entries(item.distribution.files || {})) exactClaims.set(path, { item, sha256 })
}
const claimPrefixes = []
for (const item of shippedItems) {
  if (!['runtime-archive', 'runtime-source', 'source-derivation'].includes(item.kind)) continue
  const claim = String(item.distribution.path || '').split('（')[0]
  if (claim && !claim.includes('*')) claimPrefixes.push(claim.endsWith('/') ? claim : claim + '/')
}
const claimedByShipping = (repoPath, destinationPath) =>
  exactClaims.has(repoPath) || exactClaims.has(destinationPath) ||
  claimPrefixes.some(prefix => destinationPath.startsWith(prefix))
for (const mapping of mappings) {
  if (FIRST_PARTY_EXTRA_RESOURCES.includes(mapping.from)) continue
  const source = join(root, mapping.from)
  if (!existsSync(source)) {
    // Build-output directories (e.g. .runtime) exist only after assembly;
    // their contents are claimed via the lock/core axes, so require at least
    // one shipping item to claim the destination.
    if (!claimPrefixes.some(prefix => prefix.startsWith(mapping.to.endsWith('/') ? mapping.to : mapping.to + '/'))) {
      fail('SHIPPED_NOT_INVENTORIED', `extraResources mapping ${mapping.from} -> ${mapping.to} ships content no inventory item claims`)
    }
    continue
  }
  const exclusions = mapping.exclusions.map(globToRegExp)
  const base = statSync(source).isFile() ? [source] : walkSorted(source)
  for (const file of base) {
    const repoPath = relative(root, file).replace(/\\/g, '/')
    const destinationPath = `${mapping.to}/${relative(source, file).replace(/\\/g, '/')}`
    if (exclusions.some(pattern => pattern.test(repoPath) || pattern.test(destinationPath))) continue
    if (!claimedByShipping(repoPath, destinationPath)) {
      fail('SHIPPED_NOT_INVENTORIED', `${repoPath} ships via extraResources ${mapping.from} -> ${mapping.to} but no shipping inventory item claims it`)
    }
  }
}
// Claim direction for assembled/packaged trees: items claiming runtime/ or
// provenance/ destinations require their builder mapping to still exist.
if (shippedItems.some(item => item.kind === 'runtime-archive') && !mappings.some(mapping => mapping.to === 'runtime')) {
  fail('INVENTORY_NOT_SHIPPED', 'runtime archives claim shipment but electron-builder.yml maps no extraResources destination runtime')
}
if (shippedItems.some(item => (item.distribution.path || '').includes('provenance')) && !mappings.some(mapping => mapping.from === 'resources/provenance')) {
  fail('INVENTORY_NOT_SHIPPED', 'provenance archives claim shipment but electron-builder.yml no longer maps resources/provenance')
}

// 4. Binary axis: every file under resources/occt (recursively) must be pinned
// byte-for-byte in linz-source.json and pinned by a SHIPPING binary item.
// occt ships via the extraResources mapping OR via NSIS File directives in
// resources/nsis/*.nsh — PR #162 (issue #119) repacks occt through NSIS
// sections, so both mechanisms count as shipping and removing the
// extraResources entry alone must not false-positive INVENTORY_NOT_SHIPPED.
const linzSource = readJson('resources/provenance/linz-source.json')
const nsisDir = join(root, 'resources/nsis')
const nsisShipsOcct = existsSync(nsisDir) && readdirSync(nsisDir).some(name => {
  if (!name.endsWith('.nsh')) return false
  return /File\b[^\r\n]*occt/i.test(readFileSync(join(nsisDir, name), 'utf8'))
})
const occtShipsViaBuilder = mappings.some(mapping => mapping.from === 'resources/occt')
for (const item of shippedItems.filter(candidate => candidate.kind === 'binary')) {
  if (!Object.keys(item.distribution.files || {}).some(path => path.startsWith('occt/'))) continue
  if (!occtShipsViaBuilder && !nsisShipsOcct) {
    fail('INVENTORY_NOT_SHIPPED', `${item.id} claims shipment but neither the extraResources resources/occt mapping nor an NSIS File directive ships it`)
  }
}
const occtDir = join(root, 'resources/occt')
for (const occtPath of walkSorted(occtDir)) {
  const relativeToOcct = relative(occtDir, occtPath).replace(/\\/g, '/')
  const pin = exactClaims.get(`occt/${relativeToOcct}`)
  if (!pin) fail('SHIPPED_NOT_INVENTORIED', `resources/occt/${relativeToOcct} ships but no shipping binary inventory item pins it`)
  const upstreamPin = linzSource.files[`resources/occt/${relativeToOcct}`]
  if (!upstreamPin) fail('SHIPPED_NOT_INVENTORIED', `resources/occt/${relativeToOcct} ships but is not pinned in linz-source.json`)
  const actual = createHash('sha256').update(readFileSync(occtPath)).digest('hex')
  if (upstreamPin && actual !== upstreamPin) fail('PIN_DRIFT', `resources/occt/${relativeToOcct} hash drifted from linz-source.json`)
  if (pin && upstreamPin && pin.sha256 !== upstreamPin) fail('PIN_DRIFT', `${pin.item.id} pin for occt/${relativeToOcct} drifted from linz-source.json`)
}
for (const [path, pin] of exactClaims) {
  if (path.startsWith('occt/') && !existsSync(join(root, 'resources', path))) fail('INVENTORY_NOT_SHIPPED', `${pin.item.id} pins ${path} but the file does not exist`)
}

// 5. Runtime axis: distribution.lock.json archives mirrored in the inventory,
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
for (const item of shippedItems) {
  for (const evidence of item.evidenceFiles || []) {
    if (!existsSync(join(root, evidence))) fail('INVENTORY_NOT_SHIPPED', `${item.id} evidence file ${evidence} is missing`)
  }
}

// 6. Framework axis: the Electron pin must agree across lock, builder and inventory.
const frameworks = items.filter(item => item.kind === 'framework')
if (!frameworks.length) fail('SHIPPED_NOT_INVENTORIED', 'the Electron distribution ships but no framework item records it')
if (frameworks.length > 1) fail('INVENTORY_SCHEMA', `expected one framework item, found ${frameworks.length}`)
const electronLock = lockEntries.get('node_modules/electron')
const builderElectron = /electronVersion:\s*['"]?([^\s'"]+)['"]?/.exec(builderConfig)?.[1]
for (const item of frameworks) {
  if (electronLock && item.version !== electronLock.version) fail('PIN_DRIFT', `${item.id} drifted from package-lock.json electron ${electronLock.version}`)
  if (builderElectron && item.version !== builderElectron) fail('PIN_DRIFT', `${item.id} drifted from electron-builder.yml electronVersion ${builderElectron}`)
}

// 7. Human gates: pending items must be exactly the tracked gate list.
const pending = items.filter(item => item.status === 'pending-maintainer-verification').map(item => item.id)
const gateIds = inventory.humanGates.map(gate => gate.id)
const gateItems = inventory.humanGates.map(gate => gate.item)
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set(b).size && a.every(entry => new Set(b).has(entry))
if (!sameSet(gateIds, TRACKED_HUMAN_GATES)) fail('PENDING_GATE_MISMATCH', `humanGates ${JSON.stringify(gateIds)} != tracked gates ${JSON.stringify(TRACKED_HUMAN_GATES)}`)
if (!sameSet(gateItems, pending)) fail('PENDING_GATE_MISMATCH', `pending items ${JSON.stringify(pending)} != gated items ${JSON.stringify(gateItems)}`)
for (const gate of inventory.humanGates) {
  if (!seenIds.has(gate.item)) fail('PENDING_GATE_MISMATCH', `gate ${gate.id} references unknown item ${gate.item}`)
}

// 8. Notices axis: THIRD_PARTY_NOTICES.md ledger rows (| `id` | … |, eight
// cells) must reference exactly the inventory item ids, each exactly once,
// and the license / upstream maintainer / responsible maintainer / ships /
// status cells must match the inventory fields. Component and source cells
// and all prose stay free-form.
let notices = ''
try {
  notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
} catch {
  fail('NOTICES_DRIFT', 'THIRD_PARTY_NOTICES.md is missing')
}
const ledgerRows = new Map()
for (const match of notices.matchAll(/^\| *`([^`]+)` *\|(.*)$/gm)) {
  const id = match[1]
  const cells = ['', ...match[2].split('|').slice(0, -1)].map(cell => cell.trim()).slice(1)
  if (ledgerRows.has(id)) fail('NOTICES_DRIFT', `THIRD_PARTY_NOTICES.md ledger lists ${id} more than once`)
  ledgerRows.set(id, cells)
}
for (const [id, cells] of ledgerRows) {
  const item = items.find(candidate => candidate.id === id)
  if (!item) {
    fail('NOTICES_DRIFT', `THIRD_PARTY_NOTICES.md ledger references unknown item ${id}`)
    continue
  }
  if (cells.length !== 7) {
    fail('NOTICES_DRIFT', `ledger row ${id} has ${cells.length} cells after the id, expected 7 (组件/来源/许可证/上游维护者/负责维护者/随包/状态)`)
    continue
  }
  const [component, source, license, upstreamMaintainer, maintainer, ships, status] = cells
  if (license !== item.license.declared) fail('NOTICES_DRIFT', `ledger row ${id} license cell "${license}" != inventory "${item.license.declared}"`)
  if (upstreamMaintainer !== item.upstream.maintainer) fail('NOTICES_DRIFT', `ledger row ${id} upstream maintainer cell != inventory`)
  if (maintainer !== item.maintainer) fail('NOTICES_DRIFT', `ledger row ${id} responsible maintainer cell != inventory`)
  if (ships !== (item.distribution.ships ? '是' : '否')) fail('NOTICES_DRIFT', `ledger row ${id} ships cell "${ships}" != ${item.distribution.ships ? '是' : '否'}`)
  if (!status.startsWith(item.status)) fail('NOTICES_DRIFT', `ledger row ${id} status cell "${status}" does not start with the inventory status "${item.status}"`)
  void component
  void source
}
for (const id of seenIds) if (!ledgerRows.has(id)) fail('NOTICES_DRIFT', `inventory item ${id} has no ledger row in THIRD_PARTY_NOTICES.md`)

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
const notShipped = items.length - shippedItems.length
console.log(`Verified third-party inventory: ${items.length} items (${shippedItems.length} shipped, ${notShipped} not shipped; human gates: ${gateIds.join(', ') || 'none'})`)

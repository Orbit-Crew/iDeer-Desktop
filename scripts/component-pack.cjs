// Issue 119: the offline component pack tool — 装后随时补装离线组件包.
//
//   node scripts/component-pack.cjs build --out <dir> [--root <repo>] [--components id,id]
//   node scripts/component-pack.cjs install --pack <dir> --to <install-dir>
//
// Both modes read only local paths the caller provides; there is no download
// path here at all. A pack carries the app version and one SHA-256 per file,
// and an install verifies that identity against the components-lock.json the
// installer shipped into <install-dir>/resources/components before a single
// byte is written — version drift and byte drift are refused loudly.
'use strict'

const { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { dirname, join, resolve } = require('node:path')
const { CatalogError, componentById, componentLock, loadCatalog } = require('./component-catalog.cjs')

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const RECEIPT_FILE = 'installed-packs.json'

class PackError extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'PackError'
    this.code = code
  }
}

function setKeys(object) {
  return Object.keys(object).sort().join(',')
}

/** One package-relative posix path that cannot escape or masquerade. */
function checkedRelative(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\\') ||
      value.startsWith('/') || /^[a-zA-Z]:/.test(value) || /[\0]/.test(value)) {
    throw new PackError('PACK_MANIFEST_INVALID', `${field} 必须是包内相对路径`)
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new PackError('PACK_MANIFEST_INVALID', `${field} 必须是包内相对路径`)
  }
  return value
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Build one offline pack directory from a local build tree. The manifest's
 * identity comes from componentLock — the same provenance-pinned hashes the
 * installer ships — so a pack can never be built from drifted bytes.
 */
function buildPack(root, outDir, requested) {
  const catalog = loadCatalog(root)
  const ids = requested ?? catalog.components.filter(item => item.status === 'available').map(item => item.id)
  for (const id of ids) {
    const component = componentById(catalog, id)
    if (!component) throw new PackError('COMPONENT_NOT_IN_CATALOG', `catalog 中没有组件 ${id}`)
    if (component.status !== 'available') {
      throw new PackError('COMPONENT_NOT_AVAILABLE',
        `组件 ${id} 不可打包（${component.status === 'pending' ? `待提供：${component.note}` : `已随主程序内置：${component.note}`}）`)
    }
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new PackError('PACK_OUTPUT_NOT_EMPTY', `输出目录必须为空: ${outDir}`)
  }
  const lock = componentLock(root)
  const manifest = { schema: 1, appVersion: lock.appVersion, components: [] }
  for (const id of ids) {
    const component = componentById(catalog, id)
    const files = component.artifact.files.map(file => ({
      path: file,
      sha256: lock.components[id].files[file],
      bytes: statSync(join(root, component.artifact.source, file)).size
    }))
    mkdirSync(join(outDir, 'files', id), { recursive: true })
    for (const file of component.artifact.files) {
      copyFileSync(join(root, component.artifact.source, file), join(outDir, 'files', id, file))
    }
    manifest.components.push({ id, name: component.name, dest: component.artifact.dest, files })
  }
  writeFileSync(join(outDir, 'component-pack.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

function readManifest(packDir) {
  const file = join(packDir, 'component-pack.json')
  if (!existsSync(file)) throw new PackError('PACK_MANIFEST_INVALID', `缺少组件包清单: ${file}`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PackError('PACK_MANIFEST_INVALID', 'component-pack.json 不是合法 JSON')
  }
  if (typeof manifest !== 'object' || manifest === null || setKeys(manifest) !== 'appVersion,components,schema' ||
      manifest.schema !== 1 || !VERSION_PATTERN.test(manifest.appVersion ?? '') || !Array.isArray(manifest.components)) {
    throw new PackError('PACK_MANIFEST_INVALID', '清单字段固定为 schema/appVersion/components')
  }
  for (const component of manifest.components) {
    if (typeof component !== 'object' || component === null ||
        setKeys(component) !== 'dest,files,id,name' || !Array.isArray(component.files)) {
      throw new PackError('PACK_MANIFEST_INVALID', '清单组件字段固定为 id/name/dest/files')
    }
    checkedRelative(component.id, 'components[].id')
    checkedRelative(component.dest, 'components[].dest')
    for (const file of component.files) {
      if (typeof file !== 'object' || file === null || setKeys(file) !== 'bytes,path,sha256' ||
          typeof file.bytes !== 'number' || !SHA256_PATTERN.test(file.sha256 ?? '')) {
        throw new PackError('PACK_MANIFEST_INVALID', '清单文件字段固定为 path/sha256/bytes')
      }
      checkedRelative(file.path, 'components[].files[].path')
    }
  }
  return manifest
}

function readLock(installDir) {
  const file = join(installDir, 'resources/components/components-lock.json')
  if (!existsSync(file)) {
    throw new PackError('INSTALL_DIR_INVALID',
      `目录缺少安装器随包的组件版本锁（不是 iDeer 安装输出？）: ${file}`)
  }
  let lock
  try {
    lock = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PackError('INSTALL_DIR_INVALID', 'components-lock.json 不是合法 JSON')
  }
  if (typeof lock !== 'object' || lock === null || lock.schema !== 1 ||
      !VERSION_PATTERN.test(lock.appVersion ?? '') || typeof lock.components !== 'object') {
    throw new PackError('INSTALL_DIR_INVALID', 'components-lock.json 形状非法')
  }
  return lock
}

function readReceipts(installDir) {
  const file = join(installDir, 'resources/components', RECEIPT_FILE)
  if (!existsSync(file)) return { schema: 1, packs: [] }
  let receipts
  try {
    receipts = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PackError('RECEIPT_INVALID', `${RECEIPT_FILE} 不是合法 JSON`)
  }
  if (typeof receipts !== 'object' || receipts === null || receipts.schema !== 1 || !Array.isArray(receipts.packs)) {
    throw new PackError('RECEIPT_INVALID', `${RECEIPT_FILE} 形状非法`)
  }
  return receipts
}

/**
 * Install one verified pack into an existing installation. The whole pack is
 * verified (version lock + every byte) before the first write, and every
 * destination byte is re-verified after the staged copy lands.
 */
function installPack(packDir, installDir) {
  const manifest = readManifest(packDir)
  const lock = readLock(installDir)
  if (manifest.appVersion !== lock.appVersion) {
    throw new PackError('VERSION_LOCK_MISMATCH',
      `组件包版本 ${manifest.appVersion} 与安装版本 ${lock.appVersion} 不一致（版本锁定拒绝补装）`)
  }
  // Verify everything first; a rejected pack leaves the installation intact.
  const planned = []
  for (const component of manifest.components) {
    const pinned = lock.components[component.id]
    if (!pinned || typeof pinned !== 'object' || typeof pinned.dest !== 'string') {
      throw new PackError('COMPONENT_NOT_IN_LOCK', `安装目录的版本锁不认识组件 ${component.id}`)
    }
    if (component.dest !== pinned.dest) {
      throw new PackError('VERSION_LOCK_MISMATCH',
        `组件 ${component.id} 的安装位置与版本锁不一致（${component.dest} != ${pinned.dest}）`)
    }
    for (const file of component.files) {
      const locked = typeof pinned.files === 'object' ? pinned.files[file.path] : undefined
      if (locked === undefined) {
        throw new PackError('VERSION_LOCK_MISMATCH', `版本锁没有固定组件 ${component.id} 的 ${file.path}`)
      }
      const source = join(packDir, 'files', component.id, file.path)
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new PackError('PACK_HASH_MISMATCH', `包内缺少文件 ${component.id}/${file.path}`)
      }
      if (sha256File(source) !== file.sha256 || statSync(source).size !== file.bytes) {
        throw new PackError('PACK_HASH_MISMATCH', `包内文件 ${component.id}/${file.path} 与清单哈希不一致`)
      }
      if (file.sha256 !== locked) {
        throw new PackError('VERSION_LOCK_MISMATCH',
          `包内文件 ${component.id}/${file.path} 与安装版本锁固定哈希不一致（版本锁定拒绝补装）`)
      }
      planned.push({ component, file, source })
    }
  }
  // Staged copy + rename per file, destination re-verified after landing.
  // Destinations stay posix-relative from the manifest and are joined with the
  // platform's own separator — never a hard-coded backslash.
  for (const { component, file, source } of planned) {
    const destination = join(installDir, ...component.dest.split('/'), file.path)
    mkdirSync(dirname(destination), { recursive: true })
    const staged = `${destination}.pack-stage-${process.pid}`
    try {
      copyFileSync(source, staged)
      renameSync(staged, destination)
    } finally {
      rmSync(staged, { force: true })
    }
    if (sha256File(destination) !== file.sha256) {
      throw new PackError('INSTALL_COPY_FAILED', `补装后的 ${component.id}/${file.path} 校验失败`)
    }
  }
  const receipts = readReceipts(installDir)
  receipts.packs.push({
    appVersion: manifest.appVersion,
    components: manifest.components.map(component => component.id),
    files: Object.fromEntries(manifest.components.map(component =>
      [component.id, Object.fromEntries(component.files.map(file => [file.path, file.sha256]))])),
    installedAt: new Date().toISOString()
  })
  mkdirSync(join(installDir, 'resources/components'), { recursive: true })
  writeFileSync(join(installDir, 'resources/components', RECEIPT_FILE), JSON.stringify(receipts, null, 2) + '\n')
  return { installed: manifest.components.map(component => component.id) }
}

function usage() {
  return [
    'usage:',
    '  component-pack.cjs build --out <dir> [--root <repo>] [--components id,id]',
    '  component-pack.cjs install --pack <dir> --to <install-dir>'
  ].join('\n')
}

function main(argv) {
  // Strict parsing: every argument must be the command, a known option name,
  // or that option's value — an unrecognized or stray token is a usage error,
  // never a silently ignored flag.
  const consumed = new Set([0])
  const option = (name) => {
    const index = argv.indexOf(name)
    if (index === -1) return undefined
    const value = argv[index + 1]
    if (typeof value !== 'string' || value.startsWith('--')) throw new PackError('PACK_USAGE', `${name} 需要一个参数`)
    consumed.add(index)
    consumed.add(index + 1)
    return value
  }
  const pathOption = (name) => {
    const value = option(name)
    return value === undefined ? undefined : resolve(value)
  }
  const command = argv[0]
  if (command === 'build') {
    const out = pathOption('--out')
    if (!out) throw new PackError('PACK_USAGE', usage())
    const root = resolve(option('--root') ?? '.')
    const requested = option('--components')
    const stray = argv.filter((_, index) => !consumed.has(index))
    if (stray.length > 0) throw new PackError('PACK_USAGE', `无法识别的参数: ${stray.join(' ')}\n${usage()}`)
    const manifest = buildPack(root, out, requested ? requested.split(',').map(id => id.trim()) : undefined)
    console.log(`Built pack for ${manifest.appVersion}: ${manifest.components.map(item => item.id).join(', ')} -> ${out}`)
    return
  }
  if (command === 'install') {
    const pack = pathOption('--pack')
    const to = pathOption('--to')
    if (!pack || !to) throw new PackError('PACK_USAGE', usage())
    const stray = argv.filter((_, index) => !consumed.has(index))
    if (stray.length > 0) throw new PackError('PACK_USAGE', `无法识别的参数: ${stray.join(' ')}\n${usage()}`)
    const result = installPack(pack, to)
    console.log(`Installed components for: ${result.installed.join(', ')} -> ${to}`)
    return
  }
  throw new PackError('PACK_USAGE', usage())
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof PackError || error instanceof CatalogError) {
      console.error(error.message)
      process.exitCode = 1
    } else {
      throw error
    }
  }
}

module.exports = { PackError, buildPack, installPack }

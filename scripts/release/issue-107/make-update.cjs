#!/usr/bin/env node
// Produce the exact directory served at /updates/desktop/ or carried offline.
// Private keys are read only by this maintainer process, never copied out.
const fs = require('node:fs')
const path = require('node:path')
const { createHash, createPrivateKey, sign } = require('node:crypto')
const { extractFile } = require('@electron/asar')
const { buildSync } = require('esbuild')
const { Module } = require('node:module')

const repository = path.resolve(__dirname, '../../..')
const maxBytes = 2 * 1024 * 1024 * 1024
const isInside = (base, target) => { const relative = path.relative(base, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) }

// Compile the checked-in client parser in memory so publishing and consuming
// share one schema. No generated code or private key is written to the repo.
function clientParser() {
  const filename = path.join(repository, 'src/main/updates.ts')
  const compiled = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', target: 'node16',
    format: 'cjs', write: false }).outputFiles[0].text
  const loaded = new Module(filename, module)
  loaded.paths = module.paths
  loaded._compile(compiled, filename)
  return loaded.exports.parseManifest
}

function programPath(value) {
  if (typeof value !== 'string' || value.length > 512 || value.split('/').some(part =>
      !/^[a-z0-9_-][a-z0-9._-]*$/.test(part) || part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part))) throw new Error('UPDATE_RELEASE_PATH_INVALID')
  if (value !== 'resources/app.asar' && !/^resources\/runtime\/core\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.py$/.test(value) &&
      !['resources/runtime/distribution.lock.json', 'resources/runtime/source-manifest.json', 'resources/runtime/pyproject.toml'].includes(value)) throw new Error('UPDATE_RELEASE_PATH_INVALID')
  return value
}

function regular(base, relative) {
  let current = base
  if (fs.lstatSync(base).isSymbolicLink()) throw new Error('UPDATE_RELEASE_REPARSE_REJECTED')
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('UPDATE_RELEASE_REPARSE_REJECTED')
  }
  if (!isInside(fs.realpathSync(base), fs.realpathSync(current)) || !fs.statSync(current).isFile()) throw new Error('UPDATE_RELEASE_FILE_INVALID')
  return current
}

function facts(file) {
  const bytes = fs.statSync(file).size
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) throw new Error('UPDATE_RELEASE_TOO_LARGE')
  const handle = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256')
  try {
    for (;;) { const count = fs.readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)) }
  } finally { fs.closeSync(handle) }
  return { bytes, sha256: hash.digest('hex') }
}

function main() {
  const args = process.argv.slice(2)
  const flag = name => {
    const index = args.indexOf(name)
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`missing ${name}`)
    return args[index + 1]
  }
  const definition = JSON.parse(fs.readFileSync(path.resolve(flag('--manifest')), 'utf8'))
  const payloadRoot = path.resolve(flag('--payload-root'))
  const outPath = path.resolve(flag('--out'))
  if (outPath === payloadRoot || isInside(payloadRoot, outPath) || isInside(outPath, payloadRoot) ||
      (fs.existsSync(outPath) && fs.readdirSync(outPath).length)) throw new Error('UPDATE_RELEASE_OUTPUT_MUST_BE_SEPARATE_AND_EMPTY')
  let keyPem = process.env.UPDATES_PRIVATE_KEY_PEM
  if (!keyPem) {
    const privatePath = fs.realpathSync(path.resolve(flag('--private-key')))
    if (privatePath === repository || isInside(repository, privatePath)) throw new Error('UPDATE_RELEASE_PRIVATE_KEY_OUTSIDE_REPOSITORY_REQUIRED')
    keyPem = fs.readFileSync(privatePath, 'utf8')
  }
  const key = createPrivateKey(keyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('UPDATE_RELEASE_ED25519_REQUIRED')
  if (!definition.desktop || !definition.runtime || !definition.baseline || !definition.dataCompatibility ||
      !Array.isArray(definition.files) || !Array.isArray(definition.deletions)) throw new Error('UPDATE_RELEASE_DEFINITION_INVALID')
  const asar = regular(payloadRoot, 'resources/app.asar')
  const lock = regular(payloadRoot, 'resources/runtime/distribution.lock.json')
  const version = JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version
  const python = JSON.parse(fs.readFileSync(lock, 'utf8')).python
  if (definition.desktop.version !== version || definition.runtime.python !== python) throw new Error('UPDATE_RELEASE_TARGET_COMBINATION_MISMATCH')
  definition.desktop.asarSHA256 = facts(asar).sha256
  definition.runtime.lockSHA256 = facts(lock).sha256
  if (definition.kind === 'patch' && (definition.desktop.electron !== definition.baseline.electronVersion ||
      definition.runtime.python !== definition.baseline.runtimePython)) throw new Error('UPDATE_REQUIRES_FULL_INSTALLER')
  const affected = [...definition.files.map(entry => programPath(entry.path)), ...definition.deletions.map(programPath)]
  if (new Set(affected).size !== affected.length || affected.some((target, index) => affected.some((other, otherIndex) =>
      index !== otherIndex && target.startsWith(other + '/')))) throw new Error('UPDATE_RELEASE_PATH_CONFLICT')
  let total = 0
  const copies = []
  if (definition.kind === 'patch') {
    delete definition.installer
    definition.files = definition.files.map(entry => {
      const source = regular(payloadRoot, entry.path), actual = facts(source)
      total += actual.bytes
      if (total > maxBytes) throw new Error('UPDATE_RELEASE_TOO_LARGE')
      copies.push({ source, relative: path.join('files', entry.path), actual })
      return { path: entry.path, ...actual }
    })
  } else if (definition.kind === 'full') {
    if (definition.files.length || definition.deletions.length) throw new Error('UPDATE_RELEASE_FULL_FILE_LIST_INVALID')
    const source = path.resolve(flag('--installer'))
    if (!fs.statSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('UPDATE_RELEASE_INSTALLER_INVALID')
    definition.installer = { path: 'installer.exe', ...facts(source) }
    if (!definition.installer.bytes) throw new Error('UPDATE_RELEASE_INSTALLER_INVALID')
    copies.push({ source, relative: 'installer.exe', actual: definition.installer })
  } else throw new Error('UPDATE_RELEASE_KIND_INVALID')
  const text = JSON.stringify(definition)
  clientParser()(text)
  const signature = sign(null, Buffer.from(text, 'utf8'), key)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const staging = fs.mkdtempSync(path.join(path.dirname(outPath), '.ideer-release-'))
  try {
    for (const { source, relative, actual } of copies) {
      const destination = path.join(staging, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(source, destination)
      const copied = facts(destination)
      if (copied.sha256 !== actual.sha256 || copied.bytes !== actual.bytes) throw new Error('UPDATE_RELEASE_COPY_MISMATCH')
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), text)
    fs.writeFileSync(path.join(staging, 'manifest.sig'), signature.toString('hex') + '\n')
    if (fs.existsSync(outPath)) fs.rmdirSync(outPath) // Only the prechecked empty directory may be replaced.
    fs.renameSync(staging, outPath)
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  console.log('signed release written to', outPath)
}

try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }

// Issue 107: signed update manifest verification.
// Checking and importing only ever produce a verified pending state; nothing
// here writes to the program directory or user data, and no private key ever
// reaches this process. The trusted public key ships inside the app.
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { controlledBytes, controlledOrigin } from './controlled-http'

export type UpdateKind = 'patch' | 'full'

export interface UpdateFileEntry { path: string; sha256: string; bytes: number }
export interface UpdateManifest {
  version: 1
  kind: UpdateKind
  publishedAt: string
  desktop: { version: string; electron: string; asarSHA256: string }
  runtime: { python: string; lockSHA256: string }
  serverCompatibility: { minProtocol: number; notes: string }
  baseline: { desktopVersion: string; electronVersion: string; runtimePython: string; dataFormat: number }
  dataCompatibility: { targetFormat: number; readableFormats: number[] }
  installer?: { path: 'installer.exe'; sha256: string; bytes: number }
  deletions: string[]
  files: UpdateFileEntry[]
}

export interface PendingUpdate {
  kind: UpdateKind
  source: 'online' | 'offline'
  manifest: UpdateManifest
  verifiedAt: string
  advice: string
}

export interface UpdateVerification {
  ok: boolean
  error: string
  pending: PendingUpdate | null
}

export interface UpdateCurrent {
  desktopVersion: string
  electronVersion: string
  runtimePython: string
  protocolVersion: number
  dataFormat: number
  readableFormats: number[]
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_FILES = 2000
const MAX_DELETE = 500
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const HEX64 = /^[0-9a-f]{64}$/
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/

/** Deterministic JSON over exactly the manifest object, no whitespace. */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function verifySignature(manifestText: string, signatureHex: string, publicKeyPem: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(signatureHex)) return false
    const key: KeyObject = createPublicKey(publicKeyPem)
    // Ed25519 signs the manifest bytes directly; the digest name is ignored.
    return cryptoVerify(null, Buffer.from(manifestText, 'utf8'), { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureHex, 'hex'))
  } catch {
    return false
  }
}

function safeRelativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`UPDATE_${field}_INVALID`)
  if (value.length > 512) throw new Error(`UPDATE_${field}_INVALID`)
  if (value.includes('\\') || value.includes('\0')) throw new Error(`UPDATE_${field}_INVALID`)
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('~')) throw new Error(`UPDATE_${field}_OUTSIDE_PROGRAM_DIRECTORY`)
  const parts = value.split('/')
  if (parts.some(part => !/^[a-z0-9_-][a-z0-9._-]*$/.test(part) || part.endsWith('.') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part))) throw new Error(`UPDATE_${field}_OUTSIDE_PROGRAM_DIRECTORY`)
  if (value !== 'resources/app.asar' && !/^resources\/runtime\/core\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.py$/.test(value) &&
      !['resources/runtime/distribution.lock.json', 'resources/runtime/source-manifest.json', 'resources/runtime/pyproject.toml'].includes(value)) {
    throw new Error(`UPDATE_${field}_OUTSIDE_PROGRAM_DIRECTORY`)
  }
  return value
}

function parseManifest(text: string): UpdateManifest {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('UPDATE_MANIFEST_TOO_LARGE')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('UPDATE_MANIFEST_MALFORMED') }
  const m = value as UpdateManifest
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (m.version !== 1) throw new Error('UPDATE_MANIFEST_VERSION_UNSUPPORTED')
  if (m.kind !== 'patch' && m.kind !== 'full') throw new Error('UPDATE_MANIFEST_KIND_INVALID')
  if (typeof m.publishedAt !== 'string' || Number.isNaN(Date.parse(m.publishedAt))) throw new Error('UPDATE_MANIFEST_MALFORMED')
  for (const section of ['desktop', 'runtime', 'serverCompatibility', 'baseline', 'dataCompatibility'] as const) {
    if (!m[section] || typeof m[section] !== 'object' || Array.isArray(m[section])) throw new Error('UPDATE_MANIFEST_MALFORMED')
  }
  if (!SEMVER.test(m.desktop?.version || '') || !SEMVER.test(m.desktop?.electron || '') || !HEX64.test(m.desktop?.asarSHA256 || '')) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(m.runtime?.python || '') || !HEX64.test(m.runtime?.lockSHA256 || '')) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (!Number.isInteger(m.serverCompatibility?.minProtocol) || m.serverCompatibility.minProtocol < 1) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (typeof m.serverCompatibility.notes !== 'string' || m.serverCompatibility.notes.length > 2000) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (!SEMVER.test(m.baseline?.desktopVersion || '') || !SEMVER.test(m.baseline?.electronVersion || '') ||
      !SEMVER.test(m.baseline?.runtimePython || '') || !Number.isSafeInteger(m.baseline.dataFormat) || m.baseline.dataFormat < 1) throw new Error('UPDATE_MANIFEST_MALFORMED')
  const compatibility = m.dataCompatibility
  if (!Number.isSafeInteger(compatibility.targetFormat) || compatibility.targetFormat < 1 ||
      !Array.isArray(compatibility.readableFormats) || !compatibility.readableFormats.length || compatibility.readableFormats.length > 100 ||
      compatibility.readableFormats.some(format => !Number.isSafeInteger(format) || format < 1) ||
      new Set(compatibility.readableFormats).size !== compatibility.readableFormats.length ||
      !compatibility.readableFormats.includes(compatibility.targetFormat)) throw new Error('UPDATE_DATA_COMPATIBILITY_INVALID')
  if (!Array.isArray(m.deletions) || m.deletions.length > MAX_DELETE) throw new Error('UPDATE_DELETE_LIST_INVALID')
  for (const entry of m.deletions) safeRelativePath(entry, 'DELETE')
  if (!Array.isArray(m.files) || m.files.length > MAX_FILES) throw new Error('UPDATE_FILE_LIST_INVALID')
  let total = 0
  const seen = new Set<string>()
  for (const entry of m.files) {
    if (!entry || typeof entry !== 'object') throw new Error('UPDATE_FILE_LIST_INVALID')
    safeRelativePath(entry.path, 'FILE')
    if (!HEX64.test(entry.sha256 || '')) throw new Error('UPDATE_FILE_LIST_INVALID')
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) throw new Error('UPDATE_FILE_LIST_INVALID')
    total += entry.bytes
    if (total > MAX_TOTAL_BYTES) throw new Error('UPDATE_TOO_LARGE')
    if (seen.has(entry.path.toLowerCase())) throw new Error('UPDATE_FILE_LIST_INVALID')
    seen.add(entry.path)
  }
  const affected = [...m.files.map(entry => entry.path), ...m.deletions]
  if (new Set(affected).size !== affected.length || affected.some((path, index) =>
      affected.some((other, otherIndex) => index !== otherIndex && path.startsWith(other + '/')))) throw new Error('UPDATE_PATH_CONFLICT')
  const asar = m.files.find(entry => entry.path === 'resources/app.asar')
  const lock = m.files.find(entry => entry.path === 'resources/runtime/distribution.lock.json')
  if ((asar && asar.sha256 !== m.desktop.asarSHA256) || (lock && lock.sha256 !== m.runtime.lockSHA256)) throw new Error('UPDATE_COMBINATION_HASH_MISMATCH')
  if (m.kind === 'patch') {
    if (m.installer || (!asar && m.desktop.version !== m.baseline.desktopVersion)) throw new Error('UPDATE_PATCH_COMBINATION_INVALID')
    if (m.deletions.some(path => ['resources/app.asar', 'resources/runtime/distribution.lock.json', 'resources/runtime/core/desktop.py'].includes(path))) throw new Error('UPDATE_DELETE_LIST_INVALID')
  } else if (!m.installer || m.installer.path !== 'installer.exe' || !HEX64.test(m.installer.sha256 || '') ||
      !Number.isSafeInteger(m.installer.bytes) || m.installer.bytes <= 0 || m.installer.bytes > MAX_TOTAL_BYTES || m.files.length || m.deletions.length) {
    throw new Error('UPDATE_FULL_INSTALLER_INVALID')
  }
  return m
}

/** Full verification pipeline shared by online check and offline import. */
export function verifyUpdate(manifestText: string, signatureHex: string, publicKeyPem: string,
    current: UpdateCurrent, source: 'online' | 'offline'): UpdateVerification {
  try {
    if (!verifySignature(manifestText, signatureHex, publicKeyPem)) throw new Error('UPDATE_SIGNATURE_INVALID')
    // The Ed25519 signature already covers the exact manifest bytes, so a
    // swapped or rewritten manifest cannot verify regardless of its content.
    const manifest = parseManifest(manifestText)
    if (manifest.baseline.desktopVersion !== current.desktopVersion ||
        manifest.baseline.runtimePython !== current.runtimePython || manifest.baseline.electronVersion !== current.electronVersion ||
        manifest.baseline.dataFormat !== current.dataFormat) throw new Error('UPDATE_BASELINE_MISMATCH')
    if (!manifest.dataCompatibility.readableFormats.includes(current.dataFormat)) throw new Error('UPDATE_DATA_INCOMPATIBLE')
    if (manifest.kind === 'patch' && (manifest.desktop.electron !== current.electronVersion ||
        manifest.runtime.python !== current.runtimePython)) throw new Error('UPDATE_REQUIRES_FULL_INSTALLER')
    if (manifest.kind === 'patch' && !current.readableFormats.includes(manifest.dataCompatibility.targetFormat)) throw new Error('UPDATE_DATA_INCOMPATIBLE')
    if (manifest.serverCompatibility.minProtocol > current.protocolVersion) throw new Error('UPDATE_SERVER_INCOMPATIBLE')
    const advice = manifest.kind === 'full'
      ? '底层 Electron/Python 组件变化：需要完整安装包，此清单不作为就地补丁安装。'
      : '校验通过，补丁已就绪；安装需要你在任务排空后单独确认。'
    return { ok: true, error: '', pending: { kind: manifest.kind, source, manifest, verifiedAt: new Date().toISOString(), advice } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'UPDATE_REJECTED', pending: null }
  }
}

/** Online check against the Server-provided controlled address. */
export async function checkOnline(origin: string, current: UpdateCurrent,
    publicKeyPem: string): Promise<UpdateVerification> {
  try { controlledOrigin(origin) } catch { throw new Error('UPDATE_ORIGIN_INVALID') }
  const fetchText = async (path: string): Promise<string> => {
    try { return (await controlledBytes(origin, '/' + path, { maxBytes: MAX_MANIFEST_BYTES })).toString('utf8') }
    catch (error) { throw new Error(String(error instanceof Error ? error.message : error).replace('CONTROLLED_', 'UPDATE_')) }
  }
  const manifestText = await fetchText('updates/desktop/manifest.json')
  const signatureHex = (await fetchText('updates/desktop/manifest.sig')).trim()
  return verifyUpdate(manifestText, signatureHex, publicKeyPem, current, 'online')
}

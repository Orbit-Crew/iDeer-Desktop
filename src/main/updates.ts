// Issue 107: signed update manifest verification.
// Checking and importing only ever produce a verified pending state; nothing
// here writes to the program directory or user data, and no private key ever
// reaches this process. The trusted public key ships inside the app.
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

export type UpdateKind = 'patch' | 'full'

export interface UpdateFileEntry { path: string; sha256: string; bytes: number }
export interface UpdateManifest {
  version: 1
  kind: UpdateKind
  publishedAt: string
  desktop: { version: string; asarSHA256: string }
  runtime: { python: string; lockSHA256: string }
  serverCompatibility: { minProtocol: number; notes: string }
  baseline: { desktopVersion: string; runtimePython: string }
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

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_FILES = 2000
const MAX_DELETE = 500
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const ALLOWED_PREFIXES = ['out/', 'resources/']
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
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`UPDATE_${field}_OUTSIDE_PROGRAM_DIRECTORY`)
  if (!ALLOWED_PREFIXES.some(prefix => value.startsWith(prefix))) throw new Error(`UPDATE_${field}_OUTSIDE_PROGRAM_DIRECTORY`)
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
  for (const section of ['desktop', 'runtime', 'serverCompatibility', 'baseline'] as const) {
    if (!m[section] || typeof m[section] !== 'object') throw new Error('UPDATE_MANIFEST_MALFORMED')
  }
  if (!SEMVER.test(m.desktop?.version || '') || !HEX64.test(m.desktop?.asarSHA256 || '')) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(m.runtime?.python || '') || !HEX64.test(m.runtime?.lockSHA256 || '')) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (!Number.isInteger(m.serverCompatibility?.minProtocol) || m.serverCompatibility.minProtocol < 1) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (typeof m.serverCompatibility.notes !== 'string' || m.serverCompatibility.notes.length > 2000) throw new Error('UPDATE_MANIFEST_MALFORMED')
  if (!SEMVER.test(m.baseline?.desktopVersion || '') || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(m.baseline?.runtimePython || '')) throw new Error('UPDATE_MANIFEST_MALFORMED')
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
    if (seen.has(entry.path)) throw new Error('UPDATE_FILE_LIST_INVALID')
    seen.add(entry.path)
  }
  return m
}

/** Full verification pipeline shared by online check and offline import. */
export function verifyUpdate(manifestText: string, signatureHex: string, publicKeyPem: string,
    current: { desktopVersion: string; runtimePython: string; protocolVersion: number }, source: 'online' | 'offline'): UpdateVerification {
  try {
    if (!verifySignature(manifestText, signatureHex, publicKeyPem)) throw new Error('UPDATE_SIGNATURE_INVALID')
    // The Ed25519 signature already covers the exact manifest bytes, so a
    // swapped or rewritten manifest cannot verify regardless of its content.
    const manifest = parseManifest(manifestText)
    if (manifest.baseline.desktopVersion !== current.desktopVersion ||
        manifest.baseline.runtimePython !== current.runtimePython) throw new Error('UPDATE_BASELINE_MISMATCH')
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
export async function checkOnline(origin: string, current: { desktopVersion: string; runtimePython: string; protocolVersion: number },
    publicKeyPem: string): Promise<UpdateVerification> {
  let base: URL
  try {
    base = new URL(origin)
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error()
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error()
  } catch { throw new Error('UPDATE_ORIGIN_INVALID') }
  if (base.username || base.password || base.search || base.hash) throw new Error('UPDATE_ORIGIN_INVALID')
  const fetchText = async (path: string): Promise<string> => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(response.status === 404 ? 'UPDATE_NOT_PUBLISHED' : 'UPDATE_SERVER_ERROR')
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('UPDATE_MANIFEST_TOO_LARGE')
    return text
  }
  const manifestText = await fetchText('updates/desktop/manifest.json')
  const signatureHex = (await fetchText('updates/desktop/manifest.sig')).trim()
  return verifyUpdate(manifestText, signatureHex, publicKeyPem, current, 'online')
}

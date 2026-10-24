// Issue 110: the Server-provided compatibility gate. The declaration is a
// signed, controlled document served next to the update manifests. It can
// mark the whole combination compatible, disable single capabilities, or
// declare a core incompatibility that stops new local tasks. A capability
// switch never grants anything: Server authorization and local policy still
// decide every request, and all records stay readable in every level.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

export type CompatibilityLevel = 'compatible' | 'capability' | 'core'

export interface CompatibilityDeclaration {
  version: 1
  level: CompatibilityLevel
  disabledCapabilities: string[]
  minProtocol: number
  notes: string
  candidateCombo: { desktop: string; runtime: string; server: string }
}

export interface CompatibilityEvaluation {
  ok: boolean
  error: string
  declaration: CompatibilityDeclaration | null
  /** True when the requested capability is stopped by the current level. */
  advice: string
}

const MAX_BYTES = 512 * 1024
const KNOWN_CAPABILITIES = ['local.files.read', 'local.files.write', 'local.files.list', 'local.files.search', 'local.python', 'local.artifacts.upload']

function parse(text: string): CompatibilityDeclaration {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('COMPAT_MANIFEST_TOO_LARGE')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('COMPAT_MANIFEST_MALFORMED') }
  const d = value as CompatibilityDeclaration
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('COMPAT_MANIFEST_MALFORMED')
  if (d.version !== 1) throw new Error('COMPAT_MANIFEST_VERSION_UNSUPPORTED')
  if (!['compatible', 'capability', 'core'].includes(d.level)) throw new Error('COMPAT_MANIFEST_LEVEL_INVALID')
  if (!Array.isArray(d.disabledCapabilities) ||
      d.disabledCapabilities.some(cap => !KNOWN_CAPABILITIES.includes(cap)) ||
      new Set(d.disabledCapabilities).size !== d.disabledCapabilities.length) throw new Error('COMPAT_MANIFEST_CAPABILITY_INVALID')
  if (d.level === 'compatible' && d.disabledCapabilities.length) throw new Error('COMPAT_MANIFEST_CAPABILITY_INVALID')
  if (d.level === 'core' && d.disabledCapabilities.length) throw new Error('COMPAT_MANIFEST_CAPABILITY_INVALID')
  if (!Number.isInteger(d.minProtocol) || d.minProtocol < 1) throw new Error('COMPAT_MANIFEST_MALFORMED')
  if (typeof d.notes !== 'string' || d.notes.length > 2000) throw new Error('COMPAT_MANIFEST_MALFORMED')
  if (!d.candidateCombo || typeof d.candidateCombo !== 'object' ||
      [d.candidateCombo.desktop, d.candidateCombo.runtime, d.candidateCombo.server]
        .some(field => typeof field !== 'string' || !field || field.length > 128)) throw new Error('COMPAT_MANIFEST_MALFORMED')
  return d
}

export function verifySignature(text: string, signatureHex: string, publicKeyPem: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(signatureHex)) return false
    return cryptoVerify(null, Buffer.from(text, 'utf8'), { key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureHex, 'hex'))
  } catch { return false }
}

export function evaluate(text: string, signatureHex: string, publicKeyPem: string,
    current: { protocolVersion: number }): CompatibilityEvaluation {
  try {
    if (!verifySignature(text, signatureHex, publicKeyPem)) throw new Error('COMPAT_SIGNATURE_INVALID')
    const declaration = parse(text)
    if (declaration.minProtocol > current.protocolVersion) throw new Error('COMPAT_PROTOCOL_INCOMPATIBLE')
    const advice = declaration.level === 'compatible'
      ? '组合兼容，全部能力可用。'
      : declaration.level === 'capability'
        ? `单项能力停用：${declaration.disabledCapabilities.join('、')}。其余能力继续可用；权限仍由 Server 与本地策略决定。`
        : '核心通信/安全不兼容：已停止新的本地任务。历史与未确认执行记录完整保留，未知任务不会当作未执行。请升级桌面组合。'
    return { ok: true, error: '', declaration, advice }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'COMPAT_REJECTED', declaration: null, advice: '' }
  }
}

/** Hard stop: does this request create or dispatch local work at this level? */
export function blocksLocalTask(declaration: CompatibilityDeclaration | null, command: { action: string; capability?: string }): boolean {
  if (!declaration) return false
  if (declaration.level === 'core') return ['create', 'send'].includes(command.action)
  if (declaration.level === 'capability' && command.action === 'send') {
    return command.capability ? declaration.disabledCapabilities.includes(command.capability) : false
  }
  return false
}

/** Controlled-address fetch, mirroring the update manifest origin rules. */
export async function checkCompatibility(origin: string, publicKeyPem: string,
    current: { protocolVersion: number }): Promise<CompatibilityEvaluation> {
  let base: URL
  try {
    base = new URL(origin)
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error()
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error()
    if (base.username || base.password || base.search || base.hash) throw new Error()
  } catch { throw new Error('COMPAT_ORIGIN_INVALID') }
  const fetchText = async (path: string): Promise<string> => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(response.status === 404 ? 'COMPAT_NOT_PUBLISHED' : 'COMPAT_SERVER_ERROR')
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw new Error('COMPAT_MANIFEST_TOO_LARGE')
    return body
  }
  const text = await fetchText('updates/compatibility.json')
  const signatureHex = (await fetchText('updates/compatibility.sig')).trim()
  return evaluate(text, signatureHex, publicKeyPem, current)
}

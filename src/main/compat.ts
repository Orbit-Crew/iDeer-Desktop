// Issue 110: the Server-provided compatibility gate. The declaration is a
// signed, controlled document served next to the update manifests. It can
// mark the whole combination compatible, disable single capabilities, or
// declare a core incompatibility that stops new local tasks. A capability
// switch never grants anything: Server authorization and local policy still
// decide every request, and all records stay readable in every level.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { controlledBytes } from './controlled-http'

export type CompatibilityLevel = 'compatible' | 'capability' | 'core'

export interface CompatibilityDeclaration {
  version: 1
  level: CompatibilityLevel
  disabledCapabilities: string[]
  minProtocol: number
  notes: string
  candidateCombo: { desktop: string; runtime: string; server: string }
  supportedCombos?: { desktop: string; runtime: string; server: string; level?: CompatibilityLevel; disabledCapabilities?: string[] }[]
}
interface CompatibilityCurrent { protocolVersion: number; desktopVersion?: string; runtimePython?: string; serverVersion?: string }

export interface CompatibilityEvaluation {
  ok: boolean
  error: string
  declaration: CompatibilityDeclaration | null
  /** True when the requested capability is stopped by the current level. */
  advice: string
}

const MAX_BYTES = 512 * 1024
const KNOWN_CAPABILITIES = ['echo', 'local.files.read', 'local.files.write', 'local.files.list', 'local.files.search', 'local.python', 'local.artifacts.upload']
const validCapability = (cap: unknown): boolean => typeof cap === 'string' && cap.length <= 128 &&
  (KNOWN_CAPABILITIES.includes(cap) || /^local\.mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cap))

function parse(text: string): CompatibilityDeclaration {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('COMPAT_MANIFEST_TOO_LARGE')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('COMPAT_MANIFEST_MALFORMED') }
  const d = value as CompatibilityDeclaration
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('COMPAT_MANIFEST_MALFORMED')
  if (d.version !== 1) throw new Error('COMPAT_MANIFEST_VERSION_UNSUPPORTED')
  if (!['compatible', 'capability', 'core'].includes(d.level)) throw new Error('COMPAT_MANIFEST_LEVEL_INVALID')
  if (!Array.isArray(d.disabledCapabilities) || d.disabledCapabilities.length > 128 ||
      d.disabledCapabilities.some(cap => !validCapability(cap)) ||
      new Set(d.disabledCapabilities).size !== d.disabledCapabilities.length) throw new Error('COMPAT_MANIFEST_CAPABILITY_INVALID')
  if (d.level === 'compatible' && d.disabledCapabilities.length) throw new Error('COMPAT_MANIFEST_CAPABILITY_INVALID')
  if (d.level === 'core' && d.disabledCapabilities.length) throw new Error('COMPAT_MANIFEST_CAPABILITY_INVALID')
  if (!Number.isInteger(d.minProtocol) || d.minProtocol < 1) throw new Error('COMPAT_MANIFEST_MALFORMED')
  if (typeof d.notes !== 'string' || d.notes.length > 2000) throw new Error('COMPAT_MANIFEST_MALFORMED')
  if (!d.candidateCombo || typeof d.candidateCombo !== 'object' ||
      [d.candidateCombo.desktop, d.candidateCombo.runtime, d.candidateCombo.server]
        .some(field => typeof field !== 'string' || !field || field.length > 128)) throw new Error('COMPAT_MANIFEST_MALFORMED')
  if (d.supportedCombos !== undefined) {
    if (!Array.isArray(d.supportedCombos) || d.supportedCombos.length > 100) throw new Error('COMPAT_MANIFEST_MALFORMED')
    const combos = new Set([JSON.stringify({ desktop: d.candidateCombo.desktop, runtime: d.candidateCombo.runtime, server: d.candidateCombo.server })])
    for (const row of d.supportedCombos) {
      if (!row || [row.desktop, row.runtime, row.server].some(value => typeof value !== 'string' || !value || value.length > 128)) throw new Error('COMPAT_MANIFEST_MALFORMED')
      const key = JSON.stringify({ desktop: row.desktop, runtime: row.runtime, server: row.server })
      if (combos.has(key)) throw new Error('COMPAT_MANIFEST_MALFORMED')
      combos.add(key)
      const level = row.level ?? d.level, disabled = row.disabledCapabilities ?? d.disabledCapabilities
      if (!['compatible', 'capability', 'core'].includes(level) || !Array.isArray(disabled) || disabled.length > 128 ||
          disabled.some(cap => !validCapability(cap)) || new Set(disabled).size !== disabled.length ||
          (level !== 'capability' && disabled.length)) throw new Error('COMPAT_MANIFEST_MALFORMED')
    }
  }
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
    current: CompatibilityCurrent): CompatibilityEvaluation {
  try {
    if (!verifySignature(text, signatureHex, publicKeyPem)) throw new Error('COMPAT_SIGNATURE_INVALID')
    const declaration = parse(text)
    if (declaration.minProtocol > current.protocolVersion) throw new Error('COMPAT_PROTOCOL_INCOMPATIBLE')
    if (current.desktopVersion !== undefined || current.runtimePython !== undefined || current.serverVersion !== undefined) {
      const matches = (combo: { desktop: string; runtime: string; server: string }): boolean =>
        combo.desktop === current.desktopVersion && combo.runtime === current.runtimePython && combo.server === current.serverVersion
      if (!matches(declaration.candidateCombo)) {
        const selected = declaration.supportedCombos?.find(matches)
        if (!selected) throw new Error('COMPAT_COMBINATION_UNSUPPORTED')
        declaration.level = selected.level ?? declaration.level
        declaration.disabledCapabilities = selected.disabledCapabilities ?? declaration.disabledCapabilities
      }
    }
    const advice = declaration.level === 'compatible'
      ? '组合兼容，全部能力可用。'
      : declaration.level === 'capability'
        ? `单项能力停用：${declaration.disabledCapabilities.join('、')}。其余能力继续可用；权限仍由 Server 与本地策略决定。`
        : '核心通信/安全不兼容：已停止新的本地任务。历史与未确认执行记录完整保留，未知任务不会当作未执行。请升级桌面组合。'
    return { ok: true, error: '', declaration, advice }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'COMPAT_REJECTED'
    return { ok: false, error: reason, declaration: { version: 1, level: 'core', disabledCapabilities: [], minProtocol: 1,
      notes: reason, candidateCombo: { desktop: current.desktopVersion || 'unknown', runtime: current.runtimePython || 'unknown', server: current.serverVersion || 'unknown' } },
      advice: '兼容声明无法核验，已停止新的本地任务。历史和未确认执行记录保留。' }
  }
}

/** Hard stop: does this request create or dispatch local work at this level? */
export function blocksLocalTask(declaration: CompatibilityDeclaration | null, command: { action: string; capability?: string }): boolean {
  if (!declaration) return false
  if (declaration.level === 'core') return ['create', 'send', 'upload'].includes(command.action)
  if (declaration.level === 'capability' && command.action === 'upload') return declaration.disabledCapabilities.includes('local.artifacts.upload')
  if (declaration.level === 'capability' && command.action === 'send') {
    return command.capability ? declaration.disabledCapabilities.includes(command.capability) : false
  }
  return false
}

/** Controlled-address fetch, mirroring the update manifest origin rules. */
export async function checkCompatibility(origin: string, publicKeyPem: string,
    current: CompatibilityCurrent): Promise<CompatibilityEvaluation> {
  let base: URL
  try {
    base = new URL(origin)
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error()
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error()
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error()
  } catch { throw new Error('COMPAT_ORIGIN_INVALID') }
  const fetchText = async (path: string): Promise<string> => {
    return (await controlledBytes(base.origin, '/' + path, { maxBytes: MAX_BYTES, timeoutMs: 15000 })).toString('utf8')
  }
  const text = await fetchText('updates/compatibility.json')
  const signatureHex = (await fetchText('updates/compatibility.sig')).trim()
  return evaluate(text, signatureHex, publicKeyPem, current)
}

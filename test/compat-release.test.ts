import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluate } from '../src/main/compat'

describe('published compatibility combination assets', () => {
  it('signs old-parser-compatible top policy and exact new-client restrictions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ideer-compat-release-'))
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const key = join(directory, 'private.pem'), spec = join(directory, 'spec.json'), output = join(directory, 'controlled')
      writeFileSync(key, privateKey.export({ format: 'pem', type: 'pkcs8' }))
      const declaration = { version: 1, level: 'compatible', disabledCapabilities: [], minProtocol: 1, notes: 'Tested matrix',
        candidateCombo: { desktop: '0.1.0', runtime: '3.12.10', server: 'server-110' },
        supportedCombos: [{ desktop: '0.2.0', runtime: '3.12.10', server: 'server-110', level: 'capability', disabledCapabilities: ['local.files.write'] }] }
      writeFileSync(spec, JSON.stringify(declaration))
      execFileSync(process.execPath, [resolve('scripts/release/issue-110/make-compatibility.cjs'), '--spec', spec, '--key', key, '--output', output], { windowsHide: true })
      const text = readFileSync(join(output, 'compatibility.json'), 'utf8')
      const signature = readFileSync(join(output, 'compatibility.sig'), 'utf8').trim()
      const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
      expect(evaluate(text, signature, pem, { protocolVersion: 1, desktopVersion: '0.1.0', runtimePython: '3.12.10', serverVersion: 'server-110' }).declaration?.level).toBe('compatible')
      expect(evaluate(text, signature, pem, { protocolVersion: 1, desktopVersion: '0.2.0', runtimePython: '3.12.10', serverVersion: 'server-110' }).declaration?.level).toBe('capability')
      expect(evaluate(text, signature, pem, { protocolVersion: 1, desktopVersion: '9.9.9', runtimePython: '3.12.10', serverVersion: 'server-110' }).error).toBe('COMPAT_COMBINATION_UNSUPPORTED')
      expect(JSON.parse(text).level).toBe('compatible')
      expect(JSON.parse(readFileSync(join(output, 'release-combinations.json'), 'utf8')).combinations).toHaveLength(2)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['name128', 'name129', 'count128', 'count129', 'rowname129', 'rowcount129', 'oversize'])('publishes only consumable capability policies: %s', scenario => {
    const directory = mkdtempSync(join(tmpdir(), 'ideer-compat-policy-'))
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const key = join(directory, 'private.pem'), spec = join(directory, 'spec.json'), output = join(directory, 'controlled')
      writeFileSync(key, privateKey.export({ format: 'pem', type: 'pkcs8' }))
      const cap = (length: number, i = 0): string => `local.mcp.${'a'.repeat(length - 11 - String(i).length)}.${i}`
      const disabled = scenario.includes('name') ? [cap(scenario === 'name128' ? 128 : 129)] :
        Array.from({ length: scenario.includes('count129') ? 129 : 128 }, (_, i) => cap(127, i))
      const row = scenario.startsWith('row')
      const declaration = { version: 1, level: row ? 'compatible' : 'capability', disabledCapabilities: row ? [] : disabled, minProtocol: 1, notes: '',
        candidateCombo: { desktop: '0.2.0', runtime: '3.12.10', server: 'server-110' },
        supportedCombos: scenario === 'oversize' ? Array.from({ length: 100 }, (_, i) => ({
          desktop: `0.3.${i}`, runtime: '3.12.10', server: 'server-110', disabledCapabilities: disabled })) :
          row ? [{ desktop: '0.3.0', runtime: '3.12.10', server: 'server-110', level: 'capability', disabledCapabilities: disabled }] : [] }
      const text = JSON.stringify(declaration)
      writeFileSync(spec, text)
      const result = spawnSync(process.execPath, [resolve('scripts/release/issue-110/make-compatibility.cjs'), '--spec', spec, '--key', key, '--output', output], { windowsHide: true, encoding: 'utf8' })
      const accepted = scenario === 'name128' || scenario === 'count128'
      expect({ scenario, status: result.status === 0 }).toEqual({ scenario, status: accepted })
      if (!accepted) expect(existsSync(output)).toBe(false)
      const evaluated = evaluate(text, sign(null, Buffer.from(text), privateKey).toString('hex'),
        publicKey.export({ format: 'pem', type: 'spki' }).toString(), { protocolVersion: 1 })
      expect(evaluated.ok).toBe(accepted)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it.each([524288, 524289])('checks the final serialized %i-byte compatibility asset before writing', bytes => {
    const directory = mkdtempSync(join(tmpdir(), 'ideer-compat-bytes-'))
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const key = join(directory, 'private.pem'), spec = join(directory, 'spec.json'), output = join(directory, 'controlled')
      writeFileSync(key, privateKey.export({ format: 'pem', type: 'pkcs8' }))
      const declaration = { version: 1, level: 'compatible', disabledCapabilities: [], minProtocol: 1, notes: '',
        candidateCombo: { desktop: '0.2.0', runtime: '3.12.10', server: 'server-110' }, padding: '' }
      declaration.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(declaration, null, 2) + '\n'))
      writeFileSync(spec, JSON.stringify(declaration))
      const result = spawnSync(process.execPath, [resolve('scripts/release/issue-110/make-compatibility.cjs'), '--spec', spec, '--key', key, '--output', output], { windowsHide: true, encoding: 'utf8' })
      expect(result.status === 0).toBe(bytes === 524288)
      if (bytes === 524289) expect(existsSync(output)).toBe(false)
      else {
        const text = readFileSync(join(output, 'compatibility.json'), 'utf8')
        expect(Buffer.byteLength(text)).toBe(524288)
        expect(evaluate(text, readFileSync(join(output, 'compatibility.sig'), 'utf8').trim(),
          publicKey.export({ type: 'spki', format: 'pem' }).toString(), { protocolVersion: 1 }).ok).toBe(true)
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
  it.each([100, 101])('enforces the Server golden limit for %i signed supported combinations', count => {
    const directory = mkdtempSync(join(tmpdir(), 'ideer-compat-limit-'))
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const key = join(directory, 'private.pem'), spec = join(directory, 'spec.json'), output = join(directory, 'controlled')
      writeFileSync(key, privateKey.export({ format: 'pem', type: 'pkcs8' }))
      const declaration = { version: 1, level: 'compatible', disabledCapabilities: [], minProtocol: 1, notes: 'Server contract max=100',
        candidateCombo: { desktop: '0.2.0', runtime: '3.12.10', server: 'server-110' },
        supportedCombos: Array.from({ length: count }, (_, i) => ({ desktop: `0.3.${i}`, runtime: '3.12.10', server: 'server-110' })) }
      const text = JSON.stringify(declaration)
      writeFileSync(spec, text)
      const result = spawnSync(process.execPath, [resolve('scripts/release/issue-110/make-compatibility.cjs'), '--spec', spec, '--key', key, '--output', output], { windowsHide: true, encoding: 'utf8' })
      expect(result.status === 0).toBe(count === 100)
      const signature = sign(null, Buffer.from(text), privateKey).toString('hex')
      const evaluated = evaluate(text, signature, publicKey.export({ format: 'pem', type: 'spki' }).toString(), { protocolVersion: 1 })
      expect(evaluated.ok).toBe(count === 100)
      if (count === 101) expect(evaluated.error).toBe('COMPAT_MANIFEST_MALFORMED')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})

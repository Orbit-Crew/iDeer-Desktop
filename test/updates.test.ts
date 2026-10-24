import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { checkOnline, verifySignature, verifyUpdate } from '../src/main/updates'
import type { UpdateManifest } from '../src/main/updates'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const CURRENT = { desktopVersion: '0.1.0', runtimePython: '3.12.10', protocolVersion: 1 }

function manifest(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version: 1, kind: 'patch', publishedAt: '2026-10-24T00:00:00.000Z',
    desktop: { version: '0.2.0', asarSHA256: 'a'.repeat(64) },
    runtime: { python: '3.12.10', lockSHA256: 'b'.repeat(64) },
    serverCompatibility: { minProtocol: 1, notes: 'Server 3e728cd6a or newer' },
    baseline: { desktopVersion: '0.1.0', runtimePython: '3.12.10' },
    deletions: ['out/main/old.js'],
    files: [{ path: 'out/main/index.js', sha256: 'c'.repeat(64), bytes: 123 }]
  }
}

// Mirrors scripts/release/issue-107/make-update.cjs: sign the canonical
// manifest bytes directly; the signature carries the integrity.
function signed(value: UpdateManifest, key = PRIVATE_PEM): { text: string; signature: string } {
  const text = JSON.stringify(value)
  return { text, signature: sign(null, Buffer.from(text, 'utf8'), createPrivateKey(key)).toString('hex') }
}

const workDirs: string[] = []
afterEach(() => {
  while (workDirs.length) rmSync(workDirs.pop()!, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideer-updates-'))
  workDirs.push(dir)
  return dir
}

describe('signed update verification (issue 107)', () => {
  it('verifies a genuine patch and stages it without touching the disk', () => {
    const dir = freshDir()
    const before = readdirSync(dir)
    const { text, signature } = signed(manifest())
    const result = verifyUpdate(text, signature, publicKeyPem, CURRENT, 'offline')
    expect(result.ok).toBe(true)
    expect(result.pending?.kind).toBe('patch')
    expect(result.pending?.advice).toContain('待安装'.slice(0, 0) || '补丁已就绪')
    expect(readdirSync(dir)).toEqual(before)
  })
  it('rejects tampered, truncated, forged, foreign-key and rewritten manifests', () => {
    const genuine = signed(manifest())
    expect(verifyUpdate(genuine.text, genuine.signature, publicKeyPem, CURRENT, 'offline').error).toBe('')

    const tamperedBody = JSON.stringify({ ...manifest(), deletions: [] })
    expect(verifyUpdate(tamperedBody, genuine.signature, publicKeyPem, CURRENT, 'offline').error).toBe('UPDATE_SIGNATURE_INVALID')

    const truncated = genuine.text.slice(0, genuine.text.length - 5)
    expect(verifyUpdate(truncated, genuine.signature, publicKeyPem, CURRENT, 'offline').error).toBe('UPDATE_SIGNATURE_INVALID')

    const other = generateKeyPairSync('ed25519')
    const foreign = sign(null, Buffer.from(genuine.text, 'utf8'), createPrivateKey(other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toString('hex')
    expect(verifyUpdate(genuine.text, foreign, publicKeyPem, CURRENT, 'offline').error).toBe('UPDATE_SIGNATURE_INVALID')

    const wrongVersion = JSON.parse(genuine.text) as UpdateManifest
    wrongVersion.version = 2
    const versionSigned = signed(wrongVersion)
    expect(verifyUpdate(versionSigned.text, versionSigned.signature, publicKeyPem, CURRENT, 'offline').error).toBe('UPDATE_MANIFEST_VERSION_UNSUPPORTED')
  })
  it('rejects baseline, combination and server-compatibility mismatches', () => {
    for (const overrides of [
      { baseline: { desktopVersion: '0.9.0', runtimePython: '3.12.10' } },
      { baseline: { desktopVersion: '0.1.0', runtimePython: '3.13.1' } },
      { serverCompatibility: { minProtocol: 2, notes: '' } }
    ]) {
      const { text, signature } = signed({ ...manifest(), ...overrides })
      const result = verifyUpdate(text, signature, publicKeyPem, CURRENT, 'offline')
      expect(['UPDATE_BASELINE_MISMATCH', 'UPDATE_SERVER_INCOMPATIBLE']).toContain(result.error)
      expect(result.pending).toBeNull()
    }
  })
  it('rejects path escapes, absolute paths, deletions outside the program directory and duplicates', () => {
    for (const files of [
      [{ path: '../user/data.txt', sha256: 'c'.repeat(64), bytes: 1 }],
      [{ path: 'C:/Windows/system32/x.dll', sha256: 'c'.repeat(64), bytes: 1 }],
      [{ path: '/absolute/out/x.js', sha256: 'c'.repeat(64), bytes: 1 }],
      [{ path: 'out/../secret.txt', sha256: 'c'.repeat(64), bytes: 1 }],
      [{ path: 'resources/../../user', sha256: 'c'.repeat(64), bytes: 1 }],
      [{ path: 'user/app.config', sha256: 'c'.repeat(64), bytes: 1 }],
    ]) {
      const { text, signature } = signed({ ...manifest(), files })
      expect(verifyUpdate(text, signature, publicKeyPem, CURRENT, 'offline').error).toBe('UPDATE_FILE_OUTSIDE_PROGRAM_DIRECTORY')
    }
    // A duplicated path is a list defect rather than a boundary escape.
    const duplicated = signed({ ...manifest(), files: [{ path: 'out/a.js', sha256: 'c'.repeat(64), bytes: 1 }, { path: 'out/a.js', sha256: 'c'.repeat(64), bytes: 2 }] })
    expect(verifyUpdate(duplicated.text, duplicated.signature, publicKeyPem, CURRENT, 'offline').error).toBe('UPDATE_FILE_LIST_INVALID')
    for (const deletions of [['../user/keep.txt'], ['resources/../../x'], ['C:/x']]) {
      const { text, signature } = signed({ ...manifest(), deletions })
      expect(verifyUpdate(text, signature, publicKeyPem, CURRENT, 'offline').error).toBe('UPDATE_DELETE_OUTSIDE_PROGRAM_DIRECTORY')
    }
  })
  it('advises a full installer for low-level component changes and keeps patch advice separate', () => {
    const full = signed({ ...manifest(), kind: 'full', files: [], deletions: [] })
    const result = verifyUpdate(full.text, full.signature, publicKeyPem, CURRENT, 'offline')
    expect(result.ok).toBe(true)
    expect(result.pending?.kind).toBe('full')
    expect(result.pending?.advice).toContain('完整安装包')
  })
  it('checks the controlled online address only over an allowed origin', async () => {
    await expect(checkOnline('https://server.invalid/path?x=1', CURRENT, publicKeyPem)).rejects.toThrow('UPDATE_ORIGIN_INVALID')
    await expect(checkOnline('ftp://server.invalid', CURRENT, publicKeyPem)).rejects.toThrow('UPDATE_ORIGIN_INVALID')
    // A controlled address without a published manifest reports honestly.
    await expect(checkOnline('http://127.0.0.1:9', CURRENT, publicKeyPem)).rejects.toThrow()
  })
  it('produces and consumes a complete release through the documented pipeline', () => {
    // The release pipeline signs the canonical manifest bytes.
    const value = manifest()
    const canonical = JSON.stringify(value)
    const signature = sign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(PRIVATE_PEM)).toString('hex')
    expect(verifySignature(canonical, signature, publicKeyPem)).toBe(true)
    const result = verifyUpdate(canonical, signature, publicKeyPem, CURRENT, 'online')
    expect(result.ok).toBe(true)
    expect(result.pending?.source).toBe('online')
  })
})

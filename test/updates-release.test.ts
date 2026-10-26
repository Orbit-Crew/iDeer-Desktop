import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { UpdateService } from '../src/main/update-stage'

const roots: string[] = []
const require = createRequire(import.meta.url)
const fresh = (): string => { const root = mkdtempSync(join(tmpdir(), 'ideer-update-release-')); roots.push(root); return root }
afterEach(() => { delete process.env.IDEER_UPDATES_PUBLIC_KEY_FILE; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('build-time update trust anchor', () => {
  it('refuses invalid final client schemas and oversized assets without leaving a release', async () => {
    const root = fresh(), installed = join(root, 'installed'), source = join(root, 'app')
    mkdirSync(source); mkdirSync(join(installed, 'resources/runtime'), { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '0.2.0' }))
    const { createPackage } = await import('@electron/asar')
    await createPackage(source, join(installed, 'resources/app.asar'))
    writeFileSync(join(installed, 'resources/runtime/distribution.lock.json'), JSON.stringify({ python: '3.12.10' }))
    const key = join(root, 'private.pem'), definition = join(root, 'definition.json')
    writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const base = { version: 1, kind: 'patch', publishedAt: '2026-10-25T00:00:00Z',
      desktop: { version: '0.2.0', electron: '22.3.27', asarSHA256: '0'.repeat(64) },
      runtime: { python: '3.12.10', lockSHA256: '0'.repeat(64) },
      baseline: { desktopVersion: '0.1.0', electronVersion: '22.3.27', runtimePython: '3.12.10', dataFormat: 1 },
      dataCompatibility: { targetFormat: 1, readableFormats: [1] }, serverCompatibility: { minProtocol: 1, notes: '' },
      files: [{ path: 'resources/app.asar' }], deletions: [] }
    const cases = [
      { version: 2 }, { publishedAt: 'not-a-date' }, { serverCompatibility: { minProtocol: 0, notes: '' } },
      { serverCompatibility: { minProtocol: 1, notes: 'x'.repeat(2001) } },
      { dataCompatibility: { targetFormat: 1, readableFormats: [1, 1] } },
      { baseline: { ...base.baseline, dataFormat: 0 } },
      { desktop: { ...base.desktop, electron: 'invalid' }, baseline: { ...base.baseline, electronVersion: 'invalid' } },
      { files: [] }, { deletions: ['resources/runtime/core/desktop.py'] },
      { padding: 'x'.repeat(524288) }
    ]
    for (const [index, invalid] of cases.entries()) {
      const output = join(root, `release-${index}`)
      writeFileSync(definition, JSON.stringify({ ...base, ...invalid }))
      const result = spawnSync(process.execPath, ['scripts/release/issue-107/make-update.cjs', '--manifest', definition,
        '--payload-root', installed, '--out', output, '--private-key', key], { encoding: 'utf8', windowsHide: true })
      expect({ index, accepted: result.status === 0 }).toEqual({ index, accepted: false })
      expect(existsSync(output)).toBe(false)
    }
    for (const bytes of [524288, 524289]) {
      const output = join(root, `boundary-${bytes}`)
      const boundary = { ...base, files: [{ path: 'resources/app.asar', bytes: statSync(join(installed, 'resources/app.asar')).size,
        sha256: '0'.repeat(64) }], padding: '' }
      boundary.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(boundary)))
      writeFileSync(definition, JSON.stringify(boundary))
      const result = spawnSync(process.execPath, ['scripts/release/issue-107/make-update.cjs', '--manifest', definition,
        '--payload-root', installed, '--out', output, '--private-key', key], { encoding: 'utf8', windowsHide: true })
      expect(result.status === 0).toBe(bytes === 524288)
      if (bytes === 524289) expect(existsSync(output)).toBe(false)
      else expect(readFileSync(join(output, 'manifest.json')).length).toBe(524288)
    }
  })
  it('creates one signed release directory usable both by static hosting and offline import', async () => {
    const keys = generateKeyPairSync('ed25519'), root = fresh(), installed = join(root, 'installed'), output = join(root, 'release')
    const asarSource = join(root, 'app')
    mkdirSync(asarSource)
    writeFileSync(join(asarSource, 'package.json'), JSON.stringify({ name: 'ideer-desktop', version: '0.2.0' }))
    mkdirSync(join(installed, 'resources/runtime'), { recursive: true })
    const { createPackage } = await import('@electron/asar')
    await createPackage(asarSource, join(installed, 'resources/app.asar'))
    writeFileSync(join(installed, 'resources/runtime/distribution.lock.json'), JSON.stringify({ python: '3.12.10' }))
    const manifest = {
      version: 1, kind: 'patch', publishedAt: '2026-10-25T00:00:00Z',
      desktop: { version: '0.2.0', electron: '22.3.27', asarSHA256: '0'.repeat(64) },
      runtime: { python: '3.12.10', lockSHA256: '0'.repeat(64) },
      baseline: { desktopVersion: '0.1.0', electronVersion: '22.3.27', runtimePython: '3.12.10', dataFormat: 1 },
      dataCompatibility: { targetFormat: 1, readableFormats: [1] }, serverCompatibility: { minProtocol: 1, notes: '' },
      files: [{ path: 'resources/app.asar', bytes: 0, sha256: '0'.repeat(64) }], deletions: []
    }
    const definition = join(root, 'definition.json'), privateKey = join(root, 'private.pem')
    writeFileSync(definition, JSON.stringify(manifest))
    writeFileSync(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const built = spawnSync(process.execPath, ['scripts/release/issue-107/make-update.cjs', '--manifest', definition,
      '--payload-root', installed, '--out', output, '--private-key', privateKey], { encoding: 'utf8', windowsHide: true })
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
    expect(readFileSync(join(output, 'files/resources/app.asar'))).toEqual(readFileSync(join(installed, 'resources/app.asar')))
    const service = new UpdateService({ directory: join(root, 'stages'), publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      current: () => ({ desktopVersion: '0.1.0', electronVersion: '22.3.27', runtimePython: '3.12.10', protocolVersion: 1, dataFormat: 1, readableFormats: [1] }) })
    expect(await service.import(join(output, 'manifest.json'))).toMatchObject({ ok: true, error: '' })
  })
  it('packages only the configured public key and records its fingerprint', async () => {
    const keys = generateKeyPairSync('ed25519')
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const input = fresh(), output = fresh()
    const keyPath = join(input, 'public.pem')
    writeFileSync(keyPath, publicKey)
    mkdirSync(join(output, 'resources/updates'), { recursive: true })
    process.env.IDEER_UPDATES_PUBLIC_KEY_FILE = keyPath
    const hook = require('../scripts/release/issue-107/after-pack.cjs')
    await hook({ appOutDir: output })
    expect(readFileSync(join(output, 'resources/updates/updates-public-key.pem'), 'utf8')).toBe(publicKey)
    expect(JSON.parse(readFileSync(join(output, 'resources/updates/trust-anchor.json'), 'utf8'))).toMatchObject({
      algorithm: 'ed25519', sha256: createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
    })
    const artifact = join(output, 'setup.exe')
    writeFileSync(artifact, 'INSTALLER-BYTES')
    const completed = require('../scripts/release/issue-107/artifact-completed.cjs')
    await completed({ file: artifact })
    expect(JSON.parse(readFileSync(artifact + '.updates-trust.json', 'utf8'))).toMatchObject({
      artifact: 'setup.exe', artifactSHA256: 'da0ddc66c4937a5c3abb5b1407732aa599a874f268030094b66498022a806c63'
    })
    process.env.IDEER_UPDATES_PUBLIC_KEY_FILE = join(input, 'private.pem')
    writeFileSync(process.env.IDEER_UPDATES_PUBLIC_KEY_FILE, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await expect(hook({ appOutDir: output })).rejects.toThrow('UPDATE_BUILD_PUBLIC_KEY_REQUIRED')
  })
})

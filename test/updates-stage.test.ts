import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdateService } from '../src/main/update-stage'
import type { UpdateManifest } from '../src/main/updates'

const keys = generateKeyPairSync('ed25519')
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const current = { desktopVersion: '0.1.0', electronVersion: '22.3.27', runtimePython: '3.12.10', protocolVersion: 1, dataFormat: 1, readableFormats: [1] }
const payload = Buffer.from('SIGNED-UPDATE-BYTES')
const digest = createHash('sha256').update(payload).digest('hex')
const roots: string[] = []
const fresh = (): string => { const root = mkdtempSync(join(tmpdir(), 'ideer-update-stage-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function release(overrides: Partial<UpdateManifest> = {}): { text: string; signature: string } {
  const manifest: UpdateManifest = {
    version: 1, kind: 'patch', publishedAt: '2026-10-25T00:00:00Z',
    desktop: { version: '0.1.0', electron: '22.3.27', asarSHA256: 'a'.repeat(64) },
    runtime: { python: '3.12.10', lockSHA256: 'b'.repeat(64) },
    baseline: { desktopVersion: '0.1.0', electronVersion: '22.3.27', runtimePython: '3.12.10', dataFormat: 1 },
    dataCompatibility: { targetFormat: 1, readableFormats: [1] },
    serverCompatibility: { minProtocol: 1, notes: '' }, deletions: [],
    files: [{ path: 'resources/runtime/core/update.py', sha256: digest, bytes: payload.length }], ...overrides
  }
  const text = JSON.stringify(manifest)
  return { text, signature: sign(null, Buffer.from(text), keys.privateKey).toString('hex') }
}

describe('verified updates through the online and offline entries', () => {
  it.each([524288, 524289])('uses the same signed %i-byte manifest boundary online, offline and after restart', async bytes => {
    const base = release().text, text = base + ' '.repeat(bytes - Buffer.byteLength(base))
    const signature = sign(null, Buffer.from(text), keys.privateKey).toString('hex')
    const media = fresh(), stages = fresh()
    mkdirSync(join(media, 'files/resources/runtime/core'), { recursive: true })
    writeFileSync(join(media, 'files/resources/runtime/core/update.py'), payload)
    writeFileSync(join(media, 'manifest.json'), text); writeFileSync(join(media, 'manifest.sig'), signature)
    const server = createServer((request, response) => {
      if (request.url?.endsWith('manifest.json')) response.end(text)
      else if (request.url?.endsWith('manifest.sig')) response.end(signature)
      else response.end(payload)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const offline = new UpdateService({ directory: stages, publicKeyPem, current: () => current })
      const online = new UpdateService({ directory: fresh(), publicKeyPem, current: () => current })
      expect(await offline.import(join(media, 'manifest.json'))).toMatchObject({ ok: bytes === 524288 })
      expect((await online.check(`http://127.0.0.1:${(server.address() as { port: number }).port}`)).ok).toBe(bytes === 524288)
      if (bytes === 524289) {
        const small = release()
        writeFileSync(join(media, 'manifest.json'), small.text); writeFileSync(join(media, 'manifest.sig'), small.signature)
        expect((await offline.import(join(media, 'manifest.json'))).ok).toBe(true)
        writeFileSync(join(offline.staged!.stageRoot, 'manifest.json'), text)
        writeFileSync(join(offline.staged!.stageRoot, 'manifest.sig'), signature)
      }
      expect(new UpdateService({ directory: stages, publicKeyPem, current: () => current }).restore().ok).toBe(bytes === 524288)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('discards the previous installable release when a replacement download fails', async () => {
    const signed = release(), stages = fresh()
    let corrupt = false
    const server = createServer((request, response) => {
      if (request.url === '/updates/desktop/manifest.json') response.end(signed.text)
      else if (request.url === '/updates/desktop/manifest.sig') response.end(signed.signature)
      else response.end(corrupt ? Buffer.alloc(payload.length) : payload)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const service = new UpdateService({ directory: stages, publicKeyPem, current: () => current })
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      expect((await service.check(origin)).ok).toBe(true)
      corrupt = true
      expect(await service.check(origin)).toMatchObject({ ok: false, error: 'UPDATE_PAYLOAD_HASH_MISMATCH', pending: null })
      expect(service.staged).toBeNull()
      expect(readdirSync(stages)).toEqual([])
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('does not silently import manifest.json after the user selected a different file', async () => {
    const signed = release(), directory = fresh()
    mkdirSync(join(directory, 'files/resources/runtime/core'), { recursive: true })
    writeFileSync(join(directory, 'files/resources/runtime/core/update.py'), payload)
    writeFileSync(join(directory, 'manifest.json'), signed.text)
    writeFileSync(join(directory, 'manifest.sig'), signed.signature)
    writeFileSync(join(directory, 'different.json'), 'USER-SELECTED-DIFFERENT-ASSET')
    const service = new UpdateService({ directory: fresh(), publicKeyPem, current: () => current })
    expect(await service.import(join(directory, 'different.json'))).toMatchObject({ ok: false, error: 'UPDATE_MANIFEST_NAME_INVALID', pending: null })
    expect(service.staged).toBeNull()
  })
  it('restores a durable stage after restart and refuses tampered staged payloads', async () => {
    const signed = release()
    const directory = fresh(), stages = fresh()
    mkdirSync(join(directory, 'files/resources/runtime/core'), { recursive: true })
    writeFileSync(join(directory, 'files/resources/runtime/core/update.py'), payload)
    writeFileSync(join(directory, 'manifest.json'), signed.text)
    writeFileSync(join(directory, 'manifest.sig'), signed.signature)
    const service = new UpdateService({ directory: stages, publicKeyPem, current: () => current })
    expect((await service.import(join(directory, 'manifest.json'))).ok).toBe(true)
    const reopened = new UpdateService({ directory: stages, publicKeyPem, current: () => current })
    expect(reopened.restore()).toMatchObject({ ok: true })
    expect(reopened.staged!.id).toBe(service.staged!.id)
    writeFileSync(join(reopened.staged!.payloadRoot, 'resources/runtime/core/update.py'), Buffer.alloc(payload.length))
    expect(() => reopened.validateStaged()).toThrow('UPDATE_PAYLOAD_HASH_MISMATCH')
    expect(reopened.staged).toBeNull()
  })
  it('only exposes the full installer after checking its signed bytes', async () => {
    const signed = release({ kind: 'full', files: [], installer: { path: 'installer.exe', sha256: digest, bytes: payload.length },
      desktop: { version: '0.2.0', electron: '23.0.0', asarSHA256: 'a'.repeat(64) } })
    const directory = fresh()
    writeFileSync(join(directory, 'manifest.json'), signed.text)
    writeFileSync(join(directory, 'manifest.sig'), signed.signature)
    writeFileSync(join(directory, 'installer.exe'), payload)
    const service = new UpdateService({ directory: fresh(), publicKeyPem, current: () => current })
    expect(await service.import(join(directory, 'manifest.json'))).toMatchObject({ ok: true, error: '' })
    expect(service.staged?.installerPath).toBeTruthy()
    expect(readFileSync(service.staged!.installerPath!)).toEqual(payload)
    writeFileSync(join(directory, 'installer.exe'), Buffer.alloc(payload.length))
    expect(await service.import(join(directory, 'manifest.json'))).toMatchObject({ ok: false, error: 'UPDATE_PAYLOAD_HASH_MISMATCH' })
    expect(service.staged).toBeNull()
  })
  it('stages the same verified payload from HTTP and an offline release directory', async () => {
    const signed = release()
    const server = createServer((request, response) => {
      if (request.url === '/updates/desktop/manifest.json') response.end(signed.text)
      else if (request.url === '/updates/desktop/manifest.sig') response.end(signed.signature)
      else if (request.url === '/updates/desktop/files/resources/runtime/core/update.py') response.end(payload)
      else { response.statusCode = 404; response.end() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const online = new UpdateService({ directory: fresh(), publicKeyPem, current: () => current })
    const offline = new UpdateService({ directory: fresh(), publicKeyPem, current: () => current })
    try {
      expect((await online.check(origin)).ok).toBe(true)
      expect(readFileSync(join(online.staged!.payloadRoot, 'resources/runtime/core/update.py'))).toEqual(payload)
      const directory = fresh()
      mkdirSync(join(directory, 'files/resources/runtime/core'), { recursive: true })
      writeFileSync(join(directory, 'files/resources/runtime/core/update.py'), payload)
      writeFileSync(join(directory, 'manifest.json'), signed.text)
      writeFileSync(join(directory, 'manifest.sig'), signed.signature)
      expect((await offline.import(join(directory, 'manifest.json'))).ok).toBe(true)
      expect(offline.staged!.pending.manifest).toEqual(online.staged!.pending.manifest)
      expect(readFileSync(join(offline.staged!.payloadRoot, 'resources/runtime/core/update.py'))).toEqual(payload)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
it('reads a restored local candidate without its source media and without clearing it on a read-only integrity refusal', async () => {
  const signed = release(), media = fresh(), directory = fresh()
  mkdirSync(join(media, 'files/resources/runtime/core'), { recursive: true })
  writeFileSync(join(media, 'files/resources/runtime/core/update.py'), payload)
  writeFileSync(join(media, 'manifest.json'), signed.text); writeFileSync(join(media, 'manifest.sig'), signed.signature)
  const service = new UpdateService({ directory, publicKeyPem, current: () => current })
  expect((await service.import(join(media, 'manifest.json'))).ok).toBe(true)
  const id = service.staged!.id
  rmSync(media, { recursive: true, force: true })
  const reopened = new UpdateService({ directory, publicKeyPem, current: () => current })
  expect(reopened.restore().ok).toBe(true)
  expect(reopened.readStaged()).toMatchObject({ ok: true, error: '', pending: { kind: 'patch', source: 'offline' } })
  expect(reopened.staged!.id).toBe(id)
  writeFileSync(join(reopened.staged!.payloadRoot, 'resources/runtime/core/update.py'), Buffer.alloc(payload.length))
  expect(reopened.readStaged()).toMatchObject({ ok: false, error: 'UPDATE_PAYLOAD_HASH_MISMATCH', pending: null })
  expect(reopened.staged!.id).toBe(id)
  expect(readFileSync(join(directory, 'pending.json'), 'utf8')).toContain(id)
})

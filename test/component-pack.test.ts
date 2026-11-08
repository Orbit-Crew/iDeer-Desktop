import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { componentLock, loadCatalog } from '../scripts/component-catalog.cjs'
import { PackError, buildPack, installPack } from '../scripts/component-pack.cjs'

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** A tiny build tree that mirrors the repo layout with fake OCCT bytes. */
function fixtureRoot(version = '1.2.3', glue = 'glue-bytes', wasm = 'wasm-bytes') {
  const scratch = mkdtempSync(join(tmpdir(), 'ideer pack root '))
  const resources = join(scratch, 'resources')
  mkdirSync(join(resources, 'components'), { recursive: true })
  mkdirSync(join(resources, 'occt'), { recursive: true })
  mkdirSync(join(resources, 'provenance'), { recursive: true })
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'ideer-desktop', version }))
  writeFileSync(join(resources, 'components/catalog.json'), readFileSync(resolve('resources/components/catalog.json')))
  writeFileSync(join(resources, 'occt/occt-import-js.js'), glue)
  writeFileSync(join(resources, 'occt/occt-import-js.wasm'), wasm)
  writeFileSync(join(resources, 'provenance/linz-source.json'), JSON.stringify({
    files: {
      'resources/occt/occt-import-js.js': sha256(glue),
      'resources/occt/occt-import-js.wasm': sha256(wasm)
    }
  }))
  return scratch
}

/** An installed tree that carries the installer-shipped version lock. */
function installedDir(root: string, appVersion: string) {
  const install = mkdtempSync(join(tmpdir(), 'ideer pack install '))
  mkdirSync(join(install, 'resources/components'), { recursive: true })
  writeFileSync(join(install, 'resources/components/components-lock.json'),
    JSON.stringify(componentLock(root, appVersion)))
  return install
}

const expectPackError = (run: () => unknown, code: string) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PackError)
    expect((error as PackError).code).toBe(code)
    return
  }
  throw new Error(`expected PackError ${code}`)
}

describe('offline component pack build (#119)', () => {
  it('builds a version-locked pack from a local build tree', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack out ')), 'pack')
    try {
      const manifest = buildPack(root, out)
      expect(manifest.appVersion).toBe('1.2.3')
      expect(manifest.components.map((item: { id: string }) => item.id)).toEqual(['cad-viewer'])
      const cad = manifest.components[0]
      expect(cad.dest).toBe('resources/occt')
      expect(cad.files.map((file: { path: string }) => file.path)).toEqual(['occt-import-js.js', 'occt-import-js.wasm'])
      for (const file of cad.files) {
        expect(file.sha256).toBe(sha256(readFileSync(join(out, 'files/cad-viewer', file.path))))
        expect(file.bytes).toBe(readFileSync(join(out, 'files/cad-viewer', file.path)).length)
      }
      expect(JSON.parse(readFileSync(join(out, 'component-pack.json'), 'utf8'))).toEqual(manifest)
      expect(loadCatalog(root).components).toHaveLength(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses pending, bundled and unknown components loudly', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack refuse ')), 'pack')
    try {
      expectPackError(() => buildPack(root, out, ['catia-abaqus']), 'COMPONENT_NOT_AVAILABLE')
      expectPackError(() => buildPack(root, out, ['tecplot-panel']), 'COMPONENT_NOT_AVAILABLE')
      expectPackError(() => buildPack(root, out, ['not-a-component']), 'COMPONENT_NOT_IN_CATALOG')
      expect(existsSync(out)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })
})

describe('offline component pack install (#119)', () => {
  it('tops up a minimal installation after version-lock verification', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack topup ')), 'pack')
    const install = installedDir(root, '1.2.3')
    try {
      buildPack(root, out)
      const result = installPack(out, install)
      expect(result.installed).toEqual(['cad-viewer'])
      // The pack lands in the exact directory the installer section uses.
      expect(readFileSync(join(install, 'resources/occt/occt-import-js.js'), 'utf8')).toBe('glue-bytes')
      expect(readFileSync(join(install, 'resources/occt/occt-import-js.wasm'), 'utf8')).toBe('wasm-bytes')
      const receipts = JSON.parse(readFileSync(join(install, 'resources/components/installed-packs.json'), 'utf8'))
      expect(receipts.packs).toHaveLength(1)
      expect(receipts.packs[0].appVersion).toBe('1.2.3')
      expect(receipts.packs[0].components).toEqual(['cad-viewer'])
      // Re-running the same top-up stays honest and idempotent.
      expect(installPack(out, install).installed).toEqual(['cad-viewer'])
      const again = JSON.parse(readFileSync(join(install, 'resources/components/installed-packs.json'), 'utf8'))
      expect(again.packs).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })

  it('rejects app version drift before anything is written', () => {
    const root = fixtureRoot('1.2.3')
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack version ')), 'pack')
    const install = installedDir(root, '9.9.9')
    try {
      buildPack(root, out)
      try {
        installPack(out, install)
        throw new Error('expected rejection')
      } catch (error) {
        expect((error as PackError).code).toBe('VERSION_LOCK_MISMATCH')
        expect((error as Error).message).toContain('1.2.3')
        expect((error as Error).message).toContain('9.9.9')
      }
      expect(existsSync(join(install, 'resources/occt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })

  it('rejects pack bytes that drifted from their own manifest', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack tamper ')), 'pack')
    const install = installedDir(root, '1.2.3')
    try {
      buildPack(root, out)
      writeFileSync(join(out, 'files/cad-viewer/occt-import-js.js'), 'tampered')
      expectPackError(() => installPack(out, install), 'PACK_HASH_MISMATCH')
      expect(existsSync(join(install, 'resources/occt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })

  it('rejects a pack built from different bytes than the installed lock pins', () => {
    const rootA = fixtureRoot('1.2.3', 'glue-a', 'wasm-a')
    const rootB = fixtureRoot('1.2.3', 'glue-b', 'wasm-b')
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack drift ')), 'pack')
    const install = installedDir(rootA, '1.2.3')
    try {
      buildPack(rootB, out)
      expectPackError(() => installPack(out, install), 'VERSION_LOCK_MISMATCH')
      expect(existsSync(join(install, 'resources/occt'))).toBe(false)
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })

  it('rejects packs naming components the installation does not know', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack foreign ')), 'pack')
    const install = installedDir(root, '1.2.3')
    try {
      buildPack(root, out)
      const manifest = JSON.parse(readFileSync(join(out, 'component-pack.json'), 'utf8'))
      manifest.components[0].id = 'evil-component'
      writeFileSync(join(out, 'component-pack.json'), JSON.stringify(manifest))
      expectPackError(() => installPack(out, install), 'COMPONENT_NOT_IN_LOCK')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })

  it('refuses directories that carry no installer version lock', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack nolock ')), 'pack')
    const install = mkdtempSync(join(tmpdir(), 'ideer pack plain '))
    try {
      buildPack(root, out)
      expectPackError(() => installPack(out, install), 'INSTALL_DIR_INVALID')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })

  it('refuses malformed manifests with the fixed code', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack malformed ')), 'pack')
    const install = installedDir(root, '1.2.3')
    try {
      buildPack(root, out)
      const manifest = readFileSync(join(out, 'component-pack.json'), 'utf8')
      const broken = [
        'not json',
        JSON.stringify({ schema: 2, appVersion: '1.2.3', components: [] }),
        JSON.stringify({ schema: 1, appVersion: 'x', components: [] }),
        JSON.stringify({ schema: 1, appVersion: '1.2.3' }),
        JSON.stringify({ schema: 1, appVersion: '1.2.3', components: [{ id: 'cad-viewer', extra: 1 }] })
      ]
      for (const payload of broken) {
        writeFileSync(join(out, 'component-pack.json'), payload)
        expectPackError(() => installPack(out, install), 'PACK_MANIFEST_INVALID')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })
})

describe('offline component pack stays offline (#119)', () => {
  it('performs no network access from any component tool module', () => {
    for (const file of ['scripts/component-pack.cjs', 'scripts/component-catalog.cjs', 'scripts/generate-component-nsis.cjs']) {
      const source = readFileSync(file, 'utf8')
      // Every require stays inside the node standard library plus the sibling
      // catalog module; no URL, fetch, or socket API ever appears.
      for (const specifier of source.match(/require\((['"])(.*?)\1\)/g) ?? []) {
        const target = specifier.match(/require\((['"])(.*?)\1\)/)![2]
        expect(target, `${file}: ${target}`).toMatch(/^(node:(fs|path|crypto)|\.\/component-catalog\.cjs)$/)
      }
      expect(source, file).not.toMatch(/https?:\/\//)
      expect(source, file).not.toMatch(/\bfetch\s*\(/)
      expect(source, file).not.toMatch(/\b(dns|tls|net|http|https|dgram|XMLHttpRequest|WebSocket)\b/)
    }
  })

  it('reads only local paths the caller provides', () => {
    const root = fixtureRoot()
    const out = join(mkdtempSync(join(tmpdir(), 'ideer pack local ')), 'pack')
    const install = installedDir(root, '1.2.3')
    try {
      buildPack(root, out)
      installPack(out, install)
      expect(readdirSync(join(install, 'resources/occt')).sort()).toEqual(['occt-import-js.js', 'occt-import-js.wasm'])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })
})

describe('offline component pack CLI (#119)', () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/component-pack.cjs', ...args], { encoding: 'utf8', windowsHide: true })

  it('builds and installs through the documented commands', () => {
    const root = fixtureRoot()
    const scratch = mkdtempSync(join(tmpdir(), 'ideer pack cli '))
    const out = join(scratch, 'pack')
    const install = installedDir(root, '1.2.3')
    try {
      const built = cli('build', '--root', root, '--out', out, '--components', 'cad-viewer')
      expect({ code: built.status, stderr: built.stderr }).toEqual({ code: 0, stderr: '' })
      expect(existsSync(join(out, 'component-pack.json'))).toBe(true)
      const done = cli('install', '--pack', out, '--to', install)
      expect({ code: done.status, stderr: done.stderr }).toEqual({ code: 0, stderr: '' })
      expect(existsSync(join(install, 'resources/occt/occt-import-js.js'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
      rmSync(install, { recursive: true, force: true })
    }
  })

  it('refuses any unrecognized or stray argument with PACK_USAGE', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ideer pack strict '))
    const out = join(scratch, 'pack')
    try {
      // A stray positional, a typo'd flag, a duplicate option, a missing
      // --out and an unknown command are all usage errors — never ignored.
      for (const args of [
        ['build', '--out', out, 'junk'],
        ['build', '--out', out, '--componets', 'cad-viewer'],
        ['build', '--out', out, '--out', out],
        ['build'],
        ['install', '--pack', out],
        ['download', '--out', out]
      ]) {
        const run = cli(...args)
        expect({ args: args.join(' '), code: run.status }).toMatchObject({ code: 1 })
        expect(run.stderr).toContain('PACK_USAGE')
        expect(existsSync(out)).toBe(false)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

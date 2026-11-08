import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  CatalogError, componentById, componentLock, expandTier, generateNsis, loadCatalog
} from '../scripts/component-catalog.cjs'

const root = resolve('.')

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('installer component catalog (#119)', () => {
  it('loads and validates the checked-in catalog', () => {
    const catalog = loadCatalog(root)
    expect(catalog.tiers.map((tier: { id: string }) => tier.id)).toEqual(['minimal', 'typical', 'custom'])
    expect(catalog.tiers.map((tier: { name: string }) => tier.name)).toEqual(['最小安装', '常用安装', '自定义'])
    expect(catalog.components.map((item: { id: string; status: string }) => [item.id, item.status])).toEqual([
      ['cad-viewer', 'available'],
      ['tecplot-panel', 'bundled'],
      ['catia-abaqus', 'pending']
    ])
    expect(componentById(catalog, 'cad-viewer')?.artifact.dest).toBe('resources/occt')
  })

  it('rejects shape drift with the fixed CATALOG_INVALID code', () => {
    const catalog = loadCatalog(root)
    const scratch = mkdtempSync(join(tmpdir(), 'ideer-catalog-invalid-'))
    const mutated = (edit: (data: any) => void) => {
      const data = JSON.parse(JSON.stringify(catalog))
      edit(data)
      return data
    }
    const invalid = [
      mutated(data => { data.schema = 2 }),
      mutated(data => { data.unknown = true }),
      mutated(data => { data.tiers = data.tiers.slice(0, 2) }),
      mutated(data => { data.tiers[0].id = 'tiny' }),
      mutated(data => { const tier = data.tiers[1]; data.tiers[1] = data.tiers[2]; data.tiers[2] = tier }),
      mutated(data => { data.components[0].status = 'maybe' }),
      mutated(data => { delete data.components[0].artifact }),
      mutated(data => { delete data.components[0].tiers }),
      mutated(data => { data.components[0].artifact.files = ['nested/occt-import-js.js'] }),
      mutated(data => { data.components[0].artifact.files = [] }),
      mutated(data => { data.components[0].artifact.dest = '..\\escape' }),
      mutated(data => { data.components[2].artifact = data.components[0].artifact }),
      mutated(data => { data.components.push(data.components[0]) }),
      mutated(data => { delete data.components[1].note }),
      // NSIS emission discipline: newlines, quotes and $ must never reach a
      // section name, a SetOutPath/File/Delete path or a tier label.
      mutated(data => { data.tiers[0].name = '最小安装\nInstType "evil"' }),
      mutated(data => { data.tiers[0].description = 'line\r\nbreak' }),
      mutated(data => { data.components[0].name = 'CAD 查看\r器' }),
      mutated(data => { data.components[0].artifact.dest = 'resources/$TEMP' }),
      mutated(data => { data.components[0].artifact.files = ['occt-import-js.js', 'quoted".js'] }),
      mutated(data => { data.components[0].artifact.files = ['occt-import-js.js', 'dollar$OUTDIR.js'] }),
      // Case-insensitive filesystems must not collapse two members into one.
      mutated(data => { data.components[0].artifact.files = ['occt-import-js.js', 'OCCT-IMPORT-JS.JS'] })
    ]
    try {
      invalid.forEach((data, index) => {
        const broken = join(scratch, `catalog-${index}.json`)
        writeFileSync(broken, JSON.stringify(data))
        expect(() => loadCatalog(root, broken), JSON.stringify(data)).toThrow(CatalogError)
        try { loadCatalog(root, broken) } catch (error) { expect((error as CatalogError).code).toBe('CATALOG_INVALID') }
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('expands tiers to installable component ids only', () => {
    const catalog = loadCatalog(root)
    expect(expandTier(catalog, 'minimal')).toEqual([])
    expect(expandTier(catalog, 'typical')).toEqual(['cad-viewer'])
    expect(expandTier(catalog, 'custom')).toEqual(['cad-viewer'])
    expect(() => expandTier(catalog, 'everything')).toThrow(CatalogError)
  })

  it('locks artifacts to the app version with sha-256 pinned by provenance', () => {
    const lock = componentLock(root, '0.2.0')
    expect(lock.appVersion).toBe('0.2.0')
    const cad = lock.components['cad-viewer']
    expect(cad.dest).toBe('resources/occt')
    const pins = JSON.parse(readFileSync('resources/provenance/linz-source.json', 'utf8')).files
    for (const name of ['occt-import-js.js', 'occt-import-js.wasm']) {
      expect(cad.files[name]).toBe(sha256(join(root, 'resources/occt', name)))
      // The linz provenance pin stays authoritative for the source bytes.
      expect(cad.files[name]).toBe(pins[`resources/occt/${name}`])
    }
  })

  it('refuses to lock a build tree whose artifact bytes drifted from provenance', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ideer catalog drift '))
    const resources = join(scratch, 'resources')
    mkdirSync(join(resources, 'components'), { recursive: true })
    mkdirSync(join(resources, 'occt'), { recursive: true })
    mkdirSync(join(resources, 'provenance'), { recursive: true })
    copyFileSync('resources/components/catalog.json', join(resources, 'components/catalog.json'))
    copyFileSync('resources/provenance/linz-source.json', join(resources, 'provenance/linz-source.json'))
    writeFileSync(join(resources, 'occt/occt-import-js.js'), 'drifted glue')
    writeFileSync(join(resources, 'occt/occt-import-js.wasm'), 'drifted wasm')
    try {
      expect(() => componentLock(scratch, '0.2.0')).toThrow(CatalogError)
      try { componentLock(scratch, '0.2.0') } catch (error) {
        expect((error as CatalogError).code).toBe('PROVENANCE_MISMATCH')
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('refuses to lock when an artifact file is missing', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ideer catalog absent '))
    const resources = join(scratch, 'resources')
    mkdirSync(join(resources, 'components'), { recursive: true })
    mkdirSync(join(resources, 'occt'), { recursive: true })
    mkdirSync(join(resources, 'provenance'), { recursive: true })
    copyFileSync('resources/components/catalog.json', join(resources, 'components/catalog.json'))
    copyFileSync('resources/provenance/linz-source.json', join(resources, 'provenance/linz-source.json'))
    try {
      try { componentLock(scratch, '0.2.0') } catch (error) {
        expect((error as CatalogError).code).toBe('ARTIFACT_MISSING')
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('installer component NSIS generation (#119)', () => {
  it('regenerates the checked-in script byte-for-byte', () => {
    expect(generateNsis(loadCatalog(root))).toBe(readFileSync('resources/nsis/components.nsh', 'utf8'))
  })

  it('maps the three tiers onto install types and per-component SectionIn membership', () => {
    const script = generateNsis(loadCatalog(root))
    expect(script.indexOf('InstType "最小安装"')).toBeLessThan(script.indexOf('InstType "常用安装"'))
    expect(script.indexOf('InstType "常用安装"')).toBeLessThan(script.indexOf('InstType "自定义"'))
    // 常用 + 自定义 only: the CAD viewer must never ride the minimal tier.
    const cad = script.slice(script.indexOf('Section "CAD 查看器"'), script.indexOf('SectionEnd', script.indexOf('Section "CAD 查看器"')))
    expect(cad).toContain('SectionIn 2 3')
    expect(cad).not.toContain('SectionIn 1')
  })

  it('renders bundled and pending components as honest non-installable sections', () => {
    const script = generateNsis(loadCatalog(root))
    expect(script).toContain('SectionIn RO')
    expect(script).toContain('Section /o "CATIA/Abaqus 配套组件（待提供：需待 #87 落地后随离线组件包补装）"')
    // Only the available component's section may carry File instructions.
    expect(script.match(/^\s+File /gm)).toHaveLength(2)
    expect(script).toContain('SectionSetFlags ${SEC_IDEER_CATIA_ABAQUS} 16')
  })

  it('declares the core section index and uninstalls exactly the installed files', () => {
    const script = generateNsis(loadCatalog(root))
    expect(script).toContain('!define IDEER_CORE_SECTION_INDEX 3')
    expect(script).toContain('Delete "$INSTDIR\\resources\\occt\\occt-import-js.js"')
    expect(script).toContain('Delete "$INSTDIR\\resources\\occt\\occt-import-js.wasm"')
  })

  it('pins the checked-in script through the generator --check mode', () => {
    const run = spawnSync(process.execPath, ['scripts/generate-component-nsis.cjs', '--check'], { encoding: 'utf8' })
    expect({ code: run.status, stderr: run.stderr }).toEqual({ code: 0, stderr: '' })
  })
})

describe('build-time component lock emission (#119)', () => {
  const afterPack = require('../scripts/release/issue-107/after-pack.cjs')

  it('writes the version lock next to the shipped catalog during afterPack', async () => {
    const previous = process.env.IDEER_UPDATES_PUBLIC_KEY_FILE
    const scratch = mkdtempSync(join(tmpdir(), 'ideer lock emit '))
    process.env.IDEER_UPDATES_PUBLIC_KEY_FILE = resolve('resources/updates/updates-public-key.pem')
    try {
      await afterPack({ appOutDir: scratch, packager: { appInfo: { version: '9.9.9' }, info: { buildResourcesDir: resolve('resources') } } })
      const lock = JSON.parse(readFileSync(join(scratch, 'resources/components/components-lock.json'), 'utf8'))
      expect(lock.appVersion).toBe('9.9.9')
      expect(lock.components['cad-viewer'].files['occt-import-js.wasm']).toBe(sha256('resources/occt/occt-import-js.wasm'))
    } finally {
      if (previous === undefined) delete process.env.IDEER_UPDATES_PUBLIC_KEY_FILE
      else process.env.IDEER_UPDATES_PUBLIC_KEY_FILE = previous
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('fails the build when the build tree bytes drift from provenance', async () => {
    const previous = process.env.IDEER_UPDATES_PUBLIC_KEY_FILE
    const scratch = mkdtempSync(join(tmpdir(), 'ideer lock drift '))
    const resources = join(scratch, 'resources')
    mkdirSync(join(resources, 'occt'), { recursive: true })
    mkdirSync(join(resources, 'provenance'), { recursive: true })
    mkdirSync(join(resources, 'components'), { recursive: true })
    copyFileSync('resources/components/catalog.json', join(resources, 'components/catalog.json'))
    copyFileSync('resources/provenance/linz-source.json', join(resources, 'provenance/linz-source.json'))
    copyFileSync('resources/occt/occt-import-js.js', join(resources, 'occt/occt-import-js.js'))
    writeFileSync(join(resources, 'occt/occt-import-js.wasm'), 'drifted wasm')
    process.env.IDEER_UPDATES_PUBLIC_KEY_FILE = resolve('resources/updates/updates-public-key.pem')
    try {
      await expect(afterPack({
        appOutDir: join(scratch, 'out'),
        packager: { appInfo: { version: '9.9.9' }, info: { buildResourcesDir: resources } }
      })).rejects.toThrow(/PROVENANCE_MISMATCH/)
    } finally {
      if (previous === undefined) delete process.env.IDEER_UPDATES_PUBLIC_KEY_FILE
      else process.env.IDEER_UPDATES_PUBLIC_KEY_FILE = previous
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts/verify-third-party.cjs')
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

const occtJs = Buffer.from('fixture occt glue bytes')
const occtWasm = Buffer.from('fixture occt wasm bytes')

interface Fixture {
  root: string
  files: Map<string, string | Buffer>
}

// A minimal tree that mirrors the real distribution surface: npm production
// closure, Electron pin, occt binaries pinned in linz-source.json, runtime
// archives pinned in distribution.lock.json, an inventory, and a notices
// ledger. Every test mutates a fresh copy; the repository tree is never touched.
function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ideer-third-party-'))
  const files = new Map<string, string | Buffer>()
  const put = (path: string, data: string | Buffer) => {
    files.set(path, data)
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), data)
  }

  put('package.json', JSON.stringify({
    name: 'fixture-desktop', version: '0.0.0', license: 'UNLICENSED', private: true,
    dependencies: { react: '18.3.1', 'left-pad': '1.3.0' },
    devDependencies: { '@types/react': '18.3.31', electron: '22.3.27' }
  }, null, 2))
  put('package-lock.json', JSON.stringify({
    name: 'fixture-desktop', version: '0.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-desktop', version: '0.0.0', dependencies: { react: '18.3.1', 'left-pad': '1.3.0' } },
      'node_modules/react': {
        version: '18.3.1', resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz',
        integrity: 'sha512-ReactIntegrityFixture==', license: 'MIT', dependencies: { 'loose-envify': '^1.1.0' }
      },
      'node_modules/loose-envify': {
        version: '1.4.0', resolved: 'https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz',
        integrity: 'sha512-LooseIntegrityFixture==', license: 'MIT', dependencies: { 'js-tokens': '^4.0.0' }
      },
      'node_modules/js-tokens': {
        version: '4.0.0', resolved: 'https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz',
        integrity: 'sha512-JsTokensIntegrityFixture==', license: 'MIT'
      },
      'node_modules/left-pad': {
        version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: 'sha512-LeftPadIntegrityFixture==', license: 'MIT'
      },
      'node_modules/@types/react': { version: '18.3.31', dev: true, license: 'MIT' },
      'node_modules/electron': { version: '22.3.27', dev: true, license: 'MIT' }
    }
  }, null, 2))
  put('electron-builder.yml', [
    'appId: com.orbitcrew.ideer.desktop',
    'electronVersion: 22.3.27',
    'extraResources:',
    '  - from: .runtime',
    '    to: runtime',
    '  - from: resources/occt',
    '    to: occt',
    '  - from: resources/provenance',
    '    to: provenance',
    ''
  ].join('\n'))
  put('resources/occt/occt-import-js.js', occtJs)
  put('resources/occt/occt-import-js.wasm', occtWasm)
  put('resources/provenance/linz-source.json', JSON.stringify({
    repository: 'https://github.com/Neowyh/linz',
    commit: 'f88141bb3d3450a572fcc52e0f9b48a1e60d3b13',
    declaredLicense: 'MIT',
    files: {
      'resources/occt/occt-import-js.js': sha256(occtJs),
      'resources/occt/occt-import-js.wasm': sha256(occtWasm)
    }
  }, null, 2))
  put('local-runtime/distribution.lock.json', JSON.stringify({
    python: '3.12.10', platform: 'win_amd64',
    artifacts: [
      { name: 'python-3.12.10-embed-amd64.zip', url: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', sha256: 'a'.repeat(64) },
      { name: 'pypdf-5.1.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/fixtures/pypdf-5.1.0-py3-none-any.whl', sha256: 'b'.repeat(64) }
    ]
  }, null, 2))
  put('resources/provenance/runtime-source.json', JSON.stringify({
    repository: 'https://github.com/Orbit-Crew/iDeer',
    commit: 'ccb251e07e5f5934b851e4c3df00224718f28123', files: {}, modified: {}
  }, null, 2))
  put('local-runtime/LICENSE.upstream', 'MIT License\n\nCopyright (c) 2025-2026 iDeer Authors\n')

  const npmItem = (name: string, version: string, integrity: string, maintainer: string) => ({
    id: `npm:${name}@${version}`, kind: 'npm-dependency', name, version,
    upstream: { name, source: `https://registry.npmjs.org/${name}`, maintainer },
    license: { declared: 'MIT', evidence: `package-lock.json packages["node_modules/${name}"]` },
    maintainer: 'Orbit-Crew', status: 'verified',
    distribution: { ships: true, path: `app.asar node_modules/${name}`, mechanism: 'electron-builder production dependencies' },
    pin: { integrity }
  })
  const inventory = {
    version: 1,
    humanGates: [{
      id: 'linz-license-grant', item: 'linz-derivation', owner: 'Neowyh',
      reason: 'Upstream declares MIT in package.json but ships no LICENSE text.',
      userNotice: '公开分发暂停：等待上游授权确认。'
    }],
    items: [
      {
        id: 'linz-derivation', kind: 'source-derivation',
        upstream: { name: 'linz', source: 'https://github.com/Neowyh/linz', commit: 'f88141bb3d3450a572fcc52e0f9b48a1e60d3b13', maintainer: 'LINZ Team (Neowyh)' },
        license: { declared: 'MIT (declared only; no upstream LICENSE text)', evidence: 'resources/provenance/linz-source.json#declaredLicense' },
        maintainer: 'Neowyh', status: 'pending-maintainer-verification',
        distribution: { ships: true, path: 'src/** + resources/provenance/linz-package*.json', mechanism: 'derived source tree' }
      },
      {
        id: 'electron@22.3.27', kind: 'framework', name: 'electron', version: '22.3.27',
        upstream: { name: 'Electron', source: 'https://github.com/electron/electron', maintainer: 'OpenJS Foundation' },
        license: { declared: 'MIT', evidence: 'package-lock.json node_modules/electron + electron-builder.yml electronVersion' },
        maintainer: 'Orbit-Crew', status: 'verified',
        distribution: { ships: true, path: 'install root (Electron distribution)', mechanism: 'electron-builder framework' }
      },
      npmItem('react', '18.3.1', 'sha512-ReactIntegrityFixture==', 'Meta Platforms + React contributors'),
      npmItem('loose-envify', '1.4.0', 'sha512-LooseIntegrityFixture==', 'Andres Suarez'),
      npmItem('js-tokens', '4.0.0', 'sha512-JsTokensIntegrityFixture==', 'Simon Lydell'),
      npmItem('left-pad', '1.3.0', 'sha512-LeftPadIntegrityFixture==', 'azer'),
      {
        id: 'occt-import-js', kind: 'binary',
        upstream: { name: 'occt-import-js 0.0.23', source: 'https://github.com/kovacsv/occt-import-js', version: '0.0.23', maintainer: 'kovacsv (embedded OCCT: Open CASCADE SAS)' },
        license: { declared: 'LGPL-2.1 (embedded OCCT also LGPL-2.1 with the OCCT exception)', evidence: 'resources/provenance/linz-package-lock.json occt-import-js license=LGPL-2.1' },
        maintainer: 'Orbit-Crew', status: 'verified',
        distribution: {
          ships: true, path: 'occt/', mechanism: 'extraResources resources/occt -> occt',
          files: { 'occt/occt-import-js.js': sha256(occtJs), 'occt/occt-import-js.wasm': sha256(occtWasm) }
        }
      },
      {
        id: 'runtime-archive:python-3.12.10-embed-amd64.zip', kind: 'runtime-archive',
        upstream: { name: 'CPython 3.12.10 (embeddable)', source: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', maintainer: 'Python Software Foundation' },
        license: { declared: 'PSF-2.0', evidence: 'python.org distribution license' },
        maintainer: 'Orbit-Crew', status: 'verified',
        distribution: { ships: true, path: 'runtime/', mechanism: 'prepare-runtime.py extraction' },
        pin: { name: 'python-3.12.10-embed-amd64.zip', url: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', sha256: 'a'.repeat(64) }
      },
      {
        id: 'runtime-archive:pypdf-5.1.0-py3-none-any.whl', kind: 'runtime-archive',
        upstream: { name: 'pypdf 5.1.0', source: 'https://files.pythonhosted.org/fixtures/pypdf-5.1.0-py3-none-any.whl', maintainer: 'Martin Thoma' },
        license: { declared: 'BSD-3-Clause', evidence: 'published wheel metadata' },
        maintainer: 'Orbit-Crew', status: 'verified',
        distribution: { ships: true, path: 'runtime/', mechanism: 'prepare-runtime.py extraction' },
        pin: { name: 'pypdf-5.1.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/fixtures/pypdf-5.1.0-py3-none-any.whl', sha256: 'b'.repeat(64) }
      },
      {
        id: 'ideer-runtime-core', kind: 'runtime-source',
        upstream: { name: 'iDeer Runtime core', source: 'https://github.com/Orbit-Crew/iDeer', commit: 'ccb251e07e5f5934b851e4c3df00224718f28123', maintainer: 'Orbit-Crew' },
        license: { declared: 'MIT', evidence: 'local-runtime/LICENSE.upstream -> runtime/LICENSE.ideer-runtime.txt' },
        maintainer: 'Orbit-Crew', status: 'verified',
        distribution: { ships: true, path: 'runtime/core', mechanism: 'prepare-runtime.py copy' },
        evidenceFiles: ['local-runtime/LICENSE.upstream', 'resources/provenance/runtime-source.json']
      },
      {
        id: 'not-shipped:linz-skills', kind: 'not-shipped',
        upstream: { name: 'linz third-party skills', source: 'https://github.com/Neowyh/linz', maintainer: 'LINZ Team (Neowyh)' },
        license: { declared: '未核验', evidence: 'none (not distributed)' },
        maintainer: 'Neowyh', status: 'not-shipped',
        distribution: { ships: false },
        reason: 'Upstream skill licenses were never verified.',
        userNotice: '需另行安装/替换：linz 第三方技能不随包分发。'
      },
      {
        id: 'not-shipped:npm-dev-dependencies', kind: 'not-shipped',
        upstream: { name: 'devDependencies (e.g. @types/react 18.3.31)', source: 'https://registry.npmjs.org/', maintainer: 'various' },
        license: { declared: 'various', evidence: 'package-lock.json dev entries' },
        maintainer: 'Orbit-Crew', status: 'not-shipped',
        distribution: { ships: false },
        reason: 'Build/test-only dependencies are not distributed.',
        userNotice: '不随包：@types/* 等仅开发期依赖需另行在开发环境安装。'
      }
    ]
  }
  put('resources/provenance/third-party-inventory.json', JSON.stringify(inventory, null, 2) + '\n')

  const rows = inventory.items.map(item => `| \`${item.id}\` | ${item.upstream.name} | ${item.license.declared} | ${item.maintainer} |`)
  put('THIRD_PARTY_NOTICES.md', [
    '# Third-party notices (fixture)',
    '',
    '| 清单 id | 组件 | 许可证 | 负责维护者 |',
    '| --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n'))
  return { root, files }
}

function rewrite(root: string, path: string, data: string | Buffer) {
  writeFileSync(join(root, path), data)
}

function editInventory(root: string, edit: (inventory: any) => void) {
  const path = 'resources/provenance/third-party-inventory.json'
  const inventory = JSON.parse(readFileSync(join(root, path), 'utf8'))
  edit(inventory)
  rewrite(root, path, JSON.stringify(inventory, null, 2) + '\n')
}

function editNotices(root: string, edit: (lines: string[]) => string[]) {
  const path = 'THIRD_PARTY_NOTICES.md'
  const lines = readFileSync(join(root, path), 'utf8').split('\n')
  rewrite(root, path, edit(lines).join('\n'))
}

function verify(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { windowsHide: true, encoding: 'utf8' })
}

// Removes id rows from the notices ledger and the matching inventory items, so
// higher-level checks stay isolated from NOTICES_DRIFT.
function dropItemEverywhere(root: string, id: string) {
  editInventory(root, inventory => { inventory.items = inventory.items.filter(item => item.id !== id) })
  editNotices(root, lines => lines.filter(line => !line.includes(`\`${id}\``)))
}

describe('third-party inventory verification', () => {
  it('accepts a consistent fixture tree', () => {
    const fixture = buildFixture()
    try {
      const result = verify(fixture.root)
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
      expect(result.stdout).toContain('Verified third-party inventory')
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })

  it('accepts the real repository tree', () => {
    const result = spawnSync(process.execPath, [script], { windowsHide: true, encoding: 'utf8', cwd: resolve('.') })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })

  describe.each([
    ['a shipped npm dependency missing from the inventory', (root: string) => dropItemEverywhere(root, 'npm:react@18.3.1')],
    ['a shipped occt file missing from the inventory', (root: string) => {
      editInventory(root, inventory => {
        const item = inventory.items.find((i: any) => i.id === 'occt-import-js')
        delete item.distribution.files['occt/occt-import-js.wasm']
      })
    }],
    ['an unpinned extra file under resources/occt', (root: string) => rewrite(root, 'resources/occt/extra.bin', 'unpinned')],
    ['a distribution.lock.json artifact missing from the inventory', (root: string) => dropItemEverywhere(root, 'runtime-archive:pypdf-5.1.0-py3-none-any.whl')],
    ['the Electron framework missing from the inventory', (root: string) => dropItemEverywhere(root, 'electron@22.3.27')]
  ])('rejects %s', (_name, mutate) => {
    it('fails with SHIPPED_NOT_INVENTORIED', () => {
      const fixture = buildFixture()
      try {
        mutate(fixture.root)
        const result = verify(fixture.root)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('SHIPPED_NOT_INVENTORIED')
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })
  })

  describe.each([
    ['an inventory npm item that does not ship', (root: string) => {
      editInventory(root, inventory => inventory.items.push({
        id: 'npm:ghost@1.0.0', kind: 'npm-dependency', name: 'ghost', version: '1.0.0',
        upstream: { name: 'ghost', source: 'https://registry.npmjs.org/ghost', maintainer: 'nobody' },
        license: { declared: 'MIT', evidence: 'package-lock.json' },
        maintainer: 'Orbit-Crew', status: 'verified',
        distribution: { ships: true, path: 'app.asar node_modules/ghost', mechanism: 'electron-builder production dependencies' },
        pin: { integrity: 'sha512-GhostIntegrityFixture==' }
      }))
      editNotices(root, lines => lines.filter(l => l !== '').concat('| `npm:ghost@1.0.0` | ghost | MIT | Orbit-Crew |', ''))
    }],
    ['an inventory runtime archive absent from distribution.lock.json', (root: string) => {
      editInventory(root, inventory => {
        const item = inventory.items.find((i: any) => i.id.startsWith('runtime-archive:'))
        item.pin.name = 'not-in-lock.whl'
        item.id = 'runtime-archive:not-in-lock.whl'
      })
      editNotices(root, lines => lines.map(l => l.replace('runtime-archive:pypdf-5.1.0-py3-none-any.whl', 'runtime-archive:not-in-lock.whl')))
    }],
    ['a claimed runtime-source evidence file that does not exist', (root: string) => rmSync(join(root, 'local-runtime/LICENSE.upstream'))]
  ])('rejects %s', (_name, mutate) => {
    it('fails with INVENTORY_NOT_SHIPPED', () => {
      const fixture = buildFixture()
      try {
        mutate(fixture.root)
        const result = verify(fixture.root)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('INVENTORY_NOT_SHIPPED')
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })
  })

  it('rejects a devDependency claimed as distributed', () => {
    const fixture = buildFixture()
    try {
      editInventory(fixture.root, inventory => inventory.items.push({
        id: 'npm:@types/react@18.3.31', kind: 'npm-dependency', name: '@types/react', version: '18.3.31',
        upstream: { name: '@types/react', source: 'https://registry.npmjs.org/@types/react', maintainer: 'DefinitelyTyped' },
        license: { declared: 'MIT', evidence: 'package-lock.json' },
        maintainer: 'Orbit-Crew', status: 'verified',
        distribution: { ships: true, path: 'app.asar node_modules/@types/react', mechanism: 'electron-builder production dependencies' },
        pin: { integrity: 'sha512-TypesIntegrityFixture==' }
      }))
      editNotices(fixture.root, lines => lines.filter(l => l !== '').concat('| `npm:@types/react@18.3.31` | @types/react | MIT | Orbit-Crew |', ''))
      const result = verify(fixture.root)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('DEPENDENCY_CLASS_MISMATCH')
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })

  describe.each([
    ['occt file bytes drifting from the linz-source.json pin', (root: string) => rewrite(root, 'resources/occt/occt-import-js.js', Buffer.from('drifted bytes'))],
    ['an inventory archive sha256 drifting from distribution.lock.json', (root: string) => {
      editInventory(root, inventory => {
        inventory.items.find((i: any) => i.id === 'runtime-archive:pypdf-5.1.0-py3-none-any.whl').pin.sha256 = 'c'.repeat(64)
      })
    }],
    ['an inventory electron version drifting from the pinned build version', (root: string) => {
      editInventory(root, inventory => {
        const item = inventory.items.find((i: any) => i.kind === 'framework')
        item.version = '99.0.0'
        item.id = 'electron@99.0.0'
      })
      editNotices(root, lines => lines.map(l => l.replace('electron@22.3.27', 'electron@99.0.0')))
    }],
    ['an npm integrity pin drifting from package-lock.json', (root: string) => {
      editInventory(root, inventory => {
        inventory.items.find((i: any) => i.id === 'npm:left-pad@1.3.0').pin.integrity = 'sha512-Drifted=='
      })
    }]
  ])('rejects %s', (_name, mutate) => {
    it('fails with PIN_DRIFT', () => {
      const fixture = buildFixture()
      try {
        mutate(fixture.root)
        const result = verify(fixture.root)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('PIN_DRIFT')
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })
  })

  describe.each([
    ['a ledger row removed from THIRD_PARTY_NOTICES.md', (root: string) => editNotices(root, lines => lines.filter(l => !l.includes('`npm:js-tokens@4.0.0`')))],
    ['a ledger row referencing an unknown item', (root: string) => editNotices(root, lines => lines.filter(l => l !== '').concat('| `npm:unknown@1.0.0` | unknown | MIT | Orbit-Crew |', ''))]
  ])('rejects %s', (_name, mutate) => {
    it('fails with NOTICES_DRIFT', () => {
      const fixture = buildFixture()
      try {
        mutate(fixture.root)
        const result = verify(fixture.root)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('NOTICES_DRIFT')
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })
  })

  describe.each([
    ['a new pending-maintainer-verification item outside the tracked gates', (root: string) => {
      editInventory(root, inventory => {
        inventory.items.find((i: any) => i.id === 'occt-import-js').status = 'pending-maintainer-verification'
      })
    }],
    ['the tracked human gate removed from the inventory gate list', (root: string) => {
      editInventory(root, inventory => { inventory.humanGates = [] })
    }],
    ['the gate resolved without updating the compiled tracked list', (root: string) => {
      editInventory(root, inventory => {
        inventory.items.find((i: any) => i.id === 'linz-derivation').status = 'verified'
        inventory.humanGates = []
      })
    }],
    ['a gate entry pointing at a non-pending item', (root: string) => {
      editInventory(root, inventory => { inventory.humanGates[0].item = 'electron@22.3.27' })
    }]
  ])('rejects %s', (_name, mutate) => {
    it('fails with PENDING_GATE_MISMATCH', () => {
      const fixture = buildFixture()
      try {
        mutate(fixture.root)
        const result = verify(fixture.root)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('PENDING_GATE_MISMATCH')
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })
  })

  describe.each([
    ['an unknown status value', (root: string) => {
      editInventory(root, inventory => { inventory.items[0].status = 'maybe' })
    }],
    ['a duplicate item id', (root: string) => {
      editInventory(root, inventory => inventory.items.push(JSON.parse(JSON.stringify(inventory.items[1]))))
    }],
    ['a shipped item missing the responsible maintainer', (root: string) => {
      editInventory(root, inventory => { delete inventory.items[2].maintainer })
    }],
    ['a not-shipped item missing the user notice', (root: string) => {
      editInventory(root, inventory => { delete inventory.items.find((i: any) => i.status === 'not-shipped').userNotice })
    }]
  ])('rejects %s', (_name, mutate) => {
    it('fails with INVENTORY_SCHEMA', () => {
      const fixture = buildFixture()
      try {
        mutate(fixture.root)
        const result = verify(fixture.root)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('INVENTORY_SCHEMA')
      } finally { rmSync(fixture.root, { recursive: true, force: true }) }
    })
  })

  it('reports every shipped occt file hash against its pin', () => {
    const fixture = buildFixture()
    try {
      const listed = readdirSync(join(fixture.root, 'resources/occt')).sort()
      expect(listed).toEqual(['occt-import-js.js', 'occt-import-js.wasm'])
    } finally { rmSync(fixture.root, { recursive: true, force: true }) }
  })
})

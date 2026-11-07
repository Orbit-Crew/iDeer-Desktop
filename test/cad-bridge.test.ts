// Issue 115: the CAD channel's trusted-main contract. The renderer names a
// workspace-logical path; the Runtime's own `locate` gate resolves it; the
// caps (size, triangle budget), the format whitelist and the honest refusals
// all live in the trusted service — and the pane's module graph touches only
// the two bridge reads it needs (cad + getStatus), never an embedded-content
// seam.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import { CadPaneService } from '../src/main/cadPane'
import { CAD_MAX_FILE_BYTES, CAD_MAX_TRIANGLES } from '../src/shared/desktop'

const workspace = mkdtempSync(join(tmpdir(), 'ideer-cad-'))
const subdirectory = join(workspace, 'parts')
mkdirSync(subdirectory)

function writeBinaryStl(name: string, triangleCount: number): string {
  const buffer = Buffer.alloc(84 + 50 * triangleCount)
  buffer.writeUInt32LE(triangleCount, 80)
  if (triangleCount > 0) {
    for (let v = 0; v < 9; v += 1) buffer.writeFloatLE(v % 3 === 0 ? 0 : 0.25, 84 + 12 + v * 4)
  }
  writeFileSync(join(subdirectory, name), buffer)
  return `/parts/${name}`
}

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

function service(overrides: Partial<ConstructorParameters<typeof CadPaneService>[0]> = {}): CadPaneService {
  return new CadPaneService({
    locate: async (path) => {
      // Mirror the Runtime's containment: only workspace-logical shapes.
      if (!path.startsWith('/') || path.includes('..')) throw new Error('FILES_PATH_INVALID')
      return { physical: join(workspace, path.replaceAll('/', '\\').slice(1)) }
    },
    loadOcct: () => Promise.reject(new Error('未找到 occt-import-js（OpenCASCADE WASM 转换引擎未随包）')),
    ...overrides
  })
}

describe('cad channel contract (#115)', () => {
  it('reads a workspace STL into one bounded mesh payload', async () => {
    const view = await service().readMesh(writeBinaryStl('bracket.stl', 2))
    expect(view.format).toBe('stl')
    expect(view.stats).toEqual({ meshes: 1, vertices: 6, triangles: 2 })
    expect(view.positions).toBeInstanceOf(Float32Array)
    expect(view.indices).toBeInstanceOf(Uint32Array)
    expect(view.positions.length).toBe(18)
  })

  it("keeps the original viewer's format subset and refuses others by code", async () => {
    writeFileSync(join(subdirectory, 'model.iges'), 'IGES')
    writeFileSync(join(subdirectory, 'model.xyz'), 'x')
    await expect(service().readMesh('/parts/model.iges')).rejects.toThrow('CAD_FORMAT_UNSUPPORTED')
    await expect(service().readMesh('/parts/model.xyz')).rejects.toThrow('CAD_FORMAT_UNSUPPORTED')
    await expect(service().readMesh('/parts/noextension')).rejects.toThrow('CAD_FORMAT_UNSUPPORTED')
  })

  it("passes the Runtime's own gate errors through untouched", async () => {
    await expect(service().readMesh('../escape.stl')).rejects.toThrow('FILES_PATH_INVALID')
  })

  it('reports a missing file and a directory as distinct honest facts', async () => {
    await expect(service().readMesh('/parts/gone.stl')).rejects.toThrow('CAD_NOT_FOUND')
    mkdirSync(join(subdirectory, 'dir.stl'))
    await expect(service().readMesh('/parts/dir.stl')).rejects.toThrow('CAD_NOT_A_FILE')
  })

  it('refuses an over-cap file before reading it', async () => {
    writeFileSync(join(subdirectory, 'big.stl'), Buffer.alloc(CAD_MAX_FILE_BYTES + 1))
    await expect(service().readMesh('/parts/big.stl')).rejects.toThrow('CAD_FILE_TOO_LARGE')
  })

  it('refuses an over-budget binary STL from its header alone', async () => {
    // 84 + 50*3 bytes: under any size cap, but declares 3 triangles against a cap of 2.
    const path = writeBinaryStl('tiny-body.stl', 3)
    await expect(service({ maxTriangles: 2 }).readMesh(path)).rejects.toThrow('CAD_MESH_TOO_LARGE')
  })

  it('refuses an over-budget geometry after parse when the header cannot know', async () => {
    // ASCII STL: the count is not declared, so the cap lands after the parse.
    const body = [
      'solid m', 'facet normal 0 0 1', 'outer loop',
      'vertex 0 0 0', 'vertex 1 0 0', 'vertex 0 1 0', 'endloop', 'endfacet', 'endsolid m'
    ].join('\n')
    writeFileSync(join(subdirectory, 'ascii.stl'), body)
    await expect(service({ maxTriangles: 0 }).readMesh('/parts/ascii.stl')).rejects.toThrow('CAD_MESH_TOO_LARGE')
  })

  it('names an empty geometry instead of showing a blank viewer', async () => {
    const path = writeBinaryStl('empty.stl', 0)
    await expect(service().readMesh(path)).rejects.toThrow('CAD_EMPTY_GEOMETRY')
  })

  it('maps a missing conversion engine to its own code', async () => {
    writeFileSync(join(subdirectory, 'part.step'), 'ISO-10303-21;\nEND-ISO-10303-21;\n')
    await expect(service().readMesh('/parts/part.step')).rejects.toThrow('CAD_OCCT_UNAVAILABLE')
  })

  it('keeps reader parse errors intact', async () => {
    writeFileSync(join(subdirectory, 'broken.obj'), 'v 0 0 0\nf 1 5 9\n')
    await expect(service().readMesh('/parts/broken.obj')).rejects.toThrow('CAD_FACE_INDEX_INVALID')
  })

  it('caps STEP payloads with the same triangle budget', async () => {
    writeFileSync(join(subdirectory, 'cap.step'), 'ISO-10303-21;\n')
    const loaded = service({
      maxTriangles: 1,
      loadOcct: () => Promise.resolve({
        ReadStepFile: () => ({
          meshes: [
            { attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } },
            { attributes: { position: { array: [2, 0, 0, 3, 0, 0, 2, 1, 0] } }, index: { array: [0, 1, 2] } }
          ]
        })
      })
    })
    await expect(loaded.readMesh('/parts/cap.step')).rejects.toThrow('CAD_MESH_TOO_LARGE')
  })

  it("returns a converted STEP mesh with the converter's part facts", async () => {
    writeFileSync(join(subdirectory, 'ok.step'), 'ISO-10303-21;\n')
    const loaded = service({
      loadOcct: () => Promise.resolve({
        ReadStepFile: () => ({
          meshes: [{ attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } }]
        })
      })
    })
    const view = await loaded.readMesh('/parts/ok.step')
    expect(view.format).toBe('step')
    expect(view.stats).toEqual({ meshes: 1, vertices: 3, triangles: 1 })
  })
})

describe('cad pane graph (#115)', () => {
  it('touches only the cad read and the status read on the trusted bridge', async () => {
    const result = await build({
      entryPoints: ['src/renderer/src/dock/panels/viewer3dPane.tsx'],
      bundle: true,
      packages: 'external',
      platform: 'node',
      outdir: 'out/security-check',
      write: false,
      metafile: true
    })
    // The pane's module graph never reaches the preload seam itself.
    expect(Object.keys(result.metafile.inputs).some((path) => /(^|\/)src\/preload\//.test(path))).toBe(false)
    const text = result.outputFiles.map((file) => file.text).join('')
    expect(text).toMatch(/window\.ideer\.cad/)
    expect(text).toMatch(/window\.ideer\.getStatus/)
    expect(text).not.toMatch(/window\.ideer\.(?!(cad|getStatus)\b)/)
    // No embedded-content or executable seam anywhere in the graph. The
    // literal `webview` appears only as dock-store panel metadata (the
    // browser slot's runtime classification), never as an element.
    expect(text).not.toMatch(/ipcRenderer|sendToHost|openExternal|<webview|\.send\(|node-pty/)
  })
})

describe('cad caps (#115)', () => {
  it('keeps the documented limits', () => {
    expect(CAD_MAX_FILE_BYTES).toBe(100 * 1024 * 1024)
    expect(CAD_MAX_TRIANGLES).toBe(1_000_000)
  })
})

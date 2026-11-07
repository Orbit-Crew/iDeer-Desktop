// Issue 115: the CAD mesh readers' contract. Every supported form parses to
// the one triangle-soup shape the viewers render; every malformed input is an
// explicit error with a stable code, and an empty geometry is a plain zero —
// never a silent success with nothing to show.
import { describe, expect, it } from 'vitest'
import { binaryStlCountFromHeader, CadParseError, isBinaryStl, parseObj, parseStl } from '../src/main/cad/meshReaders'
import { stepToMesh, type OcctModule, type OcctStepContent } from '../src/main/cad/stepToMesh'

function binaryStl(triangles: Array<[[number, number, number], [number, number, number], [number, number, number]]>): Buffer {
  const buffer = Buffer.alloc(84 + 50 * triangles.length)
  buffer.write('test header, not solid', 0, 'utf8')
  buffer.writeUInt32LE(triangles.length, 80)
  triangles.forEach((triangle, t) => {
    const base = 84 + 50 * t
    // Facet normal (discarded by the reader).
    buffer.writeFloatLE(0, base)
    buffer.writeFloatLE(0, base + 4)
    buffer.writeFloatLE(1, base + 8)
    triangle.forEach((vertex, v) => {
      buffer.writeFloatLE(vertex[0], base + 12 + v * 12)
      buffer.writeFloatLE(vertex[1], base + 12 + v * 12 + 4)
      buffer.writeFloatLE(vertex[2], base + 12 + v * 12 + 8)
    })
  })
  return buffer
}

const BINARY_TRIANGLE: [[number, number, number], [number, number, number], [number, number, number]] =
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]]

describe('binary STL parsing (issue 115)', () => {
  it('parses two triangles into a sequential-index soup', () => {
    const mesh = parseStl(binaryStl([BINARY_TRIANGLE, [[1, 0, 0], [0, 0, 0], [0, 0, 1]]]))
    expect(mesh.triangles).toBe(2)
    expect(mesh.vertices).toBe(6)
    expect(mesh.positions).toBeInstanceOf(Float32Array)
    expect(mesh.positions.length).toBe(18)
    expect(mesh.indices).toBeInstanceOf(Uint32Array)
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 3, 4, 5])
    // First triangle's first vertex came through exactly.
    expect(mesh.positions[0]).toBeCloseTo(0)
    expect(mesh.positions[3]).toBeCloseTo(1)
  })

  it('detects the binary layout by the format arithmetic, not the header text', () => {
    expect(isBinaryStl(binaryStl([BINARY_TRIANGLE]))).toBe(true)
    // An ASCII file whose size happens to fit 84+50n is not binary: its
    // declared count field would be garbage, so the size check alone is the
    // discriminator the original format definition gives.
    const ascii = Buffer.from('solid thing\nendsolid thing\n')
    expect(isBinaryStl(ascii)).toBe(false)
  })

  it('reports the declared triangle count from a header slice', () => {
    const buffer = binaryStl([BINARY_TRIANGLE, BINARY_TRIANGLE, BINARY_TRIANGLE])
    expect(binaryStlCountFromHeader(buffer.subarray(0, 84), buffer.length)).toBe(3)
    // Size mismatch → not trusted as binary.
    expect(binaryStlCountFromHeader(buffer.subarray(0, 84), buffer.length - 1)).toBeNull()
    expect(binaryStlCountFromHeader(buffer.subarray(0, 40), buffer.length)).toBeNull()
  })

  it('refuses a non-finite vertex instead of rendering NaN geometry', () => {
    const buffer = binaryStl([BINARY_TRIANGLE])
    buffer.writeFloatLE(Number.NaN, 84 + 12)
    expect(() => parseStl(buffer)).toThrowError(expect.objectContaining({ code: 'CAD_MALFORMED_GEOMETRY' }))
  })
})

describe('ASCII STL parsing (issue 115)', () => {
  it('parses vertex triplets into one triangle', () => {
    const ascii = [
      'solid wing',
      'facet normal 0 0 1',
      '  outer loop',
      '    vertex 0.0 0.0 0.0',
      '    vertex 1e0 0 0',
      '    vertex 0 .5 0',
      '  endloop',
      'endfacet',
      'endsolid wing'
    ].join('\r\n')
    const mesh = parseStl(Buffer.from(ascii, 'utf8'))
    expect(mesh.triangles).toBe(1)
    expect(mesh.vertices).toBe(3)
    expect(mesh.positions[7]).toBeCloseTo(0.5)
  })

  it('counts zero triangles for a body without vertices (the caller rejects it honestly)', () => {
    const mesh = parseStl(Buffer.from('solid empty\nendsolid empty\n', 'utf8'))
    expect(mesh.triangles).toBe(0)
    expect(mesh.positions.length).toBe(0)
  })

  it('refuses a vertex line with missing coordinates', () => {
    const ascii = 'solid bad\nfacet\nvertex 1 2\nendfacet\nendsolid bad\n'
    expect(() => parseStl(Buffer.from(ascii, 'utf8'))).toThrowError(expect.objectContaining({ code: 'CAD_MALFORMED_GEOMETRY' }))
  })
})

describe('OBJ parsing (issue 115)', () => {
  it('fan-triangulates a quad and keeps 1-based indices', () => {
    const obj = ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3 4'].join('\n')
    const mesh = parseObj(obj)
    expect(mesh.vertices).toBe(4)
    expect(mesh.triangles).toBe(2)
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3])
  })

  it('resolves v/vt/vn slots and negative relative indices', () => {
    const obj = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'vn 0 0 1', 'f 1/1/1 2/1/1 -1/1/1'].join('\n')
    const mesh = parseObj(obj)
    expect(mesh.triangles).toBe(1)
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2])
  })

  it('ignores comments and non-geometry lines', () => {
    const obj = ['# a comment', 'o part', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'usemtl steel', 'f 1 2 3'].join('\n')
    expect(parseObj(obj).triangles).toBe(1)
  })

  it('refuses face indices that resolve to nothing declared', () => {
    expect(() => parseObj('v 0 0 0\nf 1 2 3\n')).toThrowError(expect.objectContaining({ code: 'CAD_FACE_INDEX_INVALID' }))
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 0\n')).toThrowError(expect.objectContaining({ code: 'CAD_FACE_INDEX_INVALID' }))
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 x\n')).toThrowError(expect.objectContaining({ code: 'CAD_FACE_INDEX_INVALID' }))
  })

  it('refuses a non-finite vertex coordinate', () => {
    expect(() => parseObj('v 0 0 abc\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')).toThrowError(expect.objectContaining({ code: 'CAD_MALFORMED_GEOMETRY' }))
  })
})

describe('STEP triangulation with an injected converter (issue 115)', () => {
  const fakeOcct = (content: OcctStepContent | null): OcctModule => ({
    ReadStepFile: () => content
  })

  it('merges per-part meshes into one offset index space', async () => {
    const content: OcctStepContent = {
      meshes: [
        { attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } },
        { attributes: { position: { array: [5, 5, 5, 6, 5, 5, 5, 6, 5] } }, index: { array: [0, 2, 1] } }
      ]
    }
    const result = await stepToMesh(Buffer.alloc(0), () => Promise.resolve(fakeOcct(content)))
    expect(result).toMatchObject({ success: true, meshCount: 2, vertexCount: 6 })
    if (result.success) {
      expect(Array.from(result.indices)).toEqual([0, 1, 2, 3, 5, 4])
      expect(result.positions.slice(9, 12)).toEqual([5, 5, 5])
    }
  })

  it('reports the converter failure instead of inventing geometry', async () => {
    const result = await stepToMesh(Buffer.alloc(0), () => Promise.resolve(fakeOcct({ success: false, error: 'bad AP' })))
    expect(result).toEqual({ success: false, error: 'bad AP' })
    expect(await stepToMesh(Buffer.alloc(0), () => Promise.resolve(fakeOcct(null))))
      .toEqual({ success: false, error: 'STEP 解析失败（可能是 ASCII/AP 版本不支持或文件损坏）' })
  })

  it('refuses content with no displayable meshes and converter crashes alike', async () => {
    expect(await stepToMesh(Buffer.alloc(0), () => Promise.resolve(fakeOcct({ meshes: [] }))))
      .toEqual({ success: false, error: 'STEP 中未解析出可显示的几何' })
    expect(await stepToMesh(Buffer.alloc(0), () => Promise.resolve(fakeOcct({
      meshes: [{ attributes: { position: { array: [] } }, index: { array: [] } }]
    })))).toEqual({ success: false, error: 'STEP 三角化后无有效网格' })
    expect(await stepToMesh(Buffer.alloc(0), () => Promise.reject(new Error('wasm crashed'))))
      .toEqual({ success: false, error: 'wasm crashed' })
  })
})

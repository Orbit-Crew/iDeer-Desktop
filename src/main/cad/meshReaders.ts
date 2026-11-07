// Issue 115: the CAD viewer's local STL/OBJ mesh readers. Both are pure
// functions over bytes the trusted main process has already read — no paths,
// no I/O, no capability beyond geometry. They return triangle soup plus
// sequential indices, the same {positions, indices} shape the STEP converter
// produces, so the pane renders one geometry form regardless of format. The
// readers never degrade silently: a malformed vertex, an unresolvable face
// index or an unreadable binary layout is an explicit error, and an empty
// geometry comes back as zero triangles for the caller's cap checks to
// reject honestly.

/** One parsed mesh: flat xyz vertices, one triangle list, honest size facts. */
export interface ParsedMesh {
  positions: Float32Array
  indices: Uint32Array
  vertices: number
  triangles: number
}

/** Stable codes the pane maps to one honest Chinese sentence each. */
export type CadParseErrorCode =
  | 'CAD_MALFORMED_GEOMETRY'
  | 'CAD_FACE_INDEX_INVALID'

export class CadParseError extends Error {
  constructor(code: CadParseErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'CadParseError'
    this.code = code
  }
  code!: CadParseErrorCode
}

const FLOAT = /[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/

function readFloat(token: string, what: string): number {
  if (!FLOAT.test(token)) throw new CadParseError('CAD_MALFORMED_GEOMETRY', `${what}不是数值：${token}`)
  const value = Number(token)
  if (!Number.isFinite(value)) throw new CadParseError('CAD_MALFORMED_GEOMETRY', `${what}越界：${token}`)
  return value
}

function readBinaryFloat(view: DataView, offset: number, what: string): number {
  const value = view.getFloat32(offset, true)
  if (!Number.isFinite(value)) throw new CadParseError('CAD_MALFORMED_GEOMETRY', `${what}不是有效坐标`)
  return value
}

/**
 * Triangle count declared in a binary STL's 84-byte header, returned only
 * when the file size matches the format's own arithmetic (80-byte header,
 * uint32 count, exactly 50 bytes per triangle). Anything else — ASCII,
 * truncated, decorated — is `null`, and the full parser decides honestly.
 */
export function binaryStlCountFromHeader(header: Buffer, fileSize: number): number | null {
  if (header.length < 84 || fileSize < 84) return null
  const count = header.readUInt32LE(80)
  return 84 + 50 * count === fileSize ? count : null
}

/**
 * Binary layout check per the format's own definition: an 80-byte header,
 * one uint32 triangle count, then exactly 50 bytes per triangle. When the
 * size does not match that arithmetic the bytes are not a binary STL and the
 * ASCII reader gets its turn — an unmatched binary-looking file fails the
 * ASCII parse loudly instead of rendering invented triangles.
 */
export function isBinaryStl(buffer: Buffer): boolean {
  return binaryStlCountFromHeader(buffer.subarray(0, Math.min(84, buffer.length)), buffer.length) !== null
}

/** STL (binary or ASCII) to triangle soup. Per-facet normals are discarded;
 * the renderer recomputes normals from the soup it is given. */
export function parseStl(buffer: Buffer): ParsedMesh {
  return isBinaryStl(buffer) ? parseBinaryStl(buffer) : parseAsciiStl(buffer)
}

function parseBinaryStl(buffer: Buffer): ParsedMesh {
  const count = buffer.readUInt32LE(80)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const positions = new Float32Array(count * 9)
  let written = 0
  for (let t = 0; t < count; t += 1) {
    // 12 floats per record: one facet normal (discarded) plus three vertices.
    const base = 84 + 50 * t + 12
    for (let v = 0; v < 9; v += 1) {
      positions[written] = readBinaryFloat(view, base + v * 4, `三角面 ${t + 1} 顶点`)
      written += 1
    }
  }
  const triangles = count
  return {
    positions,
    indices: sequentialIndices(triangles * 3),
    vertices: triangles * 3,
    triangles
  }
}

function parseAsciiStl(buffer: Buffer): ParsedMesh {
  const text = stripBom(buffer.toString('utf8'))
  const positions: number[] = []
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts[0]?.toLowerCase() !== 'vertex') continue
    if (parts.length < 4) throw new CadParseError('CAD_MALFORMED_GEOMETRY', `vertex 行缺少坐标：${line.trim()}`)
    positions.push(
      readFloat(parts[1], 'vertex x'),
      readFloat(parts[2], 'vertex y'),
      readFloat(parts[3], 'vertex z')
    )
  }
  const triangles = Math.floor(positions.length / 9)
  if (positions.length % 9 !== 0) {
    // An incomplete trailing vertex is corruption, not a smaller model —
    // refuse it instead of silently displaying a truncated shape.
    throw new CadParseError('CAD_MALFORMED_GEOMETRY', `vertex 坐标不完整（${positions.length % 9} 个多余分量）`)
  }
  return {
    positions: Float32Array.from(positions),
    indices: sequentialIndices(triangles * 3),
    vertices: triangles * 3,
    triangles
  }
}

/**
 * OBJ to a triangulated mesh: `v` lines carry geometry, `f` statements are
 * fan-triangulated (a quad becomes two triangles, matching the original
 * viewer's polygon handling). Face entries may carry texture/normal slots
 * (`v/vt/vn`), 1-based indices and negative relative indices; anything that
 * does not resolve to a declared vertex is an explicit error, never a skip.
 */
export function parseObj(text: string): ParsedMesh {
  const clean = stripBom(text)
  const positions: number[] = []
  const indices: number[] = []
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts[0] === 'v') {
      if (parts.length < 4) throw new CadParseError('CAD_MALFORMED_GEOMETRY', `v 行缺少坐标：${line}`)
      positions.push(
        readFloat(parts[1], '顶点 x'),
        readFloat(parts[2], '顶点 y'),
        readFloat(parts[3], '顶点 z')
      )
    } else if (parts[0] === 'f') {
      if (parts.length < 4) throw new CadParseError('CAD_MALFORMED_GEOMETRY', `f 行少于三个顶点：${line}`)
      const face = parts.slice(1).map((slot) => resolveObjVertex(slot, positions.length / 3))
      // Fan triangulation over the polygon's declared winding.
      for (let i = 1; i + 1 < face.length; i += 1) {
        indices.push(face[0], face[i], face[i + 1])
      }
    }
  }
  const vertexCount = Math.floor(positions.length / 3)
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    vertices: vertexCount,
    triangles: indices.length / 3
  }
}

function resolveObjVertex(slot: string, declared: number): number {
  const head = slot.split('/')[0]
  const parsed = Number.parseInt(head, 10)
  if (!Number.isInteger(parsed) || parsed === 0) {
    throw new CadParseError('CAD_FACE_INDEX_INVALID', `无法解析面索引：${slot}`)
  }
  // OBJ indices are 1-based; negative values count back from the current vertex.
  const index = parsed > 0 ? parsed - 1 : declared + parsed
  if (index < 0 || index >= declared) {
    throw new CadParseError('CAD_FACE_INDEX_INVALID', `面索引越出已声明顶点：${slot}`)
  }
  return index
}

function sequentialIndices(length: number): Uint32Array {
  const indices = new Uint32Array(length)
  for (let i = 0; i < length; i += 1) indices[i] = i
  return indices
}

function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}

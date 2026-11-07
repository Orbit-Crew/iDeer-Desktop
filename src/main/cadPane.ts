// Issue 115: the CAD viewer's read service. One invoke action — read a
// workspace-logical model file and return one bounded mesh payload. The
// workspace containment is the Runtime's own guarded `locate` resolution
// (the same gate the file pane browses through); the physical path and the
// file bytes stay here in the trusted process. The honest caps are enforced
// before anything renders: a file over the size limit or a mesh over the
// software-render triangle budget is refused with a stable code (a binary
// STL's count is checked from its 84-byte header before the body is even
// read), an empty geometry is named as such, and the supported format subset
// (STL/OBJ/STP/STEP — the original viewer's real formats) is the whitelist.
// Geometry editing does not exist on this channel.
import { closeSync, openSync, readSync, statSync, readFileSync } from 'node:fs'
import { CAD_MAX_FILE_BYTES, CAD_MAX_TRIANGLES, type CadMeshFormat, type CadMeshStats, type CadMeshView } from '../shared/desktop'
import { binaryStlCountFromHeader, CadParseError, parseObj, parseStl } from './cad/meshReaders'
import { stepToMesh, type OcctLoader } from './cad/stepToMesh'

const CAD_EXTENSIONS: Record<string, CadMeshFormat> = {
  '.stl': 'stl',
  '.obj': 'obj',
  '.stp': 'step',
  '.step': 'step'
}

/** The workspace locate seam — the Runtime's own guarded resolution. */
export type CadLocate = (path: string) => Promise<{ physical: string }>

export interface CadPaneOptions {
  locate: CadLocate
  loadOcct: OcctLoader
  maxFileBytes?: number
  maxTriangles?: number
}

export class CadPaneService {
  private readonly locate: CadLocate
  private readonly loadOcct: OcctLoader
  private readonly maxFileBytes: number
  private readonly maxTriangles: number

  constructor(options: CadPaneOptions) {
    this.locate = options.locate
    this.loadOcct = options.loadOcct
    this.maxFileBytes = options.maxFileBytes ?? CAD_MAX_FILE_BYTES
    this.maxTriangles = options.maxTriangles ?? CAD_MAX_TRIANGLES
  }

  async readMesh(path: string): Promise<CadMeshView> {
    const format = this.formatOf(path)
    if (!format) throw new Error('CAD_FORMAT_UNSUPPORTED')
    const physical = (await this.locate(path)).physical

    let size: number
    try {
      const stat = statSync(physical)
      if (!stat.isFile()) throw new Error('CAD_NOT_A_FILE')
      size = stat.size
    } catch (error) {
      if (error instanceof Error && error.message === 'CAD_NOT_A_FILE') throw error
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error('CAD_NOT_FOUND')
      throw new Error('CAD_READ_FAILED')
    }
    if (size > this.maxFileBytes) throw new Error('CAD_FILE_TOO_LARGE')

    if (format === 'stl') {
      // A binary STL declares its triangle count in the first 84 bytes — an
      // over-budget model is refused before its body is read at all.
      const count = this.readBinaryStlCount(physical, size)
      if (count !== null && count > this.maxTriangles) throw new Error('CAD_MESH_TOO_LARGE')
    }

    const mesh = format === 'step'
      ? await this.readStep(physical)
      : this.readLocal(physical, format)
    if (mesh.triangles === 0) throw new Error('CAD_EMPTY_GEOMETRY')
    if (mesh.triangles > this.maxTriangles) throw new Error('CAD_MESH_TOO_LARGE')
    return {
      format,
      positions: mesh.positions,
      indices: mesh.indices,
      stats: {
        meshes: mesh.meshes,
        vertices: Math.floor(mesh.positions.length / 3),
        triangles: mesh.triangles
      } satisfies CadMeshStats
    }
  }

  /** Reads exactly the 84-byte STL header and returns the declared triangle
   * count only when the file size matches the binary layout's arithmetic;
   * anything else (ASCII, truncated, decorated) is the parser's call later. */
  private readBinaryStlCount(physical: string, size: number): number | null {
    const fd = openSync(physical, 'r')
    try {
      const header = Buffer.alloc(Math.min(84, size))
      readSync(fd, header, 0, header.length, 0)
      return binaryStlCountFromHeader(header, size)
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  /** The extension → format whitelist: the original viewer's real formats,
   * nothing more — an unknown suffix is refused by code, never guessed. */
  private formatOf(path: string): CadMeshFormat | null {
    if (typeof path !== 'string' || path.length === 0) return null
    const dot = path.lastIndexOf('.')
    if (dot < 0) return null
    return CAD_EXTENSIONS[path.slice(dot).toLowerCase()] ?? null
  }

  private async readStep(physical: string): Promise<{ positions: Float32Array; indices: Uint32Array; meshes: number; triangles: number }> {
    let buffer: Buffer
    try {
      buffer = readFileSync(physical)
    } catch {
      throw new Error('CAD_READ_FAILED')
    }
    const result = await stepToMesh(buffer, this.loadOcct)
    if (!result.success) {
      if (result.reason === 'engine-unavailable') throw new Error('CAD_OCCT_UNAVAILABLE')
      throw new Error(`CAD_STEP_PARSE_FAILED: ${result.error}`)
    }
    return {
      positions: Float32Array.from(result.positions),
      indices: Uint32Array.from(result.indices),
      meshes: result.meshCount,
      triangles: result.indices.length / 3
    }
  }

  private readLocal(physical: string, format: CadMeshFormat): { positions: Float32Array; indices: Uint32Array; meshes: number; triangles: number } {
    let parsed: ReturnType<typeof parseStl> | ReturnType<typeof parseObj>
    try {
      if (format === 'stl') parsed = parseStl(readFileSync(physical))
      else parsed = parseObj(readFileSync(physical, 'utf8'))
    } catch (error) {
      if (error instanceof CadParseError) throw error
      throw new Error('CAD_READ_FAILED')
    }
    return {
      positions: parsed.positions,
      indices: parsed.indices,
      meshes: 1,
      triangles: parsed.triangles
    }
  }
}

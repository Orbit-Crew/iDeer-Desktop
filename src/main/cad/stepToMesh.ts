// Issue 115: STEP → mesh triangulation through the OpenCASCADE WASM converter
// (occt-import-js), ported from the original linz viewer's step pipeline. The
// module factory and its .wasm sibling ship outside the asar as extraResources
// (pinned in resources/provenance/linz-source.json), the directory candidates
// are computed by the trusted main wiring (electron-free here so tests can
// inject a fake module), and every failure — missing engine, unsupported
// ASCII/AP variant, no displayable geometry — is an explicit result, never a
// silent empty mesh.
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface OcctMesh {
  attributes?: { position?: { array: ArrayLike<number> } }
  index?: { array: ArrayLike<number> }
}

export interface OcctStepContent {
  success?: boolean
  error?: string
  meshes?: OcctMesh[]
}

export interface OcctModule {
  ReadStepFile(buffer: Buffer, params: unknown): OcctStepContent | null
}

export type OcctLoader = () => Promise<OcctModule>

export interface StepMeshData {
  success: true
  positions: number[]
  indices: number[]
  meshCount: number
  vertexCount: number
}

/** Why a conversion failed: the engine never loaded (its own honest code
 * downstream) or the STEP content itself could not be triangulated. */
export type StepFailureReason = 'engine-unavailable' | 'parse-failed'

export type StepMeshResult =
  | StepMeshData
  | { success: false; reason: StepFailureReason; error: string }

export class OcctLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OcctLoadError'
  }
}

/**
 * Resolve the occt-import-js directory from the wiring's candidates: the glue
 * .js and its .wasm sibling must sit together, and the packaged layout puts
 * them under resources/occt (outside the asar, readable with fs).
 */
export function resolveOcctDir(candidates: string[]): string {
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'occt-import-js.js')) &&
          fs.existsSync(path.join(dir, 'occt-import-js.wasm'))) return dir
    } catch {
      // 忽略：下一个候选
    }
  }
  throw new OcctLoadError('未找到 occt-import-js（OpenCASCADE WASM 转换引擎未随包）')
}

/**
 * Load the converter once per resolved directory (the loader caches its own
 * module; wiring decides the candidate list). The glue reads its .wasm
 * sibling through `locateFile`, keeping both files in the same directory.
 */
export async function loadOcctFromDirs(candidates: string[]): Promise<OcctModule> {
  const dir = resolveOcctDir(candidates)
  const gluePath = path.join(dir, 'occt-import-js.js')
  try {
    // The glue is a plain script factory outside the bundle graph; a runtime
    // require keeps the WASM out of the build and inside the pinned resource.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const makeModule = require(gluePath) as (options?: { locateFile?: (p: string) => string }) => Promise<OcctModule>
    return await makeModule({ locateFile: (p: string) => path.join(dir, p) })
  } catch (error) {
    throw new OcctLoadError(`OpenCASCADE WASM 加载失败: ${error instanceof Error ? error.message : String(error)}（路径 ${dir}）`)
  }
}

/**
 * STEP triangulation: read the file buffer, return an IPC-safe merged mesh
 * (per-part vertex arrays offset into one index space, normals dropped).
 */
export async function stepToMesh(buffer: Buffer, loader: OcctLoader): Promise<StepMeshResult> {
  let occt: OcctModule
  try {
    occt = await loader()
  } catch (error) {
    return {
      success: false,
      reason: 'engine-unavailable',
      error: error instanceof Error ? error.message : String(error)
    }
  }

  try {
    const content = occt.ReadStepFile(buffer, null)
    if (!content || content.success === false) {
      return {
        success: false,
        reason: 'parse-failed',
        error: content?.error || 'STEP 解析失败（可能是 ASCII/AP 版本不支持或文件损坏）'
      }
    }
    if (!Array.isArray(content.meshes) || content.meshes.length === 0) {
      return { success: false, reason: 'parse-failed', error: 'STEP 中未解析出可显示的几何' }
    }

    // Merge every part's vertices/indices (each part indexes from 0 — offset).
    const positions: number[] = []
    const indices: number[] = []
    let vertexCount = 0
    let meshCount = 0
    for (const mesh of content.meshes) {
      if (!mesh || !mesh.attributes || !mesh.attributes.position || !mesh.index) continue
      const pos = mesh.attributes.position.array
      const idx = mesh.index.array
      if (pos.length < 3 || idx.length < 3) continue
      const base = vertexCount
      for (let i = 0; i < pos.length; i += 1) positions.push(pos[i])
      for (let i = 0; i < idx.length; i += 1) indices.push(base + idx[i])
      vertexCount += pos.length / 3
      meshCount += 1
    }
    if (positions.length === 0 || indices.length === 0) {
      return { success: false, reason: 'parse-failed', error: 'STEP 三角化后无有效网格' }
    }
    return { success: true, positions, indices, meshCount, vertexCount }
  } catch (error) {
    return {
      success: false,
      reason: 'parse-failed',
      error: `STEP 转换失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

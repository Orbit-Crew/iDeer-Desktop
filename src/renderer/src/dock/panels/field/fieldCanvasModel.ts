// Issue 116: the field pane's software canvas paint model — the pure math
// the canvas component draws, reproduced from the original linz vtk.js panel
// without vtk.js. The display semantics are the original's actually-supported
// ones: the surface/wireframe layer is exactly the I×J (k=0) quad plane its
// buildStructuredPolydata built, points mode covers every N = I*J*K point,
// and the color transfer is its blue→gray→red 3-point ramp. Orthographic
// projection, painter's-algorithm depth sort and headlight shading are the
// pane's own software 2D engine — no WebGL, no embedded content, no bridge
// surface. The same idiom is used by the CAD viewer under review in #151.
import type { TecplotZone } from './tecplotReader'

/** 原版语义：坐标 (x,y,z) 之后的变量才是标量着色候选。 */
export function scalarVariablesOf(variables: string[]): string[] {
  return variables.slice(3)
}

export type FieldRepresentation = 'surface' | 'wireframe' | 'points'

export interface FieldCam { yaw: number; pitch: number; zoom: number }

export interface FieldGeometry {
  dims: [number, number, number]
  /** N*3，按点序交错（x,y,z 取前三个变量的位置数据，与原版一致） */
  xyz: Float32Array
  /** N，活动标量变量的值 */
  values: Float32Array
  valueName: string
  /** k=0 层 quad 索引（原版 buildStructuredPolydata 的唯一面层） */
  quadIndices: Uint32Array
  /** 活动变量的有限值范围 */
  range: [number, number]
  nonFiniteActive: number
  /** (I-1)*(J-1)：I>1 且 J>1 时才非零 */
  layerQuadCount: number
}

export type FieldGeometryError = 'NO_COORDINATES' | 'VAR_NOT_FOUND'

/** 原版仅在前三个变量名里含 x/y/z 时作图，否则如实报错不画。 */
export function buildFieldGeometry(
  zone: TecplotZone, variables: string[], varName: string
): FieldGeometry | { error: FieldGeometryError } {
  if (variables.length < 3) return { error: 'NO_COORDINATES' }
  const first3 = variables.slice(0, 3).map((v) => v.toLowerCase())
  if (!['x', 'y', 'z'].every((c) => first3.includes(c))) return { error: 'NO_COORDINATES' }
  if (!scalarVariablesOf(variables).includes(varName)) return { error: 'VAR_NOT_FOUND' }

  const [I, J, K] = zone.dims
  const N = I * J * K
  const xyz = new Float32Array(N * 3)
  for (let n = 0; n < N; n += 1) {
    xyz[n * 3] = zone.data[0][n]
    xyz[n * 3 + 1] = zone.data[1][n]
    xyz[n * 3 + 2] = zone.data[2][n]
  }
  const column = zone.data[variables.indexOf(varName)]
  const values = Float32Array.from(column)

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let nonFiniteActive = 0
  for (const v of values) {
    if (Number.isFinite(v)) {
      if (v < min) min = v
      if (v > max) max = v
    } else {
      nonFiniteActive += 1
    }
  }
  if (!Number.isFinite(min)) {
    min = 0
    max = 0
  }

  // 原版只在 I>1 且 J>1 时给 k=0 层建 quad（buildStructuredPolydata）。
  const quadCount = I > 1 && J > 1 ? (I - 1) * (J - 1) : 0
  const quadIndices = new Uint32Array(quadCount * 4)
  let q = 0
  if (quadCount > 0) {
    for (let j = 0; j < J - 1; j += 1) {
      for (let i = 0; i < I - 1; i += 1) {
        const a = j * I + i
        quadIndices[q] = a
        quadIndices[q + 1] = a + 1
        quadIndices[q + 2] = (j + 1) * I + i + 1
        quadIndices[q + 3] = (j + 1) * I + i
        q += 4
      }
    }
  }

  return {
    dims: [I, J, K], xyz, values, valueName: varName, quadIndices,
    range: [min, max], nonFiniteActive, layerQuadCount: quadCount
  }
}

/** 实体/线框的渲染上限：超限时如实拒绝该表示法（点云仍可用），不静默降采样。 */
export const MAX_RENDER_QUADS = 524_288
/** 点云的渲染上限：每帧逐点绘制，超限如实拒绝（实体/线框仍可用）。 */
export const MAX_RENDER_POINTS = 262_144

/** 原版 makeColorTransfer 的三点色带：蓝 → 中点灰 → 红。 */
const STOPS = [
  { t: 0, rgb: [0.23, 0.3, 0.75] },
  { t: 0.5, rgb: [0.87, 0.87, 0.87] },
  { t: 1, rgb: [0.83, 0.14, 0.14] }
] as const

export function scalarColor(t: number): [number, number, number] {
  if (!Number.isFinite(t)) t = 0.5
  const clamped = Math.max(0, Math.min(1, t))
  for (let s = 0; s < STOPS.length - 1; s += 1) {
    const a = STOPS[s]
    const b = STOPS[s + 1]
    if (clamped <= b.t) {
      const f = (clamped - a.t) / (b.t - a.t)
      return [
        Math.round((a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f) * 255),
        Math.round((a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f) * 255),
        Math.round((a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f) * 255)
      ]
    }
  }
  return [212, 36, 36]
}

const colorString = (rgb: [number, number, number]): string => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`

/** 色标条的唯一渐变来源：与 STOPS 同源，改色带不会漂移出第二份。 */
export function scalarBarGradient(): string {
  const [a, b, c] = STOPS.map((s) => colorString(scalarColor(s.t)))
  return `linear-gradient(to bottom, ${a}, ${b}, ${c})`
}

export interface FieldView {
  width: number
  height: number
}

export interface FieldQuad {
  pts: number[][]
  /** 色带取色（quad 四点均值的 t），未着色 —— 供显示契约检验 */
  baseColor: string
  /** 头灯着色后的填充色 */
  color: string
  depth: number
}

export interface FieldSegment {
  /** 线段两端（原版按点标量着色的线框近似：每边以起点值取色） */
  pts: number[][]
  color: string
}

export interface FieldPoint {
  x: number
  y: number
  color: string
}

export interface FieldPrimitives {
  quads: FieldQuad[]
  segments: FieldSegment[]
  points: FieldPoint[]
  /** 实体/线框层超渲染面上限 */
  overCap: boolean
  /** 点云超渲染点上限 */
  overCapPoints: boolean
}

interface Projection {
  sx: Float64Array
  sy: Float64Array
  vz: Float64Array
}

function project(xyz: Float32Array, view: FieldView, cam: FieldCam): Projection {
  const n = Math.floor(xyz.length / 3)
  const sx = new Float64Array(n)
  const sy = new Float64Array(n)
  const vz = new Float64Array(n)
  if (n === 0) return { sx, sy, vz }
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i += 1) {
    cx += xyz[i * 3]
    cy += xyz[i * 3 + 1]
    cz += xyz[i * 3 + 2]
  }
  cx /= n
  cy /= n
  cz /= n
  let rad = 0
  for (let i = 0; i < n; i += 1) {
    const dx = xyz[i * 3] - cx
    const dy = xyz[i * 3 + 1] - cy
    const dz = xyz[i * 3 + 2] - cz
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d > rad) rad = d
  }
  if (rad <= 0) rad = 1
  const scale = ((Math.min(view.width, view.height) / 2) / rad) * cam.zoom
  const cya = Math.cos(cam.yaw)
  const sya = Math.sin(cam.yaw)
  const cpi = Math.cos(cam.pitch)
  const spi = Math.sin(cam.pitch)
  for (let i = 0; i < n; i += 1) {
    const x = xyz[i * 3] - cx
    const y = xyz[i * 3 + 1] - cy
    const z = xyz[i * 3 + 2] - cz
    const x1 = x * cya + z * sya
    const z1 = -x * sya + z * cya
    const y2 = y * cpi - z1 * spi
    const z2 = y * spi + z1 * cpi
    vz[i] = z2
    sx[i] = view.width / 2 + x1 * scale
    sy[i] = view.height / 2 - y2 * scale
  }
  return { sx, sy, vz }
}

/** 归一化标量到色带 t；非有限值与空范围都落在中点灰（由调用方如实提示）。 */
function scalarT(value: number, range: [number, number]): number {
  const [min, max] = range
  if (!Number.isFinite(value) || max <= min) return 0.5
  return (value - min) / (max - min)
}

export function composeFieldPrimitives(
  geom: FieldGeometry, cam: FieldCam, view: FieldView, rep: FieldRepresentation
): FieldPrimitives {
  const empty: FieldPrimitives = { quads: [], segments: [], points: [], overCap: false, overCapPoints: false }
  // 上限先于一切检查：超限的拒绝不依赖数据是否在场景里。
  if (geom.layerQuadCount > MAX_RENDER_QUADS) {
    return { ...empty, overCap: true }
  }
  const n = Math.floor(geom.xyz.length / 3)
  if (rep === 'points' && n > MAX_RENDER_POINTS) {
    return { ...empty, overCapPoints: true }
  }
  if (n === 0) return empty
  const projection = project(geom.xyz, view, cam)

  if (rep === 'points') {
    const points: FieldPoint[] = []
    for (let i = 0; i < n; i += 1) {
      points.push({
        x: projection.sx[i], y: projection.sy[i],
        color: colorString(scalarColor(scalarT(geom.values[i], geom.range)))
      })
    }
    return { ...empty, points }
  }

  const quadCount = Math.floor(geom.quadIndices.length / 4)
  if (rep === 'wireframe') {
    // 原版线框按点标量着色；每边以起点值取色是同一语义的逐边近似。
    const segments: FieldSegment[] = []
    for (let q = 0; q < quadCount; q += 1) {
      for (let k = 0; k < 4; k += 1) {
        const start = geom.quadIndices[q * 4 + k]
        const end = geom.quadIndices[q * 4 + (k + 1) % 4]
        segments.push({
          pts: [
            [projection.sx[start], projection.sy[start]],
            [projection.sx[end], projection.sy[end]]
          ],
          color: colorString(scalarColor(scalarT(geom.values[start], geom.range)))
        })
      }
    }
    return { ...empty, segments }
  }

  // surface：画家算法，按视图深度从远到近；屏幕空间法线 + 头灯着色
  //（与 CAD 软件引擎同一惯用法），标量色按 quad 四点均值取色。
  const quads: FieldQuad[] = []
  for (let q = 0; q < quadCount; q += 1) {
    const ids = [
      geom.quadIndices[q * 4], geom.quadIndices[q * 4 + 1],
      geom.quadIndices[q * 4 + 2], geom.quadIndices[q * 4 + 3]
    ]
    const e1sx = projection.sx[ids[1]] - projection.sx[ids[0]]
    const e1sy = projection.sy[ids[1]] - projection.sy[ids[0]]
    const e2sx = projection.sx[ids[3]] - projection.sx[ids[0]]
    const e2sy = projection.sy[ids[3]] - projection.sy[ids[0]]
    const facing = e1sx * e2sy - e1sy * e2sx
    const screenNx = -e1sy
    const screenNy = e1sx
    const nl = Math.sqrt(screenNx * screenNx + screenNy * screenNy) || 1
    let shade = 0.35 + 0.35 * (screenNx / nl) * 0.5 + 0.3 * (screenNy / nl) * 0.66
    shade = Math.max(0.2, Math.min(0.92, shade))
    const base = scalarColor(scalarT(
      (geom.values[ids[0]] + geom.values[ids[1]] + geom.values[ids[2]] + geom.values[ids[3]]) / 4,
      geom.range
    ))
    const dim = facing < 0 ? 0.55 : 1
    quads.push({
      pts: ids.map((idx) => [projection.sx[idx], projection.sy[idx]]),
      baseColor: colorString(base),
      color: colorString([
        Math.round(base[0] * shade * dim),
        Math.round(base[1] * shade * dim),
        Math.round(base[2] * shade * dim)
      ]),
      depth: (projection.vz[ids[0]] + projection.vz[ids[1]] +
        projection.vz[ids[2]] + projection.vz[ids[3]]) / 4
    })
  }
  quads.sort((p, r) => r.depth - p.depth)
  return { ...empty, quads }
}

/** 色标/悬停数值的诚实文本：常规值直写，量级极端用指数，非有限值明说。 */
export function formatScalar(v: number): string {
  if (!Number.isFinite(v)) return '非有限值'
  if (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0)) {
    return v.toExponential(3)
  }
  return String(Number(v.toPrecision(6)))
}

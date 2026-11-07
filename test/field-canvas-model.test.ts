// Issue 116: the field pane's software canvas paint model. These tests pin
// the geometry semantics reproduced from the original linz vtk.js panel:
// the surface/wireframe layer is exactly the I×J (k=0) plane the original's
// buildStructuredPolydata built, points mode shows every N = I*J*K point,
// the color transfer is the original's blue→gray→red, and non-finite values
// render as the midpoint color while being counted — never silently mixed
// into the range.
import { describe, expect, it } from 'vitest'
import {
  buildFieldGeometry, composeFieldPrimitives, scalarColor, formatScalar,
  scalarBarGradient, MAX_RENDER_POINTS, MAX_RENDER_QUADS
} from '../src/renderer/src/dock/panels/field/fieldCanvasModel'
import { parseTecplotAscii } from '../src/renderer/src/dock/panels/field/tecplotReader'

const colorString = (rgb: [number, number, number]): string =>
  `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`

function zoneFrom(lines: string[]) {
  const parsed = parseTecplotAscii(lines.join('\n'))
  expect(parsed.zones).toHaveLength(1)
  return { zone: parsed.zones[0], variables: parsed.variables }
}

const pointZone = zoneFrom([
  'VARIABLES = "x" "y" "z" "p"',
  'ZONE T="slice" I=2 J=2 K=1 F=POINT',
  '0 0 0 1',
  '1 0 0 2',
  '0 1 0 3',
  '1 1 0 4'
])

describe('field canvas geometry (#116)', () => {
  it('builds positions positionally from the first three variables and values from the active one', () => {
    const geom = buildFieldGeometry(pointZone.zone, pointZone.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    expect(geom.dims).toEqual([2, 2, 1])
    expect(geom.xyz).toEqual(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]))
    expect(geom.values).toEqual(Float32Array.from([1, 2, 3, 4]))
    expect(geom.valueName).toBe('p')
    expect(geom.range).toEqual([1, 4])
    expect(geom.nonFiniteActive).toBe(0)
    expect(geom.layerQuadCount).toBe(1)
  })

  it('builds exactly the I×J (k=0) quads the original surface layer drew', () => {
    const geom = buildFieldGeometry(pointZone.zone, pointZone.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    // I=2,J=2 → 1 个 quad：a=0, b=1, c=(j+1)*I+i+1=3, d=(j+1)*I+i=2
    expect(Array.from(geom.quadIndices)).toEqual([0, 1, 3, 2])
  })

  it('keeps all I*J*K points for points mode while the layer stays k=0', () => {
    const vol = zoneFrom([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=1 K=2 F=POINT',
      '0 0 0 1', '1 0 0 2', '0 0 1 3', '1 0 1 4'
    ])
    const geom = buildFieldGeometry(vol.zone, vol.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    expect(geom.values).toHaveLength(4)
    // I=2, J=1 → 无 k=0 层 quad（I>1 且 J>1 才有），点云仍覆盖全部点
    expect(geom.quadIndices).toHaveLength(0)
  })

  it('refuses zones without x/y/z coordinate names and unknown variables honestly', () => {
    const bad = zoneFrom([
      'VARIABLES = "a" "b" "c" "p"',
      'ZONE I=2 J=1 K=1 F=POINT', '0 0 1 1', '0 0 1 1'
    ])
    expect(buildFieldGeometry(bad.zone, bad.variables, 'p')).toEqual({ error: 'NO_COORDINATES' })
    expect(buildFieldGeometry(pointZone.zone, pointZone.variables, 'nope')).toEqual({ error: 'VAR_NOT_FOUND' })
  })

  it('counts non-finite values in the active variable instead of faking the range', () => {
    const inf = zoneFrom([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=1 K=1 F=POINT', '0 0 0 1e999', '1 0 0 2'
    ])
    const geom = buildFieldGeometry(inf.zone, inf.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    expect(geom.nonFiniteActive).toBe(1)
    expect(geom.range).toEqual([2, 2])
  })
})

describe('field canvas color transfer (#116)', () => {
  it('reproduces the original blue→gray→red transfer', () => {
    expect(scalarColor(0)).toEqual([59, 77, 191])
    expect(scalarColor(0.5)).toEqual([222, 222, 222])
    expect(scalarColor(1)).toEqual([212, 36, 36])
  })

  it('clamps t and maps non-finite input to the midpoint color', () => {
    expect(scalarColor(-1)).toEqual(scalarColor(0))
    expect(scalarColor(2)).toEqual(scalarColor(1))
    expect(scalarColor(Number.NaN)).toEqual(scalarColor(0.5))
  })
})

describe('field canvas primitives (#116)', () => {
  const cam = { yaw: 0, pitch: 0, zoom: 1 }
  const view = { width: 200, height: 100 }

  it('composes depth-sorted scalar-colored quads for surface mode', () => {
    const geom = buildFieldGeometry(pointZone.zone, pointZone.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    const prim = composeFieldPrimitives(geom, cam, view, 'surface')
    expect(prim.quads).toHaveLength(1)
    const quad = prim.quads[0]
    expect(quad.pts).toHaveLength(4)
    // t = (1+2+3+4)/4 → 0.5 中点灰；color 是头灯着色后的填充色
    expect(quad.baseColor).toBe('rgb(222,222,222)')
    expect(quad.color).toMatch(/^rgb\(\d+,\d+,\d+\)$/)
    expect(prim.points).toHaveLength(0)
    expect(prim.segments).toHaveLength(0)
  })

  it('sorts quads back-to-front by view depth', () => {
    const two = zoneFrom([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=3 K=1 F=POINT',
      '0 0 0 1', '1 0 0 1',
      '0 1 0 3', '1 1 0 3',
      '0 2 0 3', '1 2 0 3'
    ])
    const geom = buildFieldGeometry(two.zone, two.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    // pitch>0：y 越大越远（vz 越大）。远排 quad（j=1，均值 p=3 → t=1 红）先画，
    // 近排 quad（j=0，均值 p=2 → t=0.5 灰）后画。
    const prim = composeFieldPrimitives(geom, { yaw: 0, pitch: 0.6, zoom: 1 }, view, 'surface')
    expect(prim.quads).toHaveLength(2)
    expect(prim.quads[0].depth).toBeGreaterThan(prim.quads[1].depth)
    expect(prim.quads[0].baseColor).toBe(colorString(scalarColor(1)))
    expect(prim.quads[1].baseColor).toBe(colorString(scalarColor(0.5)))
  })

  it('composes per-edge scalar-colored strokes for wireframe mode', () => {
    const geom = buildFieldGeometry(pointZone.zone, pointZone.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    const prim = composeFieldPrimitives(geom, cam, view, 'wireframe')
    // 一个 quad 四条边，每边以起点值取色（原版按点标量着色的逐边近似）
    expect(prim.segments).toHaveLength(4)
    for (const seg of prim.segments) expect(seg.pts).toHaveLength(2)
    expect(prim.segments[0].color).toBe(colorString(scalarColor(0)))
    expect(prim.segments[2].color).toBe(colorString(scalarColor(1)))
    expect(prim.quads).toHaveLength(0)
  })

  it('marks an over-cap point cloud honestly instead of attempting the draw', () => {
    const geom = {
      dims: [2, 2, 1] as [number, number, number],
      xyz: new Float32Array((MAX_RENDER_POINTS + 1) * 3),
      values: new Float32Array(MAX_RENDER_POINTS + 1), valueName: 'p',
      quadIndices: new Uint32Array(0), range: [0, 1] as [number, number],
      nonFiniteActive: 0, layerQuadCount: 0
    }
    const prim = composeFieldPrimitives(geom, cam, view, 'points')
    expect(prim.overCapPoints).toBe(true)
    expect(prim.points).toHaveLength(0)
  })

  it('composes one colored point per grid point for points mode', () => {
    const geom = buildFieldGeometry(pointZone.zone, pointZone.variables, 'p')
    if (!('quadIndices' in geom)) throw new Error('expected geometry')
    const prim = composeFieldPrimitives(geom, cam, view, 'points')
    expect(prim.points).toHaveLength(4)
    expect(prim.points[0].color).toBe('rgb(59,77,191)')
    expect(prim.points[3].color).toBe('rgb(212,36,36)')
    expect(prim.quads).toHaveLength(0)
  })

  it('marks an over-cap layer honestly instead of attempting the draw', () => {
    const geom = {
      dims: [MAX_RENDER_QUADS + 2, 2, 1] as [number, number, number],
      xyz: new Float32Array(0), values: new Float32Array(0), valueName: 'p',
      quadIndices: new Uint32Array(0), range: [0, 1] as [number, number],
      nonFiniteActive: 0, layerQuadCount: MAX_RENDER_QUADS + 1
    }
    const prim = composeFieldPrimitives(geom, cam, view, 'surface')
    expect(prim.overCap).toBe(true)
    expect(prim.quads).toHaveLength(0)
  })
})

describe('scalar label formatting (#116)', () => {
  it('formats ordinary values plainly and extremes exponentially', () => {
    expect(formatScalar(1000)).toBe('1000')
    expect(formatScalar(0.25)).toBe('0.25')
    expect(formatScalar(1234567)).toBe('1.235e+6')
    expect(formatScalar(0.0000123)).toBe('1.230e-5')
    expect(formatScalar(Number.POSITIVE_INFINITY)).toBe('非有限值')
  })

  it('derives the scalar bar gradient from the same stops as the painter', () => {
    const gradient = scalarBarGradient()
    expect(gradient).toContain('linear-gradient(to bottom')
    expect(gradient).toContain(colorString(scalarColor(0)))
    expect(gradient).toContain(colorString(scalarColor(0.5)))
    expect(gradient).toContain(colorString(scalarColor(1)))
  })
})

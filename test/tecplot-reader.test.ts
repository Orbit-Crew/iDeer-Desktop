// Issue 116: the Tecplot results pane's reader. These tests pin the
// original's actually-supported subset — structured IJK ASCII (POINT/BLOCK),
// VARIABLES + ZONE headers, zone/variable facts — and the honesty additions
// the Desktop requires: skipped zones are counted instead of silently
// dropped, Fortran D-exponents parse to their real value, and out-of-subset
// data (FE zones, malformed headers, incomplete bodies) never renders as
// fake results.
import { describe, expect, it } from 'vitest'
import { parseTecplotAscii, MAX_ZONES } from '../src/renderer/src/dock/panels/field/tecplotReader'

const pointFile = [
  'TITLE = "demo"',
  'VARIABLES = "x" "y" "z" "p"',
  'ZONE T="slice" I=2 J=2 K=1 F=POINT',
  '0.0 0.0 0.0 1.0',
  '1.0 0.0 0.0 2.0',
  '0.0 1.0 0.0 3.0',
  '1.0 1.0 0.0 4.0'
].join('\n')

describe('tecplot structured IJK ASCII reader (#116)', () => {
  it('parses a POINT zone with the i-fastest Tecplot ordering', () => {
    const parsed = parseTecplotAscii(pointFile)
    expect(parsed.variables).toEqual(['x', 'y', 'z', 'p'])
    expect(parsed.zones).toHaveLength(1)
    expect(parsed.zonesOmitted).toBe(0)
    const zone = parsed.zones[0]
    expect(zone.name).toBe('slice')
    expect(zone.dims).toEqual([2, 2, 1])
    // n = j*I + i：i 最快变化。p = zone.data[3]。
    expect(zone.data[3]).toEqual([1, 2, 3, 4])
    expect(zone.data[0]).toEqual([0, 1, 0, 1])
    expect(zone.data[1]).toEqual([0, 0, 1, 1])
  })

  it('parses a BLOCK zone with variable-major ordering', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "p"',
      'ZONE I=2 J=2 F=BLOCK',
      '0 1 0 1',
      '0 0 1 1',
      '3 4 5 6'
    ].join('\n'))
    expect(parsed.zones).toHaveLength(1)
    const zone = parsed.zones[0]
    expect(zone.dims).toEqual([2, 2, 1])
    expect(zone.data[0]).toEqual([0, 1, 0, 1])
    expect(zone.data[1]).toEqual([0, 0, 1, 1])
    expect(zone.data[2]).toEqual([3, 4, 5, 6])
  })

  it('reads the modern DATAPACKING spelling the same as F=', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "p"',
      'ZONE I=2 J=2 DATAPACKING=BLOCK',
      '0 1 0 1',
      '0 0 1 1',
      '3 4 5 6'
    ].join('\n'))
    expect(parsed.zones).toHaveLength(1)
    expect(parsed.zones[0].data[2]).toEqual([3, 4, 5, 6])
  })

  it('parses K>1 volumes: N = I*J*K values per variable', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=1 K=2 F=POINT',
      '0 0 0 1',
      '1 0 0 2',
      '0 0 1 3',
      '1 0 1 4'
    ].join('\n'))
    const zone = parsed.zones[0]
    expect(zone.dims).toEqual([2, 1, 2])
    expect(zone.data[3]).toEqual([1, 2, 3, 4])
  })

  it('defaults an absent K to 1 and an absent T to zone-N', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "p"',
      'ZONE I=2 J=2 F=POINT',
      '0 0 1 1 0 0 1 1 5 5 6 6'
    ].join('\n'))
    expect(parsed.zones[0].name).toBe('zone-1')
    expect(parsed.zones[0].dims).toEqual([2, 2, 1])
  })

  it('names consecutive zones zone-1, zone-2 when untitled', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "p"',
      'ZONE I=2 J=1 F=POINT', '0 0 1 1 0 0',
      'ZONE I=2 J=1 F=POINT', '2 2 3 3 0 0'
    ].join('\n'))
    expect(parsed.zones.map((z) => z.name)).toEqual(['zone-1', 'zone-2'])
  })

  it('normalizes Fortran D-exponents to their real value', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=1 K=1 F=POINT',
      '0 0 0 1.0D+03',
      '1 0 0 2.5d-1'
    ].join('\n'))
    // 原实现 parseFloat 在 D 处静默截断（1.0D+03 → 1.0），这里必须读到真值。
    expect(parsed.zones[0].data[3]).toEqual([1000, 0.25])
  })

  it('counts a zone with an incomplete body as omitted instead of rendering it', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE T="good" I=2 J=1 K=1 F=POINT', '0 0 0 1', '1 0 0 2',
      'ZONE T="cut" I=2 J=2 K=1 F=POINT', '0 0 0 1', '1 0 0 2', '0 1 0 3'
    ].join('\n'))
    expect(parsed.zones.map((z) => z.name)).toEqual(['good'])
    expect(parsed.zonesOmitted).toBe(1)
  })

  it('counts malformed and out-of-subset (FE) zones as omitted with zero zones faked', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE T="no-dims"', '0 0 0 1',
      'ZONE T="fe" F=FEPOINT N=2 E=1 NV=4', '0 0 0 1', '1 0 0 2', 'a b', 'c d'
    ].join('\n'))
    expect(parsed.zones).toEqual([])
    expect(parsed.zonesOmitted).toBe(2)
  })

  it('stops at the zone cap and reports how many were omitted', () => {
    const lines = ['VARIABLES = "x" "y" "p"']
    for (let i = 0; i < MAX_ZONES + 3; i += 1) {
      lines.push(`ZONE T="z${i}" I=1 J=1 K=1 F=POINT`, '0 0 5')
    }
    const parsed = parseTecplotAscii(lines.join('\n'))
    expect(parsed.zones).toHaveLength(MAX_ZONES)
    expect(parsed.zonesOmitted).toBe(3)
  })

  it('counts non-finite values instead of faking their magnitude', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = "x" "y" "z" "p"',
      'ZONE I=2 J=1 K=1 F=POINT',
      '0 0 0 1e999',
      '1 0 0 2'
    ].join('\n'))
    expect(parsed.nonFiniteValues).toBe(1)
    expect(parsed.zones[0].data[3][0]).toBe(Number.POSITIVE_INFINITY)
    expect(parsed.zones[0].data[3][1]).toBe(2)
  })

  it('parses bare and quoted variable names and stops VARIABLES at ZONE', () => {
    const parsed = parseTecplotAscii([
      'VARIABLES = X, Y, "dist", 7',
      'ZONE I=1 J=1 K=1 F=POINT', '0 0 5'
    ].join('\n'))
    expect(parsed.variables).toEqual(['X', 'Y', 'dist', '7'])
  })

  it('returns zero zones honestly for an unsupported or empty document', () => {
    expect(parseTecplotAscii('TITLE = "nothing here"')).toEqual({
      variables: [], zones: [], zonesOmitted: 0, nonFiniteValues: 0
    })
  })
})

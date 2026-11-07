import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TRAY_ICON_SIZE, trayIconPng } from '../src/main/trayIcon'

/** Issue 86: the tray icon is drawn in code (a small RGBA PNG) so the tray
 * needs no new binary asset; the bytes must be a structurally valid PNG. */

function chunks(png: Buffer): { type: string; data: Buffer }[] {
  const found: { type: string; data: Buffer }[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    found.push({ type, data: png.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  return found
}

describe('tray icon bytes (#86)', () => {
  it('is a valid 16x16 RGBA PNG with a correct checksummed chunk layout', () => {
    const png = trayIconPng()
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const parsed = chunks(png).map((chunk) => chunk.type)
    expect(parsed).toEqual(['IHDR', 'IDAT', 'IEND'])
    const header = chunks(png)[0].data
    expect(header.readUInt32BE(0)).toBe(TRAY_ICON_SIZE)
    expect(header.readUInt32BE(4)).toBe(TRAY_ICON_SIZE)
    expect(header[8]).toBe(8) // bit depth
    expect(header[9]).toBe(6) // color type RGBA
    const raw = inflateSync(chunks(png)[1].data)
    expect(raw.length).toBe(TRAY_ICON_SIZE * (1 + 4 * TRAY_ICON_SIZE))
  })
  it('draws an opaque disc on transparent ground (no empty tray slot)', () => {
    const png = trayIconPng()
    const raw = inflateSync(chunks(png)[1].data)
    const center = ((TRAY_ICON_SIZE >> 1) * (1 + 4 * TRAY_ICON_SIZE)) + 1 + 4 * (TRAY_ICON_SIZE >> 1)
    expect(raw[center + 3]).toBe(255) // center pixel opaque
    expect(raw[1 + 3]).toBe(0) // top-left corner transparent
    let opaque = 0
    for (let row = 0; row < TRAY_ICON_SIZE; row += 1) {
      for (let column = 0; column < TRAY_ICON_SIZE; column += 1) {
        if (raw[row * (1 + 4 * TRAY_ICON_SIZE) + 1 + 4 * column + 3] === 255) opaque += 1
      }
    }
    expect(opaque).toBeGreaterThan(100)
    expect(opaque).toBeLessThan(TRAY_ICON_SIZE * TRAY_ICON_SIZE)
  })
  it('is deterministic so repeated tray creations reuse the same bytes', () => {
    expect(trayIconPng().equals(trayIconPng())).toBe(true)
  })
})

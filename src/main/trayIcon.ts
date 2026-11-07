/**
 * Issue 86: the tray icon, drawn in code. The repo ships no .ico asset
 * (electron-builder's buildResources carry none), so instead of adding a
 * binary asset the tray renders a small opaque disc as a PNG buffer built
 * here with node's own zlib — no dependency, deterministic bytes, testable
 * structure. The disc stays clearly visible on both light and dark tray
 * backgrounds.
 */
import { deflateSync } from 'node:zlib'

export const TRAY_ICON_SIZE = 16

/** The brand blue; antd's geekblue-6, the renderer's own accent family. */
const TRAY_ICON_RGB: [number, number, number] = [47, 84, 235]

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return chunk
}

function rawScanlines(): Buffer {
  const stride = 1 + 4 * TRAY_ICON_SIZE
  const raw = Buffer.alloc(TRAY_ICON_SIZE * stride)
  const center = (TRAY_ICON_SIZE - 1) / 2
  const radius = TRAY_ICON_SIZE / 2 - 0.5
  for (let row = 0; row < TRAY_ICON_SIZE; row += 1) {
    raw[row * stride] = 0 // filter: none
    for (let column = 0; column < TRAY_ICON_SIZE; column += 1) {
      const distance = Math.hypot(column - center, row - center)
      // One soft edge step keeps the disc readable on dark tray grounds.
      const alpha = distance <= radius - 1 ? 255 : distance <= radius ? 160 : 0
      const offset = row * stride + 1 + 4 * column
      raw[offset] = TRAY_ICON_RGB[0]
      raw[offset + 1] = TRAY_ICON_RGB[1]
      raw[offset + 2] = TRAY_ICON_RGB[2]
      raw[offset + 3] = alpha
    }
  }
  return raw
}

/** The drawn tray icon as PNG bytes (RGBA, `TRAY_ICON_SIZE` square). */
export function trayIconPng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(TRAY_ICON_SIZE, 0)
  header.writeUInt32BE(TRAY_ICON_SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rawScanlines(), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/*
 * The one image fixture the phone's attachment specs pick.
 *
 * Built with zlib rather than committed as base64, and shared rather than
 * copied. Both halves of that are measured history: the committed base64 this
 * replaced (2026-09-14) decoded to a truncated IDAT, WebKit painted it as
 * nothing, and a vision pass read "no photo anywhere" off captures whose
 * renderer was fine. A fixture that cannot be seen cannot prove a thumbnail —
 * so a spec that asserts `naturalWidth > 0` needs real pixels, and a second
 * copy of the generator is how the two specs would come to disagree about
 * whether they have them.
 *
 * Not a *.spec.ts: Playwright's testMatch in both mobile configs collects
 * only that suffix, so importing this registers no tests.
 */
import { deflateSync } from 'node:zlib'

/**
 * A 32×32 two-colour checkerboard PNG — 쪽빛 on paper, the app's own two
 * colours, so the thumbnail reads as a picture in both themes rather than a
 * grey square.
 */
export function checkerPng(size = 32, cell = 8): Buffer {
  const crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  const crc32 = (buf: Buffer): number => {
    let c = -1
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0 // filter none
    for (let x = 0; x < size; x++) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
      const o = y * (size * 3 + 1) + 1 + x * 3
      raw[o] = dark ? 0x2e : 0xf4
      raw[o + 1] = dark ? 0x45 : 0xef
      raw[o + 2] = dark ? 0x60 : 0xe4
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The bytes every spec picks, and the name they all assert on. */
export const CHECKER_PNG = checkerPng()

export function pickChecker(name = 'field.png'): {
  name: string
  mimeType: string
  buffer: Buffer
} {
  return { name, mimeType: 'image/png', buffer: CHECKER_PNG }
}

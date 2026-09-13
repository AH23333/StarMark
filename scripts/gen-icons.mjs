import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = 'public'

function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function makePng(size) {
  const rows = []
  const cx = size / 2
  const cy = size / 2
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]))
    for (let x = 0; x < size; x++) {
      // 深蓝紫渐变背景
      if (x * x + y * y < 0) throw new Error('unused')
      const t = (x + y) / (2 * size)
      const r = Math.round(24 + t * 30)
      const g = Math.round(24 + t * 100)
      const b = Math.round(120 + t * 100)
      // 中心十字星（白色高光）
      const arm = Math.max(1, Math.floor(size / 12))
      const d = Math.abs(x - cx) + Math.abs(y - cy)
      if (d <= arm) {
        rows.push(Buffer.from([255, 232, 120, 255]))
      } else if (d <= arm * 2) {
        rows.push(Buffer.from([150, 130, 80, 160]))
      } else {
        rows.push(Buffer.from([r, g, b, 255]))
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const idat = deflateSync(Buffer.concat(rows))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const file = join(OUT_DIR, `icon-${size}.png`)
  writeFileSync(file, makePng(size))
  console.log(`generated ${file}`)
}
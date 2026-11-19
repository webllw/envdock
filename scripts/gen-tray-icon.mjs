/**
 * 生成系统托盘图标。
 *
 * 图标以 base64 data URL 内嵌到 src/main/tray-icon.ts，避免打包时资源路径失效。
 * 图案为 teal 圆角底 + 白色 E，与主界面品牌标记一致。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WIDTH = 32
const HEIGHT = 32
const RADIUS = 7
const TEAL = [0x0f, 0x9d, 0x8c]
const WHITE = [255, 255, 255]

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([length, name, data, crc])
}

function insideRoundedRect(x, y) {
  const cx = x < RADIUS ? RADIUS : x > WIDTH - 1 - RADIUS ? WIDTH - 1 - RADIUS : x
  const cy = y < RADIUS ? RADIUS : y > HEIGHT - 1 - RADIUS ? HEIGHT - 1 - RADIUS : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

function letterE(x, y) {
  const stem = x >= 10 && x <= 12 && y >= 9 && y <= 23
  const top = x >= 10 && x <= 22 && y >= 9 && y <= 11
  const middle = x >= 10 && x <= 19 && y >= 15 && y <= 17
  const bottom = x >= 10 && x <= 22 && y >= 21 && y <= 23
  return stem || top || middle || bottom
}

const stride = WIDTH * 4 + 1
const raw = Buffer.alloc(stride * HEIGHT)
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * stride
  raw[row] = 0
  for (let x = 0; x < WIDTH; x += 1) {
    const index = row + 1 + x * 4
    if (!insideRoundedRect(x, y)) continue
    const color = letterE(x, y) ? WHITE : TEAL
    raw[index] = color[0]
    raw[index + 1] = color[1]
    raw[index + 2] = color[2]
    raw[index + 3] = 255
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(WIDTH, 0)
ihdr.writeUInt32BE(HEIGHT, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])

const target = resolve('src/main/tray-icon.ts')
writeFileSync(
  target,
  `/** 系统托盘图标，32x32 PNG；由 scripts/gen-tray-icon.mjs 生成，勿手工改动 */\n` +
    `export const TRAY_ICON_DATA_URL = 'data:image/png;base64,${png.toString('base64')}'\n`
)
console.log(`[tray-icon] 已生成 ${target}`)

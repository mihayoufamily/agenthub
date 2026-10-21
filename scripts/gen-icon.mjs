// 生成应用图标 build/icon.ico（纯 JS：软件光栅化 + PNG-in-ICO，不依赖任何外部二进制）
// 设计与 src/renderer/src/components/Logo.tsx 保持一致：暗色圆角底板 + 黄色"上升三角/A"节点连线
// 用法：node scripts/gen-icon.mjs   （需调整图标时手动重生成，产物随仓库提交）
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'build', 'icon.ico')

// ---- PNG 编码（最小实现：单文件、RGBA、无滤镜） ----
function crc32(buf) {
  let c, table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type RGBA
  // 行数据：filter 0 + RGBA
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---- 形状几何（viewBox 64，与 Logo.tsx 一致） ----
const INK = [11, 11, 12, 255]          // #0b0b0c
const INK_STROKE = [70, 69, 67, 255]   // rgba(247,242,232,0.25) 落在暗底上的混合色 #464543
const YELLOW = [232, 163, 61, 255]     // #e8a33d
const CREAM = [247, 242, 232, 255]    // #f7f2e8

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
  const ex = x1 + t * dx - px, ey = y1 + t * dy - py
  return Math.hypot(ex, ey)
}

function inRoundRect(px, py, inset, rx, S) {
  const x = px / S * 64, y = py / S * 64
  const l = inset, t = inset, r = 64 - inset, b = 64 - inset
  if (x < l || x > r || y < t || y > b) return false
  const cx = Math.max(l + rx, Math.min(r - rx, x))
  const cy = Math.max(t + rx, Math.min(b - rx, y))
  return Math.hypot(x - cx, y - cy) <= rx || (x >= l + rx && x <= r - rx) || (y >= t + rx && y <= b - rx)
}

/** 渲染一个尺寸的 RGBA（S 为像素边长；小尺寸保证最小可读笔画）
 *  注意：inRoundRect 的 inset/rx 参数是 viewBox（0-64）单位；线段/圆心坐标与线宽是像素单位 */
function render(S) {
  const scale = S / 64
  // 小尺寸笔画加粗补偿（16px 时 0.6px 会消失，压到至少 ~1.2px）
  const minPx = S <= 16 ? 1.2 / scale : S <= 32 ? 1.0 / scale : 0
  const lwLine = Math.max(3, minPx) * scale
  const lwBar = Math.max(2.5, minPx) * scale
  const rNode = Math.max(4.2, minPx) * scale
  const out = Buffer.alloc(S * S * 4)
  const SS = 3 // 每像素 3x3 超采样
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let r = 0, g = 0, b = 0, covered = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS
          const y = py + (sy + 0.5) / SS
          let col = null
          // 底板（描边 1.5 viewBox 单位，中心在 2：外缘 1.25、内缘 2.75）
          if (inRoundRect(x, y, 1.25, 15, S)) {
            col = inRoundRect(x, y, 2.75, 15, S) ? INK : INK_STROKE
          }
          // 黄色两斜边
          if (col === INK || col === INK_STROKE) {
            if (distSeg(x, y, 32 * scale, 20 * scale, 21 * scale, 43 * scale) < lwLine / 2 ||
                distSeg(x, y, 32 * scale, 20 * scale, 43 * scale, 43 * scale) < lwLine / 2) col = YELLOW
            // 奶油色横杆
            if (distSeg(x, y, 26 * scale, 35 * scale, 38 * scale, 35 * scale) < lwBar / 2) col = CREAM
          }
          // 节点圆（最后画，覆盖线端）
          if (Math.hypot(x - 32 * scale, y - 19 * scale) < rNode) col = YELLOW
          if (Math.hypot(x - 20 * scale, y - 44 * scale) < rNode) col = CREAM
          if (Math.hypot(x - 44 * scale, y - 44 * scale) < rNode) col = CREAM
          if (col) { r += col[0]; g += col[1]; b += col[2]; covered++ }
        }
      }
      const i = (py * S + px) * 4
      if (covered) {
        // 颜色按被覆盖样本平均（非预乘）；透明度 = 覆盖率
        out[i] = Math.round(r / covered)
        out[i + 1] = Math.round(g / covered)
        out[i + 2] = Math.round(b / covered)
        out[i + 3] = Math.round(255 * covered / (SS * SS))
      }
    }
  }
  return out
}

// ---- ICO 容器（PNG 压缩条目，Vista+ 标准） ----
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  const datas = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e[0] = size === 256 ? 0 : size
    e[1] = size === 256 ? 0 : size
    e[2] = 0 // palette
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    datas.push(png)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...datas])
}

const sizes = [256, 48, 32, 16]
const images = sizes.map((S) => {
  const rgba = render(S)
  return { size: S, png: encodePNG(rgba, S, S) }
})
mkdirSync(join(process.cwd(), 'build'), { recursive: true })
writeFileSync(OUT, buildIco(images))
console.log(`[icon] ${OUT} (${sizes.join('/')} px, PNG-in-ICO)`)

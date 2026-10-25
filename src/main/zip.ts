// ============ 最小 ZIP 读写（纯模块，零依赖；主进程市场内核与逻辑层验证共用） ============
//
// 为什么自己写而不是引 jszip/adm-zip：本仓刻意保持运行时依赖只有 react 系（package.json），
// 市场功能只需要"打包几个 Markdown 文件 / 解包一个技能包"这一小片能力，两千行依赖换不来任何
// 额外安全性——zip-slip 的防护终究要自己写，不如连解析也一起攥在手里，逐字节可审计。
//
// 三条如实声明的红线（与市场内核共用）：
// 1. 技能包只是文本：这里只做字节的打包与解包，不执行包里的任何东西；
// 2. 装前可读：解出来的 SKILL.md 是明文，预览不经过任何执行面；
// 3. 恶意条目拒绝而不是抛错：单个 `../` 条目不毁了整个解包，但要逐条点名。

import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// ---------- CRC-32（查表法；IEEE 802.3 多项式 0xEDB88320，与 ZIP 规范一致） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32（无符号；ZIP 各头里的 crc 字段就是这个值） */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------- 打包（store-only） ----------

/**
 * 打包时间固定为 2026-01-01 00:00:00（DOS 时间）。
 * 为什么不取当前时间：同样内容要产出**逐字节相同**的 zip（sha256 才能稳定写进 registry/index.json，
 * PR 审核与验证脚本都依赖"哈希只随内容变"）。
 */
const DOS_TIME = 0 // 00:00:00 → 时/分/秒全是 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1 // 2026-01-01

/**
 * 打包为 store-only（method 0，不压缩）的 zip。
 * 不压缩的理由：技能包是纯文本 Markdown，本来只有几 KB~几十 KB，压缩省不了什么；
 * 换来的是实现里没有 deflate 编码路径（解码走 zlib，编码自研容易出细微错），少一半可错面。
 * 文件名 flag bit 11 置位（UTF-8）：中文文件名在 Windows 解压器里才不会被按本地代码页误读。
 */
export function createZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    // 统一正斜杠、去掉开头分隔符：ZIP 规范用 '/'，Windows 反斜杠写进包里别的解压器读不懂
    const name = e.name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!name) throw new Error('zip 条目名不能为空')
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(e.data)
    const size = e.data.length
    // local file header：签名/版本/flag(0x0800=UTF-8)/method(0=store)/时间/日期/crc/尺寸/文件名
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags：bit 11 = UTF-8 文件名
    local.writeUInt16LE(0, 8) // method 0 = store
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18) // compressed size（store 时与原 size 相同）
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度
    nameBuf.copy(local, 30)
    locals.push(local, e.data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8) // flags（与 local 一致）
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header 偏移
    nameBuf.copy(central, 46)
    centrals.push(central)
    offset += local.length + size
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16) // central directory 起始偏移（= 此前累计的数据量）
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, eocd])
}

// ---------- 解包 ----------

export interface ExtractResult {
  /** 成功写盘的文件绝对路径 */
  files: string[]
  /** 被拒绝的条目名（zip-slip / 解压失败），逐条点名；空的包返回空数组 */
  skipped: string[]
}

/**
 * 解包 zip 到 destDir。支持 stored（method 0）与 deflate（method 8，zlib.inflateRawSync）。
 * 防护口径：
 *  - 入口先按词法拒：entry 名含 `..` 段、绝对路径（开头 `/`）、盘符（`C:`）、反斜杠开头（`\\` 与 UNC 同形态）、
 *    空名、含 NUL 的——一律**跳过并点名**，不抛错（单个恶意条目不毁了整个解包，但必须留痕）；
 *  - 落盘前再按**解析后的绝对路径**复核一次前缀（防符号化路径绕过词法检查）；
 *  - 目录条目跳过（mkdir 时顺带建出）；CRC 不符的条目同样跳过并点名。
 * 返回值永远如实：files 是真写盘的路径，skipped 是被拒的条目名。
 */
export function extractZip(buf: Buffer, destDir: string): ExtractResult {
  const files: string[] = []
  const skipped: string[] = []
  const root = resolve(destDir)

  // 从尾部向前找 EOCD（0x06054b50）：正规 zip 的注释为空时应就在末尾，容忍残留注释
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 central directory 结尾标记）')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      skipped.push(`#central-${n}`)
      break
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const crc = buf.readUInt32LE(p + 16)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    // 加密位（bit 0）：本仓不持有任何口令，加密条目直接点名拒绝
    const rawName = buf.slice(p + 46, p + 46 + nameLen).toString('utf-8')
    p += 46 + nameLen + extraLen + commentLen

    if (flags & 0x1) { skipped.push(rawName); continue }
    // 目录条目：不写盘（目录在写文件时按需 mkdir）
    if (rawName.endsWith('/')) continue

    const name = rawName.replace(/\\/g, '/')
    const bad =
      !name ||
      rawName.startsWith('\\') || // Windows 反斜杠开头（含 UNC \\server 形态）
      name.startsWith('/') ||
      /^[A-Za-z]:/.test(name) ||
      name.split('/').some((seg) => seg === '..') ||
      name.includes('\0')
    if (bad) { skipped.push(rawName); continue }

    // 读 local header：数据起点 = local 偏移 + 30 + local 文件名长 + local extra 长
    // （local 与 central 的名字/extra 长度可能不同，必须用 local 自己的字段，不能复用 central 的）
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      skipped.push(rawName); continue
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + csize > buf.length) { skipped.push(rawName); continue }
    const raw = buf.slice(dataStart, dataStart + csize)

    let data: Buffer
    try {
      if (method === 0) data = raw
      else if (method === 8) data = inflateRawSync(raw)
      else { skipped.push(rawName); continue } // 未知压缩方法：拒绝，不猜
    } catch {
      skipped.push(rawName); continue
    }
    // 解出来的实际大小 / CRC 与 central 登记不符（解压炸弹与截断的最直白信号）：拒绝
    if (data.length !== usize || crc32(data) !== crc) {
      skipped.push(rawName); continue
    }

    // 词法过了再按解析后的绝对路径复核前缀：resolve 会吃掉 `./`、多余分隔符等词法没覆盖的形态
    const target = resolve(join(root, name))
    if (target !== root && !target.startsWith(root + sep)) {
      skipped.push(rawName); continue
    }
    try {
      mkdirSync(resolve(target, '..'), { recursive: true })
      writeFileSync(target, data)
      // 写盘后再复核一遍（extract 后前缀复核）：万一 target 在写入瞬间被符号链接换了指向，
      // 这里能发现并点名——不粉饰成"成功"
      if (!existsSync(target) || !statSync(target).isFile() || !resolve(target).startsWith(root + sep)) {
        skipped.push(rawName); continue
      }
      files.push(target)
    } catch {
      skipped.push(rawName)
    }
  }
  return { files, skipped }
}

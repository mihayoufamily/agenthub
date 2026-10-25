// 技能中心内核的功能验证（逻辑层，不起 electron）：zip 读写往返 / zip-slip 防护 / 注册表解析闸门 /
// 内置技能扫描 / 安装的纯守卫路径与源码绊线。被测口径直接用编译产物（out/main/zip.js、out/main/market.js），
// 与真实运行时是同一份代码——deliver-check 同款做法。
// 前置：npm run build:main（out 下要有 zip.js 与 market.js）
// 用法：node verify/market-check.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const zip = require('../out/main/zip.js')
const market = require('../out/main/market.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''} `) }
}

const TMP = mkdtempSync(join(tmpdir(), 'ahub-market-'))
try {
  // ---------- A. crc32 已知向量 ----------
  console.log('\n[A] crc32 已知向量')
  ok('crc32("123456789") = 0xCBF43926（IEEE 标准测试向量）',
    zip.crc32(Buffer.from('123456789')) === 0xcbf43926,
    '0x' + zip.crc32(Buffer.from('123456789')).toString(16))
  ok('crc32 空缓冲 = 0', zip.crc32(Buffer.alloc(0)) === 0)
  ok('crc32 返回无符号（不出现负数）', zip.crc32(Buffer.from('\xff\xff\xff\xff')) >= 0)

  // ---------- B. createZip → extractZip 往返（含子目录） ----------
  console.log('\n[B] zip 打包/解包往返（store-only）')
  {
    const entries = [
      { name: 'SKILL.md', data: Buffer.from('---\nname: 测试技能\ndescription: 往返测试\n---\n\n# 正文\n第一行中文内容', 'utf-8') },
      { name: 'references/deep.md', data: Buffer.from('参考文献内容'.repeat(50), 'utf-8') },
      { name: 'assets/空格 名.md', data: Buffer.from('带空格与中文的文件名', 'utf-8') }
    ]
    const a = zip.createZip(entries)
    const b = zip.createZip(entries)
    ok('同样内容两次打包逐字节相同（DOS 时间固定 → 哈希可复现）', a.equals(b))
    const dest = join(TMP, 'rt')
    const r = zip.extractZip(a, dest)
    ok('往返解出 3 个文件', r.files.length === 3 && r.skipped.length === 0, JSON.stringify(r))
    ok('解出内容与原文一致', readFileSync(join(dest, 'SKILL.md'), 'utf-8').includes('第一行中文内容'))
    ok('子目录条目落在子目录里', existsSync(join(dest, 'references', 'deep.md')))
    ok('UTF-8 文件名（空格/中文）原样还原', existsSync(join(dest, 'assets', '空格 名.md')))
    // 前缀复核：解出的路径全部在目标目录内
    const root = resolve(dest)
    ok('解出路径全部在 destDir 内（前缀复核）', r.files.every((f) => resolve(f).startsWith(root)))
  }

  // ---------- C. deflate 条目解包（第三方压缩器产物也要读得开） ----------
  console.log('\n[C] deflate（method 8）条目解包')
  {
    // 本仓只产出 store-only 包，但用户拿来的包可能是压缩的：测试侧手搓一个 deflate 包验证解路径
    const name = 'references/压缩.md'
    const raw = Buffer.from('压缩正文内容 '.repeat(100), 'utf-8')
    const deflated = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = zip.crc32(raw)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 42); nameBuf.copy(central, 46)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length + deflated.length, 16)
    const buf = Buffer.concat([local, deflated, central, eocd])
    const r = zip.extractZip(buf, join(TMP, 'deflate'))
    ok('deflate 条目解出且内容一致',
      r.files.length === 1 && r.skipped.length === 0 && readFileSync(r.files[0], 'utf-8').includes('压缩正文内容'),
      JSON.stringify(r))
  }

  // ---------- D. zip-slip 四种形态全部被拒且点名 ----------
  console.log('\n[D] zip-slip 防护（拒绝不抛错，逐条点名）')
  {
    // 测试侧裸打包器：不做任何文件名消毒，专产恶意包（createZip 自己会消毒，造不出攻击样本）
    const rawZip = (entries) => {
      const locals = []; const centrals = []; let off = 0
      for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf-8')
        const method = e.deflate ? 8 : 0
        const data = e.deflate ? deflateRawSync(e.data) : e.data
        const crc = e.badCrc ? 0xdeadbeef : zip.crc32(e.data)
        const l = Buffer.alloc(30 + nameBuf.length)
        l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0, 6); l.writeUInt16LE(method, 8)
        l.writeUInt32LE(crc, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(e.data.length, 22)
        l.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(l, 30)
        locals.push(l, data)
        const c = Buffer.alloc(46 + nameBuf.length)
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10)
        c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(e.data.length, 24)
        c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(off, 42); nameBuf.copy(c, 46)
        centrals.push(c)
        off += l.length + data.length
      }
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
      eocd.writeUInt32LE(centrals.reduce((n, x) => n + x.length, 0), 12); eocd.writeUInt32LE(off, 16)
      return Buffer.concat([...locals, ...centrals, eocd])
    }
    const evil = [
      { name: '../逃逸.txt', data: Buffer.from('x') },      // .. 段
      { name: 'C:/盘符.txt', data: Buffer.from('x') },      // 盘符
      { name: '/绝对.txt', data: Buffer.from('x') },        // 绝对路径
      { name: '\\\\unc\\host.txt', data: Buffer.from('x') } // 反斜杠开头（UNC 形态）
    ]
    const r = zip.extractZip(rawZip(evil), join(TMP, 'slip'))
    ok('四种恶意形态全部被拒（不写盘、不抛错）', r.files.length === 0, JSON.stringify(r))
    ok('每条恶意条目都被点名进 skipped', evil.every((e) => r.skipped.includes(e.name)), JSON.stringify(r.skipped))
    // 正常条目与恶意条目混包：好的照常解出，坏的点名——单个恶意条目不毁整个解包
    const mixed = [...evil, { name: 'SKILL.md', data: Buffer.from('正常内容', 'utf-8') }]
    const r2 = zip.extractZip(rawZip(mixed), join(TMP, 'slip-mixed'))
    ok('混合包：正常条目照常解出', r2.files.length === 1 && readFileSync(r2.files[0], 'utf-8').includes('正常内容'))
    ok('混合包：恶意条目仍逐条点名', r2.skipped.length === 4)
    ok('目录条目跳过不写盘', zip.extractZip(rawZip([{ name: 'sub/', data: Buffer.alloc(0) }, { name: 'a.txt', data: Buffer.from('y') }]), join(TMP, 'dir-entry')).files.length === 1)
    ok('CRC 不符的条目被拒并点名', (() => {
      const r3 = zip.extractZip(rawZip([{ name: 'bad.txt', data: Buffer.from('内容', 'utf-8'), badCrc: true }]), join(TMP, 'crc'))
      return r3.files.length === 0 && r3.skipped.length === 1 && r3.skipped[0] === 'bad.txt'
    })())
  }

  // ---------- E. parseRegistryIndex 闸门 ----------
  console.log('\n[E] parseRegistryIndex（纯函数）')
  const good = {
    id: 'demo', name: '演示', desc: '一个合法条目', version: '1.0.0',
    sha256: 'a'.repeat(64), size: 100,
    url: 'https://raw.githubusercontent.com/mihayoufamily/agenthub-skills/main/packs/demo-1.0.0.zip'
  }
  {
    const r1 = market.parseRegistryIndex(JSON.stringify([good]))
    ok('合法条目通过且字段收紧为小写哈希', r1.ok && r1.items.length === 1 && r1.items[0].sha256 === 'a'.repeat(64))
    const r1w = market.parseRegistryIndex(JSON.stringify({ comment: '说明', items: [good] }))
    ok('包装对象 { items: [...] } 同样收（registry/index.json 的形态）', r1w.ok && r1w.items.length === 1)
  }
  {
    const missing = { ...good, sha256: undefined }
    const r = market.parseRegistryIndex(JSON.stringify([missing, good]))
    ok('缺 sha256 的条目被跳过，其余照常收下', r.ok && r.items.length === 1, JSON.stringify(r))
    ok('被跳过的条目被点名（不整表拒绝、不静默丢）', (r.skipped ?? []).some((s) => s.includes('demo')), JSON.stringify(r.skipped))
  }
  {
    const r = market.parseRegistryIndex(JSON.stringify([{ ...good, sha256: 'xyz'.repeat(10) }]))
    ok('sha256 非 64 位十六进制被拒', !r.ok || (r.items.length === 0 && (r.skipped ?? []).length === 1))
    const r2 = market.parseRegistryIndex(JSON.stringify([{ ...good, sha256: 'A'.repeat(64) }]))
    ok('大写十六进制也收（收下时统一转小写）', r2.ok && r2.items[0]?.sha256 === 'a'.repeat(64))
  }
  {
    const r = market.parseRegistryIndex(JSON.stringify([{ ...good, url: 'https://evil.example.com/pack.zip' }]))
    ok('越权 url（非官方 packs/ 前缀）被拒并点名', r.ok && r.items.length === 0 && (r.skipped ?? []).some((s) => s.includes('demo')), JSON.stringify(r))
  }
  {
    const r = market.parseRegistryIndex('这不是 JSON')
    ok('非法 JSON 返回 ok:false + 中文原因', !r.ok && /JSON/.test(r.error))
    const r2 = market.parseRegistryIndex('{"a":1}')
    ok('非数组（也无 items）返回 ok:false', !r2.ok)
    const r3 = market.parseRegistryIndex('[]')
    ok('空表合法（0 条）', r3.ok && r3.items.length === 0)
  }
  {
    // 真正随仓库发布的 index.json 必须能过自己的闸门（自洽：闸门改了注册表没跟上会当场红）
    const idx = JSON.parse(readFileSync(new URL('../registry/index.json', import.meta.url), 'utf-8'))
    const r = market.parseRegistryIndex(JSON.stringify(idx))
    ok('registry/index.json 通过 parseRegistryIndex 闸门', r.ok && r.items.length === 3, JSON.stringify(r.error ?? ''))
    // 发布产物自洽：每个条目的哈希/大小与 packs/ 里实际文件一致（哈希只随内容变，改内容必须重算）
    let selfConsistent = true
    for (const it of r.items) {
      const p = new URL('../registry/packs/' + it.id + '-' + it.version + '.zip', import.meta.url)
      const buf = readFileSync(p)
      const sha = createHash('sha256').update(buf).digest('hex')
      if (sha !== it.sha256 || buf.length !== it.size) { selfConsistent = false; console.log(`    不一致：${it.id} 声明 ${it.sha256}/${it.size} 实际 ${sha}/${buf.length}`) }
    }
    ok('index.json 的 sha256/size 与 packs/ 实际文件逐字节一致', selfConsistent)
    // 发布的包真的解得开、里面真的有 SKILL.md（装前可读的最小证据）
    const packBuf = readFileSync(new URL('../registry/packs/code-review-1.0.0.zip', import.meta.url))
    const pr = zip.extractZip(packBuf, join(TMP, 'selfpack'))
    ok('发布的 code-review 包可解出且含 SKILL.md', pr.files.length === 1 && pr.files[0].endsWith('SKILL.md'), JSON.stringify(pr))
  }

  // ---------- F. 内置技能扫描（注入路径的临时实例，不起 electron） ----------
  console.log('\n[F] listBuiltin（注入路径）')
  {
    const bDir = join(TMP, 'builtin')
    mkdirSync(join(bDir, 'code-review'), { recursive: true })
    mkdirSync(join(bDir, 'not-a-skill'), { recursive: true }) // 没有 SKILL.md：应被跳过
    writeFileSync(join(bDir, 'code-review', 'SKILL.md'), '---\nname: 代码审查清单\ndescription: 测试内置\nversion: 1.0.0\n---\n\n# 正文内容标记 BUILTIN-CONTENT', 'utf-8')
    mkdirSync(join(bDir, 'code-review', 'references'), { recursive: true })
    writeFileSync(join(bDir, 'code-review', 'references', 'extra.md'), '附带', 'utf-8')
    market.init(bDir, join(TMP, 'ud'))
    const list = market.listBuiltin()
    ok('扫出内置技能且 id 规则为 builtin-<目录名>', list.length === 1 && list[0].id === 'builtin-code-review', JSON.stringify(list.map((s) => s.id)))
    ok('frontmatter 解析进 name/desc，正文不含 frontmatter', list[0].name === '代码审查清单' && list[0].desc === '测试内置' && list[0].content.includes('BUILTIN-CONTENT') && !list[0].content.includes('description:'))
    ok('附带文件清单被登记（references/）', Array.isArray(list[0].files) && list[0].files.includes('references/extra.md'), JSON.stringify(list[0].files))
    ok('source 标注为 builtin', list[0].source === 'builtin' && list[0].sourceId === 'code-review')
    ok('无 SKILL.md 的目录被跳过', !list.some((s) => s.id === 'builtin-not-a-skill'))
    // init 没调过（模块刚加载时）不该抛错：再开一个干净实例做不到（模块级状态），改验证空目录形态
    market.init(join(TMP, 'no-such-dir'), join(TMP, 'ud'))
    ok('builtinDir 不存在时返回空列表而非抛错', market.listBuiltin().length === 0)
  }

  // ---------- G. 安装的纯守卫路径 + 哈希比对源码绊线 ----------
  console.log('\n[G] installFromMarket 守卫与哈希比对')
  {
    // net.fetch 在纯 node 里 mock 不了，这里测下载之前的守卫路径；下载之后的哈希比对用
    // 编译产物源码绊线断言（口径同 deliver-check 对源码的 includes 绊线）：
    // "算出实际哈希 → 与声明不符即 return"必须出现在 extractZip/写盘之前——坏包一个字节都不落盘。
    // 引号形态两算（tsc 产物字符串用双引号，中文串不受影响），指针打出来如实核对，不猜。
    const src = readFileSync(new URL('../out/main/market.js', import.meta.url), 'utf-8')
    const digestAt = src.indexOf('digest(')
    const mismatchAt = src.indexOf('哈希校验不符')
    // tsc 产物把 import 解构编译成 `(0, zip_1.extractZip)(...)`，所以这里不带括号搜
    const extractAt = src.indexOf('extractZip')
    console.log(`  [G 实测] digest=${digestAt} mismatch=${mismatchAt} extract=${extractAt}`)
    ok('编译产物里哈希比对（含不符拒绝）先于解包写盘（绊线）',
      digestAt > 0 && mismatchAt > digestAt && extractAt > mismatchAt,
      `digest=${digestAt} mismatch=${mismatchAt} extract=${extractAt}`)
  }
  {
    // 守卫路径是同步拒绝（在 await 之前 return），promise 也应立即落定
    const r1 = await market.installFromMarket({ id: 'demo', name: 'x', desc: '', version: '1', sha256: 'a'.repeat(64), size: 1, url: 'https://evil.example.com/x.zip' })
    ok('越权 url 的安装返回 ok:false 且说明原因', r1.ok === false && /官方包前缀/.test(r1.message))
    const r2 = await market.installFromMarket({ id: 'demo', name: 'x', desc: '', version: '1', sha256: 'nothex', size: 1, url: market.REGISTRY_PACK_PREFIX + 'x.zip' })
    ok('sha256 非法的安装返回 ok:false', r2.ok === false && /sha256/.test(r2.message))
    const r3 = await market.installFromMarket({ id: 'demo/../../evil', name: 'x', desc: '', version: '1', sha256: 'a'.repeat(64), size: 1, url: market.REGISTRY_PACK_PREFIX + 'x.zip' })
    ok('id 带路径穿越片段被 id 白名单拒绝', r3.ok === false && /id 不合法/.test(r3.message))
    const r4 = await market.installFromMarket(null)
    ok('非对象入参拒绝', r4.ok === false)
    // REGISTRY_PACK_PREFIX 导出且与 REGISTRY_URL 同仓（防有人改一半）
    ok('REGISTRY_PACK_PREFIX 是 REGISTRY_URL 同仓的 packs/ 路径',
      market.REGISTRY_URL.startsWith('https://raw.githubusercontent.com/mihayoufamily/agenthub-skills/main/') &&
      market.REGISTRY_PACK_PREFIX === 'https://raw.githubusercontent.com/mihayoufamily/agenthub-skills/main/packs/')
  }

  // ---------- H. exportPack 的纯守卫（对话框路径不起 electron，测不到；守卫在这里） ----------
  console.log('\n[H] exportPack 守卫')
  {
    const r = await market.exportPack('不 合法/id')
    ok('exportPack 的 id 白名单拒绝非法 id', r.ok === false && /id 不合法/.test(r.message ?? ''))
  }

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
} finally {
  // 收尾删临时目录（Windows 上文件可能短暂被占，带重试；删不干净只留痕不影响判定）
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    console.log(`[market-check] 临时目录清理失败（可手动删除）：${TMP}`)
  }
}
process.exit(fail > 0 ? 1 : 0)

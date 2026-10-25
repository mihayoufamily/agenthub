// ============ 技能中心主进程内核：内置技能 / 注册表 / 安装 / 导出 ============
//
// 三条如实声明的红线（与本仓 Skill 体系既有不变量一致，这里只是沿用不是新造）：
// 1. 下载/内置的技能**只是文本**：市场不引入任何执行面——脚本文件只登记路径清单，
//    现有"不执行 skill 里的脚本"的不变量原样适用，要跑仍走工具层的命令授权；
// 2. **装前可读**：预览走 skills.list 之外的只读通道（market:builtin / market:registry 都拿得到
//    SKILL.md 正文），不装也能看内容；
// 3. **安装 ≠ 启用**：落盘的 enabled 默认 true，与现有本地导入行为完全一致——不新造
//    "安装后禁用"的第三态，界面上由用户拨开关，安装回执里写明去哪里停用。
//
// 为什么自研 zip 解析（main/zip.ts）而不是引第三方：技能包只是几个 Markdown 文本，
// 防护面（zip-slip、哈希、下载上限）终究要自己写，连解析一起攥在手里才逐字节可审计。
import type { Skill } from '../shared/types'
import { createZip, extractZip } from './zip'
import { join, dirname, resolve, sep } from 'node:path'
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

// ---------- frontmatter 解析（全仓唯一实现；ipc.ts 的 skill:import 也引用这里） ----------

/** Agent Skills 的 frontmatter：只取顶层 `key: value`（够用且不会误吃正文里的冒号） */
export function parseSkillFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return { meta, body: raw.slice(m[0].length) }
}

// ---------- 模块状态（由 init 注入，纯函数部分不依赖） ----------

let builtinDir = ''
let userDataDir = ''

/**
 * 主进程启动时注入路径。builtinDir 两种形态都对：
 * packaged 时是 <便携根>/resources/app/builtin-skills，dev 时是仓库根/builtin-skills
 * ——都由 app.getAppPath() 推出，见 ipc.ts 的调用点。
 */
export function init(builtin: string, ud: string) {
  builtinDir = builtin
  userDataDir = ud
}

// 存储访问由 ipc.ts 启动时绑定（逻辑层测试不绑定也能测纯函数部分）。
// 为什么不用 init 直接收 store：market.ts 只需要"读技能表 / 落一个技能"两个动作，
// 收窄成两个函数让依赖面可见，也避免为测试去构造整个 Store。
let storeAccess: { getSkills: () => Skill[]; saveSkill: (s: Skill) => Skill } | null = null
export function bindStore(access: { getSkills: () => Skill[]; saveSkill: (s: Skill) => Skill }) {
  storeAccess = access
}

/** 附带文件登记口径：与 ipc.ts skill:import 的既有清单逻辑保持同一套（目录前缀或文本扩展名） */
function listAttachedFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true })
      .map((f) => String(f).replace(/\\/g, '/'))
      .filter((f) => /^(references|scripts|examples|assets)\//i.test(f) || /\.(md|txt|json|ya?ml)$/i.test(f))
      .filter((f) => f !== 'SKILL.md')
      .slice(0, 40)
  } catch {
    return []
  }
}

// ---------- 内置技能（只读列表，不落盘） ----------

/**
 * 扫描 builtinDir 下每个含 SKILL.md 的子目录，产出 builtin 技能列表。
 * id 规则 `builtin-<目录名>`：与用户自建 id（skill_*）、市场 id（market-*）天然不撞，
 * 用户对内置技能的启用/禁用等操作也不影响这份只读清单。
 */
export function listBuiltin(): Skill[] {
  if (!builtinDir || !existsSync(builtinDir)) return []
  const out: Skill[] = []
  let names: string[] = []
  try {
    names = readdirSync(builtinDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  for (const name of names) {
    // 文件名大小写都认（与 skill:import 同一口径），官方目录统一写 SKILL.md
    const dir = join(builtinDir, name)
    const mdPath = ['SKILL.md', 'skill.md', 'Skill.md'].map((n) => join(dir, n)).find((p) => existsSync(p))
    if (!mdPath) continue
    try {
      const raw = readFileSync(mdPath, 'utf-8')
      const { meta, body } = parseSkillFrontmatter(raw)
      out.push({
        id: `builtin-${name}`,
        name: (meta.name || name).slice(0, 60),
        desc: (meta.description || '').slice(0, 200),
        content: body.trim() || raw.trim(),
        createdAt: statSync(mdPath).mtimeMs,
        enabled: true,
        dir,
        files: listAttachedFiles(dir),
        format: 'agentskills',
        source: 'builtin',
        sourceId: name,
        ...(meta.version ? { version: meta.version } : {}),
        ...(meta.author ? { author: meta.author } : {}),
        ...(meta.homepage ? { homepage: meta.homepage } : {})
      })
    } catch {
      // 单个内置目录读不出来只跳过，不掀掉整张内置清单
    }
  }
  return out
}

// ---------- 注册表 ----------

/**
 * 注册表 URL：仓库由项目方维护，收录审核在项目方（提 PR 改 index.json + packs/，见 registry/README.md）。
 * 第三方注册表源**刻意不做**：注册表一旦开放，"来源可信"就退化为"来源声称可信"。
 */
export const REGISTRY_URL = 'https://raw.githubusercontent.com/mihayoufamily/agenthub-skills/main/index.json'

/** 包下载 URL 必须带的前缀：即使上游 index.json 被篡改，包也只能来自这个仓库前缀 */
export const REGISTRY_PACK_PREFIX = 'https://raw.githubusercontent.com/mihayoufamily/agenthub-skills/main/packs/'

export interface RegistryItem {
  id: string
  name: string
  desc: string
  version: string
  /** 包内容的 SHA-256（64 位十六进制）；安装时逐字节比对，不符拒绝 */
  sha256: string
  /** 包字节数（正整数）；下载时做 2MB 硬上限的第一道参照 */
  size: number
  /** 下载地址（必须是 REGISTRY_PACK_PREFIX 前缀） */
  url: string
  author?: string
  homepage?: string
}

export interface RegistryResult {
  ok: boolean
  items: RegistryItem[]
  /** ok=false 时的中文原因；部分条目被跳过时也可能带说明 */
  error?: string
  /** true = 这份数据来自本地缓存（304 命中，或网络失败回退）——界面要如实标，不冒充实时数据 */
  fromCache?: boolean
  /** 被跳过的非法条目（点名 id 或位置），不整表拒绝 */
  skipped?: string[]
}

/**
 * 校验注册表 JSON（纯函数，导出给逻辑层测）。
 * 逐条校验：id/name/desc/version 字符串、sha256 为 64 位十六进制、size 为正整数、
 * url 必须带 REGISTRY_PACK_PREFIX 前缀。非法条目**跳过并点名**——一条脏数据不该否决整张表，
 * 但"跳过了谁"必须回给界面（静默丢条目是本仓明确修过的缺陷，不重犯）。
 */
export function parseRegistryIndex(text: string): RegistryResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, items: [], error: '注册表内容不是合法 JSON' }
  }
  // 两种形态都收：裸数组，或带说明字段的包装对象 { items: [...] }（registry/index.json 用后者，
  // 给仓库里的维护说明留一个落脚位）。除 items 外的字段一律忽略，不当第二份真相。
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    data = (data as { items?: unknown }).items
  }
  if (!Array.isArray(data)) return { ok: false, items: [], error: '注册表格式不正确（应为条目数组或 { items: [...] }）' }
  const items: RegistryItem[] = []
  const skipped: string[] = []
  data.forEach((raw, i) => {
    const label = (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string')
      ? String((raw as { id: string }).id)
      : `#${i}`
    const bad = (why: string) => skipped.push(`${label}（${why}）`)
    if (!raw || typeof raw !== 'object') { bad('不是对象'); return }
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(e.id)) { bad('id 不合法'); return }
    if (typeof e.name !== 'string' || !e.name.trim()) { bad('缺 name'); return }
    if (typeof e.desc !== 'string') { bad('缺 desc'); return }
    if (typeof e.version !== 'string' || !e.version.trim()) { bad('缺 version'); return }
    if (typeof e.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(e.sha256)) { bad('sha256 不是 64 位十六进制'); return }
    if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size <= 0) { bad('size 不是正整数'); return }
    if (typeof e.url !== 'string' || !e.url.startsWith(REGISTRY_PACK_PREFIX)) { bad('url 越出官方包前缀'); return }
    items.push({
      id: e.id,
      name: e.name.slice(0, 60),
      desc: e.desc.slice(0, 200),
      version: e.version.slice(0, 40),
      sha256: e.sha256.toLowerCase(),
      size: e.size,
      url: e.url,
      ...(typeof e.author === 'string' && e.author ? { author: e.author.slice(0, 80) } : {}),
      ...(typeof e.homepage === 'string' && /^https:\/\//.test(e.homepage) ? { homepage: e.homepage } : {})
    })
  })
  return {
    ok: true,
    items,
    ...(skipped.length ? { skipped, error: `${skipped.length} 条非法条目已跳过：${skipped.join('；')}` } : {})
  }
}

interface RegistryCache {
  etag?: string
  body: string
  fetchedAt: number
}

function cachePath(): string {
  return join(userDataDir, 'market-cache.json')
}

function readCache(): RegistryCache | null {
  try {
    const c = JSON.parse(readFileSync(cachePath(), 'utf-8')) as RegistryCache
    if (typeof c.body !== 'string') return null
    return c
  } catch {
    return null
  }
}

function writeCache(c: RegistryCache) {
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(c), 'utf-8')
  } catch { /* 缓存写不进去不阻塞本次结果，下次再试 */ }
}

/** net.fetch 延迟取（与 updater 同款 UA；逻辑层测试不起 electron，摸不到 net 也不 import 就炸） */
function netFetch(url: string, init?: RequestInit): Promise<Response> {
  const { net } = require('electron') as typeof import('electron')
  return net.fetch(url, init)
}

/**
 * 拉注册表：ETag 缓存（If-None-Match → 304 用缓存）；网络失败有缓存则回缓存并如实标 fromCache；
 * 两者皆无才返回 ok:false + 中文原因。取回来仍要过 parseRegistryIndex 同一道闸。
 */
export async function fetchRegistry(): Promise<RegistryResult> {
  const cached = readCache()
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'AgentHub-Updater',
      Accept: 'application/json'
    }
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    const res = await netFetch(REGISTRY_URL, { headers, signal: AbortSignal.timeout(10000) })
    if (res.status === 304 && cached) {
      const r = parseRegistryIndex(cached.body)
      return { ...r, fromCache: true }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const r = parseRegistryIndex(text)
    if (r.ok) writeCache({ etag: res.headers.get('etag') ?? undefined, body: text, fetchedAt: Date.now() })
    // 上游格式坏了就不覆盖缓存：手里最后一份好数据比"刚拉的坏数据"值钱
    else if (cached) return { ...parseRegistryIndex(cached.body), fromCache: true, error: r.error }
    return r
  } catch (e) {
    if (cached) {
      const r = parseRegistryIndex(cached.body)
      return { ...r, fromCache: true, ...(r.ok ? { error: `网络失败，已回退缓存：${(e as Error).message}` } : {}) }
    }
    return { ok: false, items: [], error: `无法获取注册表：${(e as Error).message}（未有任何缓存）` }
  }
}

// ---------- 安装 ----------

export interface InstallResult {
  ok: boolean
  skill?: Skill
  message?: string
}

/** 下载硬上限：技能包只是文本，2MB 绰绰有余；上限防的是"注册表指向一个巨大文件把内存打爆" */
const MAX_PACK_BYTES = 2 * 1024 * 1024

/**
 * 从市场安装：下载 → sha256 逐字节比对（不符如实拒绝并给出两个哈希值）→ 解包到
 * <userData>/market-src/<id>-<version>/ → 读 SKILL.md + 登记附带文件 → saveSkill。
 * id 稳定为 `market-<item.id>`：更新时覆盖同 id，Agent/角色上已经绑定的引用不断链。
 */
export async function installFromMarket(item: RegistryItem): Promise<InstallResult> {
  // 入参再过一遍闸（ipc 层的白名单挡的是渲染层，这里防的是别的调用方/未来改动）
  if (!item || typeof item !== 'object') return { ok: false, message: '安装条目不合法' }
  if (typeof item.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(item.id)) return { ok: false, message: '条目 id 不合法' }
  if (typeof item.url !== 'string' || !item.url.startsWith(REGISTRY_PACK_PREFIX)) {
    return { ok: false, message: '下载地址越出官方包前缀，已拒绝' }
  }
  if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) return { ok: false, message: '条目 sha256 不合法' }
  if (!storeAccess) return { ok: false, message: '技能中心尚未初始化' }

  // 流式下载并增量算哈希，超 2MB 即刻中止：不先落盘再算，坏包一个字节都不给它留地方
  let got = 0
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  try {
    const res = await netFetch(item.url, { headers: { 'User-Agent': 'AgentHub-Updater' }, signal: AbortSignal.timeout(30000) })
    if (!res.ok || !res.body) return { ok: false, message: `下载失败：HTTP ${res.status}` }
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.byteLength
      if (got > MAX_PACK_BYTES) return { ok: false, message: `包超过 ${Math.round(MAX_PACK_BYTES / 1024 / 1024)}MB 上限，已中止下载` }
      const b = Buffer.from(chunk)
      hash.update(b)
      chunks.push(b)
    }
  } catch (e) {
    return { ok: false, message: `下载失败：${(e as Error).message}` }
  }
  const actual = hash.digest('hex')
  if (actual !== item.sha256) {
    // 两个哈希都给出来：用户/审核方能自己判断是"包变了"还是"注册表写错了"
    return { ok: false, message: `哈希校验不符，已拒绝安装（注册表声明 ${item.sha256}，实际下载 ${actual}）` }
  }

  const ver = String(item.version ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || '0'
  const dest = join(userDataDir, 'market-src', `${item.id}-${ver}`)
  try {
    mkdirSync(dest, { recursive: true })
    const r = extractZip(Buffer.concat(chunks), dest)
    // zip-slip 等被拒条目要点名：装了几个、跳过几个，都写在回执里
    if (!r.files.length) {
      return { ok: false, message: `解包失败：包内没有可用的文件${r.skipped.length ? `（被拒条目：${r.skipped.join('；')}）` : ''}` }
    }
  } catch (e) {
    return { ok: false, message: `解包失败：${(e as Error).message}` }
  }

  const mdPath = ['SKILL.md', 'skill.md', 'Skill.md'].map((n) => join(dest, n)).find((p) => existsSync(p))
  if (!mdPath) return { ok: false, message: '包里没有 SKILL.md，不是技能包' }
  let raw = ''
  try {
    raw = readFileSync(mdPath, 'utf-8')
    if (raw.length > 256 * 1024) raw = raw.slice(0, 256 * 1024) + '\n…（内容超长，已截断）'
  } catch (e) {
    return { ok: false, message: `读取 SKILL.md 失败：${(e as Error).message}` }
  }
  const { meta, body } = parseSkillFrontmatter(raw)
  const attached = listAttachedFiles(dest)
  const skillId = `market-${item.id}`
  const saved = storeAccess.saveSkill({
    id: skillId,
    name: (meta.name || item.name || item.id).slice(0, 60),
    desc: (meta.description || item.desc || '').slice(0, 200),
    content: body.trim() || raw.trim(),
    createdAt: Date.now(),
    enabled: true,
    dir: dest,
    files: attached,
    format: 'agentskills',
    source: 'market',
    sourceId: item.id,
    version: (meta.version || item.version || '').slice(0, 40),
    ...(item.author ? { author: item.author } : {}),
    ...(item.homepage ? { homepage: item.homepage } : {})
  })
  return {
    ok: true,
    skill: saved,
    message: `已安装 v${saved.version || item.version}，默认启用，可在技能中心或设置里停用；脚本文件只登记不执行，要跑仍走命令授权`
  }
}

// ---------- 导出 ----------

export interface ExportResult {
  ok: boolean
  path?: string
  message?: string
}

/**
 * 把本地技能打成 store-only zip（对称口）：SKILL.md（含 frontmatter）+ files 里登记的附带文件。
 * 导出的包可直接提 PR 进 registry（流程见 registry/README.md）。
 * 有 dir 的技能（导入/内置/市场装的）读盘上的 SKILL.md 与附带文件；纯手写技能（无 dir）用
 * name/desc/content 现场合成一份 frontmatter——导出能力不该只属于"从目录导入的人"。
 */
export async function exportPack(id: string): Promise<ExportResult> {
  // id 白名单在存储访问之前：与 installFromMarket 同一口径，入口形状问题不依赖初始化状态
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) return { ok: false, message: '技能 id 不合法' }
  if (!storeAccess) return { ok: false, message: '技能中心尚未初始化' }
  const skill = storeAccess.getSkills().find((s) => s.id === id)
  if (!skill) return { ok: false, message: `未找到技能：${id}` }

  const entries: { name: string; data: Buffer }[] = []
  const dirOk = !!skill.dir && existsSync(skill.dir)
  const mdInDir = dirOk ? ['SKILL.md', 'skill.md', 'Skill.md'].map((n) => join(skill.dir as string, n)).find((p) => existsSync(p)) : undefined
  if (mdInDir) {
    entries.push({ name: 'SKILL.md', data: readFileSync(mdInDir) })
  } else {
    const fm = ['---', `name: ${skill.name}`, `description: ${skill.desc}`, '---', '', skill.content, ''].join('\n')
    entries.push({ name: 'SKILL.md', data: Buffer.from(fm, 'utf-8') })
  }
  if (dirOk) {
    for (const rel of (skill.files ?? []).slice(0, 40)) {
      // files 是登记清单，逐条按"必须还落在该技能目录内"复核后再读——登记是旧的，盘是现在的
      const root = resolve(skill.dir as string)
      const p = resolve(join(root, rel))
      if (p !== root && !p.startsWith(root + sep)) continue
      try {
        if (existsSync(p) && statSync(p).isFile()) entries.push({ name: rel.replace(/\\/g, '/'), data: readFileSync(p) })
      } catch { /* 读不出的附带文件跳过，不阻塞导出 */ }
    }
  }

  const { dialog } = require('electron') as typeof import('electron')
  const version = (skill.version ?? '').trim()
  const defaultName = `${skill.name || id}${version ? '-' + version : ''}.zip`.replace(/[\\/:*?"<>|]/g, '_')
  const r = await dialog.showSaveDialog({
    title: '导出技能包（zip，可提 PR 收进官方技能注册表）',
    defaultPath: defaultName,
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  })
  if (r.canceled || !r.filePath) return { ok: false, message: '已取消' }
  try {
    mkdirSync(dirname(r.filePath), { recursive: true })
    writeFileSync(r.filePath, createZip(entries))
    return { ok: true, path: r.filePath, message: `已导出（${entries.length} 个文件，store-only 不压缩）` }
  } catch (e) {
    return { ok: false, message: `写入失败：${(e as Error).message}` }
  }
}

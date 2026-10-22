/**
 * 改动检查点：让"敢让 agent 真改文件"成立的那一层。
 *
 * 做法是 copy-on-write 而不是全目录快照：只在一个文件**第一次被改动之前**把它复制进
 * 检查点目录，所以开销只跟"改了多少文件"成正比，跟仓库大小无关。
 *
 * 覆盖范围要如实说清：这里能回滚的是 AgentHub 工具层的文件操作
 * （write_file / replace_in_file / delete_file / move 与 AgentHub 自己的文本落盘）。
 * run_command 与 CLI Agent 自己写的文件不在这条链上，回滚不了——界面必须这么说，
 * 不能给一个"一键回滚"的假安全感。
 */
import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve as resolvePath, relative as relOf, isAbsolute } from 'node:path'
import type { FileChange, CheckpointManifest } from '../shared/types'

const MAX_BACKUP = 8 * 1024 * 1024 // 单文件备份上限，超过就如实标"未备份"
const MAX_DIFF_SIDE = 256 * 1024 // 参与行级 diff 的单侧字节上限
const MAX_DIFF_LEN = 4000

let baseDir = ''

/** 由主进程启动时注入根目录（不注入则检查点整体停用，不影响工具执行） */
export function init(dir: string) {
  baseDir = dir
}

export function enabled() {
  return !!baseDir
}

const manifestPath = (id: string) => join(baseDir, id, 'manifest.json')
const backupPath = (id: string, rel: string) =>
  join(baseDir, id, 'files', `${createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 10)}__${rel.replace(/[\\/]/g, '_').slice(-80)}`)

function safeId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id)
}

function readManifest(id: string): CheckpointManifest | null {
  if (!baseDir || !safeId(id)) return null
  try {
    const p = manifestPath(id)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as CheckpointManifest
  } catch {
    return null
  }
}

function writeManifest(m: CheckpointManifest) {
  if (!baseDir || !safeId(m.id)) return
  try {
    const p = manifestPath(m.id)
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(p, JSON.stringify(m, null, 2), 'utf-8')
  } catch { /* 检查点写不进不该把工具调用打死 */ }
}

/**
 * 一次运行/会话开始时调用：建目录并落空清单。
 * 已存在则复用（返工/续跑属于同一个检查点，回滚应回到任务开始前）。
 */
export async function start(id: string, dir: string): Promise<CheckpointManifest | null> {
  if (!baseDir || !safeId(id)) return null
  const cur = readManifest(id)
  if (cur) return cur
  const m: CheckpointManifest = { id, dir: resolvePath(dir || '.'), createdAt: Date.now(), backed: [], entries: [] }
  try {
    await fs.mkdir(join(baseDir, id, 'files'), { recursive: true })
  } catch {
    return null
  }
  writeManifest(m)
  return m
}

/** 该路径是否已经存过原始副本（决定"这是不是它在本检查点里的第一次改动"） */
function alreadyBacked(m: CheckpointManifest, rel: string): boolean {
  return m.backed.includes(rel)
}

/**
 * 改动前登记：文件此刻存在 → 复制原件进检查点（同一路径只复制第一次的）。
 * 必须在真正写盘之前调用，否则备份的是改坏之后的内容。
 */
export async function beforeChange(id: string, absPath: string): Promise<{ backed: boolean; reason?: string }> {
  const m = readManifest(id)
  if (!m) return { backed: false, reason: '检查点未启用' }
  const rel = relativeOf(m.dir, absPath)
  if (rel === null) return { backed: false, reason: '路径不在本次工作目录内，不纳入检查点' }
  let st
  try {
    st = await fs.stat(absPath)
  } catch {
    return { backed: false } // 新建文件：没有原件可备份，登记为 created 由回滚删除
  }
  if (alreadyBacked(m, rel)) return { backed: true }
  if (st.size > MAX_BACKUP) {
    return { backed: false, reason: `该文件 ${st.size} 字节超过备份上限 ${MAX_BACKUP / 1024 / 1024}MB，未纳入回滚` }
  }
  try {
    const target = backupPath(id, rel)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.copyFile(absPath, target)
    const fresh = readManifest(id) ?? m
    fresh.backed = [...fresh.backed, rel]
    writeManifest(fresh)
    return { backed: true }
  } catch (e) {
    return { backed: false, reason: `备份失败：${(e as Error).message}` }
  }
}

/** 相对工作目录的路径（越界返回 null：不纳入检查点，免得把别处的文件"回滚"没了） */
export function relativeOf(root: string, abs: string): string | null {
  const rel = relOf(resolvePath(root), resolvePath(abs))
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null
  return rel
}

/** 登记一条变更（diff 由调用方算好传入；未备份的如实带 warning） */
export function record(id: string, change: FileChange): void {
  const m = readManifest(id)
  if (!m) return
  m.entries = [...m.entries.filter((e) => e.path !== change.path || e.kind !== change.kind), change]
  writeManifest(m)
}

export function manifestOf(id: string): CheckpointManifest | null {
  return readManifest(id)
}

/** 变更摘要（界面与交付卡片用）：按类型计数 + 未备份清单 */
export function summarize(m: CheckpointManifest | null) {
  if (!m) return { total: 0, created: 0, modified: 0, deleted: 0, moved: 0, unbacked: [] as string[] }
  const c = (k: FileChange['kind']) => m.entries.filter((e) => e.kind === k).length
  return {
    total: m.entries.length,
    created: c('created'),
    modified: c('modified'),
    deleted: c('deleted'),
    moved: c('moved'),
    unbacked: m.entries.filter((e) => e.unbacked).map((e) => e.rel)
  }
}

export interface RollbackResult {
  ok: boolean
  restored: number
  removed: number
  moved: number
  failed: { rel: string; message: string }[]
  message?: string
}

/**
 * 回滚到本检查点开始前的状态：
 * ① 有原件副本的按路径还原（覆盖/删除过的都靠它复原）；
 * ② move 的把目标挪回来源；
 * ③ 新建的文件删掉（它在本检查点之前不存在）。
 * 只动检查点清单里记过的路径，不做任何"顺手清理"。
 */
export async function rollback(id: string): Promise<RollbackResult> {
  const m = readManifest(id)
  const empty: RollbackResult = { ok: false, restored: 0, removed: 0, moved: 0, failed: [] }
  if (!m) return { ...empty, message: '找不到这个检查点（可能已清理，或当时未启用）' }
  const failed: RollbackResult['failed'] = []
  let restored = 0
  let removed = 0
  let moved = 0

  // ② 先把挪走的东西挪回来（否则①还原原件时会在旧位置留一份重复）
  for (const e of m.entries.filter((x) => x.kind === 'moved')) {
    const abs = resolvePath(m.dir, e.rel)
    const from = e.from ? resolvePath(m.dir, e.from) : ''
    try {
      if (from && !existsSync(from) && existsSync(abs)) {
        await fs.mkdir(dirname(from), { recursive: true })
        await fs.rename(abs, from)
        moved++
      }
    } catch (err) {
      failed.push({ rel: e.rel, message: (err as Error).message })
    }
  }

  // ① 还原有备份的原件
  for (const rel of m.backed) {
    const abs = resolvePath(m.dir, rel)
    try {
      const src = backupPath(id, rel)
      if (!existsSync(src)) {
        failed.push({ rel, message: '检查点里没有原件副本' })
        continue
      }
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.copyFile(src, abs)
      restored++
    } catch (err) {
      failed.push({ rel, message: (err as Error).message })
    }
  }

  // ③ 删掉本检查点里新建的文件（有备份的路径说明本来就存在，不能删）
  for (const e of m.entries.filter((x) => x.kind === 'created')) {
    if (m.backed.includes(e.rel)) continue
    const abs = resolvePath(m.dir, e.rel)
    try {
      if (existsSync(abs)) {
        await fs.rm(abs, { force: true })
        removed++
      }
    } catch (err) {
      failed.push({ rel: e.rel, message: (err as Error).message })
    }
  }

  const ok = failed.length === 0
  return {
    ok,
    restored,
    removed,
    moved,
    failed,
    message: ok
      ? `已还原 ${restored} 个文件、撤回 ${moved} 次移动、删除 ${removed} 个新建文件`
      : `部分失败：${failed.map((f) => `${f.rel}（${f.message}）`).join('；')}`
  }
}

/** 清理某检查点的原件副本（保留清单可回看变更列表） */
export async function prune(id: string): Promise<void> {
  if (!baseDir || !safeId(id)) return
  try {
    await fs.rm(join(baseDir, id, 'files'), { recursive: true, force: true })
  } catch { /* 清理失败不影响任何功能 */ }
}

// ---------- 行级 diff ----------

/**
 * 生成给界面看的行级 diff（unified 风格，够短够直读）。
 * 先削公共首尾行，中间用 LCS 逐行比对；任一侧超过 MAX_DIFF_SIDE 或行数过多时
 * 如实返回"差异过大未生成"，不假装算完了。
 */
export function diffLines(oldText: string, newText: string): string {
  if (oldText === newText) return ''
  if (oldText.length > MAX_DIFF_SIDE || newText.length > MAX_DIFF_SIDE) {
    return '（内容过大，未生成行级 diff）'
  }
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length > 4000 || b.length > 4000) return '（行数过多，未生成行级 diff）'
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  const midA = a.slice(s, a.length - e)
  const midB = b.slice(s, b.length - e)
  const out: string[] = []
  if (s > 0) out.push(`  ${a[s - 1]}`.slice(0, 200))
  for (const line of midA) out.push(`- ${line}`)
  for (const line of midB) out.push(`+ ${line}`)
  if (e > 0) out.push(`  ${a[a.length - e]}`.slice(0, 200))
  const text = out.join('\n')
  return text.length > MAX_DIFF_LEN ? text.slice(0, MAX_DIFF_LEN) + '\n…（diff 过长已截断）' : text
}

/** 读旧内容算 diff：只处理文本，二进制/超大文件返回 null（不硬编一个 diff 出来） */
export async function diffOfFile(absPath: string, newText: string): Promise<string | null> {
  try {
    const st = await fs.stat(absPath)
    if (st.size > MAX_DIFF_SIDE) return null
    const oldText = await fs.readFile(absPath, 'utf8')
    if (oldText.includes('\u0000')) return null // 二进制不假装是文本
    return diffLines(oldText, newText)
  } catch {
    return null
  }
}

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
 *
 * 检查点 2.0 补上那半边：工作目录在 git 仓库里时，start() 额外用 git 把当前工作区
 * 拍成一棵 tree 对象（不动用户的 index、不产生提交）；rollback(id, 'git') 按这棵
 * tree 做仓库级还原——命令与 CLI 写的文件同样被还原/清掉。git 快照失败时 COW 检查点
 * 照常工作，只是"更彻底"的那个按钮不出现。
 */
import { promises as fs, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath, relative as relOf, isAbsolute } from 'node:path'
import type { FileChange, CheckpointManifest } from '../shared/types'

const MAX_BACKUP = 8 * 1024 * 1024 // 单文件备份上限，超过就如实标"未备份"
const MAX_DIFF_SIDE = 256 * 1024 // 参与行级 diff 的单侧字节上限
const MAX_DIFF_LEN = 4000
const MAX_BASELINE = 5000 // 基线清单最多记多少个文件
/** 基线/对照时跳过的目录（与工具层搜索同一口径） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'out', 'release'])

/** 目录里的文件清单（相对路径，跳过依赖与版本库；超限如实标注）。导出给产物索引与验收对照用 */
export async function listDirFiles(root: string, limit = MAX_BASELINE): Promise<{ files: string[]; truncated: boolean }> {
  return listFiles(root, limit)
}

async function listFiles(root: string, limit = MAX_BASELINE): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = []
  let truncated = false
  const walk = async (dir: string) => {
    if (out.length >= limit) {
      truncated = true
      return
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(join(dir, e.name))
      } else {
        const rel = relativeOf(root, join(dir, e.name))
        if (rel) out.push(rel)
        if (out.length >= limit) {
          truncated = true
          return
        }
      }
    }
  }
  await walk(root)
  return { files: out, truncated }
}

/**
 * 开工前拍一张目录基线（只记路径清单，不复制内容——内容靠 copy-on-write 的原件副本）。
 * 有了它，交付时才能说"相比开始前新增/消失了哪些文件"，其中包含 run_command
 * 与 CLI 自己造成的改动——回滚清单管不到那些，但对照能看到。
 */
async function captureBaseline(m: CheckpointManifest): Promise<CheckpointManifest> {
  const { files, truncated } = await listFiles(m.dir)
  const next = { ...m, baseline: files, baselineAt: Date.now(), ...(truncated ? { baselineTruncated: true } : {}) }
  writeManifest(next)
  return next
}

/** 当前目录与基线的差集（新增 / 消失）。没有基线时返回 null，界面据此说"没拍成" */
export async function deltaOf(id: string): Promise<{ added: string[]; removed: string[]; baseline: number; truncated?: boolean } | null> {
  const m = readManifest(id)
  if (!m?.baseline) return null
  const now = await listFiles(m.dir)
  const before = new Set(m.baseline)
  const nowSet = new Set(now.files)
  return {
    added: now.files.filter((f) => !before.has(f)),
    removed: m.baseline.filter((f) => !nowSet.has(f)),
    baseline: m.baseline.length,
    ...(m.baselineTruncated || now.truncated ? { truncated: true } : {})
  }
}

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
  // 字符集已排除路径分隔符；纯点串（"." / ".."）是仅剩的目录穿越形态，一并拒绝
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) && !/^\.+$/.test(id)
}

// ---------- git 仓库级快照（检查点 2.0） ----------

/**
 * git 快照字段。shared/types.ts 的 CheckpointManifest 本批不动（类型由后续批次收口），
 * 这里用局部交叉类型扩它：运行时直接挂在 manifest 对象上随 JSON 一起落盘。
 */
export interface CheckpointGitSnapshot {
  /** 仓库根（回滚的半径是整个仓库，不只是检查点的工作目录） */
  top: string
  /** 快照时工作区的 tree 对象（git write-tree 的产物，不产生提交） */
  tree: string
  /** 快照时的 HEAD；空仓库等拿不到时如实记 null */
  head: string | null
  at: number
}
type ManifestWithGit = CheckpointManifest & { git?: CheckpointGitSnapshot }

const GIT_TIMEOUT_MS = 15000
const GIT_SNAPSHOT_PROBE_MS = 5000

/** 跑一条 git 命令（不经 shell，参数数组直传；失败抛错由调用方决定要不要降级） */
function gitRun(top: string, args: string[], env?: NodeJS.ProcessEnv, timeout = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: top, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout))
    )
  })
}

/** 用 GIT_INDEX_FILE 指到临时 index，把当前工作区拍成 tree——完全不碰用户自己的暂存区 */
async function worktreeTree(top: string, env: NodeJS.ProcessEnv): Promise<string> {
  await gitRun(top, ['add', '-A', '--'], env)
  const tree = (await gitRun(top, ['write-tree'], env)).trim()
  if (!tree) throw new Error('git write-tree 返回空')
  return tree
}

/**
 * start() 建完 manifest 后给 git 仓库拍快照。
 * `git add -A` 走临时 index 会尊重 .gitignore：ignored 文件不进快照，回滚也不会碰它们。
 * 任何一步失败都不记 git 字段（界面自然不出现 git 回滚按钮），只留一行日志，
 * 绝不影响 COW 检查点本身——2.0 是增强，不是前置条件。
 */
async function captureGitSnapshot(m: ManifestWithGit): Promise<void> {
  try {
    const top = (await gitRun(m.dir, ['rev-parse', '--show-toplevel'], undefined, GIT_SNAPSHOT_PROBE_MS)).trim()
    if (!top) return
    // 临时 index 放在检查点 files 目录里：prune 清副本时顺手一起清掉，不留垃圾
    const env = { ...process.env, GIT_INDEX_FILE: join(baseDir, m.id, 'files', '.git-index') }
    const tree = await worktreeTree(top, env)
    let head: string | null = null
    try {
      head = (await gitRun(top, ['rev-parse', 'HEAD'])).trim() || null
    } catch {
      head = null // 空仓库没有 HEAD：如实记 null，不影响快照与回滚
    }
    m.git = { top, tree, head, at: Date.now() }
  } catch (e) {
    console.warn(`[checkpoint] git 快照未记录（git 回滚按钮不会出现，COW 检查点不受影响）：${(e as Error).message}`)
  }
}

/** ls-tree -r -z：相对路径 + blob sha（-z 免去路径引号转义，路径里带空格也稳） */
async function lsTree(top: string, tree: string): Promise<{ path: string; sha: string }[]> {
  const out = await gitRun(top, ['ls-tree', '-r', '-z', tree])
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const meta = line.slice(0, tab).split(' ')
      return { sha: meta[2] ?? '', path: line.slice(tab + 1) }
    })
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
    // 半截 manifest（进程在 writeFileSync 中途死掉）会让下次 readManifest 解析失败返回 null
    // → beforeChange 全部"检查点未启用"、回滚能力静默消失。同目录 tmp + rename 原子替换
    // 消掉这个窗口（renameSync 在 Windows 上带替换语义；本函数全程同步，
    // 两次写不会共用同一个 tmp 互相踩）。
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf-8')
    renameSync(tmp, p)
  } catch { /* 检查点写不进不该把工具调用打死 */ }
}

/**
 * 一次运行/会话开始时调用：建目录并落空清单。
 * 已存在则复用（返工/续跑属于同一个检查点，回滚应回到任务开始前）。
 */
export async function start(id: string, dir: string): Promise<CheckpointManifest | null> {
  if (!baseDir || !safeId(id)) return null
  const cur = readManifest(id)
  // 已有清单（返工/续跑）就复用：基线必须停在任务开始前那一刻，不能被新一轮覆盖。
  // git 快照同理不重拍——恢复点始终是第一次开工前，续跑不该把"开始前"往后挪。
  if (cur) return cur.baseline ? cur : captureBaseline(cur)
  const m: CheckpointManifest = { id, dir: resolvePath(dir || '.'), createdAt: Date.now(), backed: [], entries: [] }
  try {
    await fs.mkdir(join(baseDir, id, 'files'), { recursive: true })
  } catch {
    return null
  }
  // git 快照在 COW 清单首次落盘前拍：失败只写一行日志，COW 检查点照常建
  await captureGitSnapshot(m as ManifestWithGit)
  writeManifest(m)
  return captureBaseline(m as ManifestWithGit)
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
  // 本检查点内登记过 created 的路径是任务中途新建的文件：没有"任务开始前的原件"可备份。
  // 若在这里把中间态版本备进 backed，rollback ③ 会因 rel 在 backed 里跳过删除——任务前
  // 不存在的文件回滚后仍残存（内容还是中间态）。判别依据是 entries 里的 created 记录；
  // 不变量：backed 的语义严格等于"任务开始前就存在且已备原件"。record 按 (path, kind) 去重，
  // 同一路径可以同时挂着 created 与 modified 两条 entries，some 只认 created、不受另一条影响。
  if (m.entries.some((e) => e.path === absPath && e.kind === 'created')) return { backed: false }
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
 * 回滚到本检查点开始前的状态。
 * mode 缺省 'tool'：只走 COW 清单，行为与检查点 1.0 完全一致；
 * mode 'git'：按 start() 拍下的 git tree 做仓库级还原（含命令与 CLI 写盘），
 * 与 COW 互相独立——git 模式不改 COW 清单，两种模式可各自调用。
 */
export async function rollback(id: string, mode: 'tool' | 'git' = 'tool'): Promise<RollbackResult> {
  if (mode === 'git') return rollbackGit(id)
  return rollbackTool(id)
}

/** COW 回滚：只动检查点清单里记过的路径，不做任何"顺手清理"。 */
async function rollbackTool(id: string): Promise<RollbackResult> {
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

/**
 * git 回滚（mode='git'）：把仓库工作区恢复到 start() 拍下的那棵 tree。
 * 覆盖面是"全部已跟踪文件"——run_command 与 CLI Agent 写的文件只要落在仓库里、
 * 未被 ignore，就在还原与清理的半径内（这正是它比 COW 回滚彻底的原因）。
 * 不改 COW 清单；不走任何 git 写历史的操作（无 commit/stash/branch）。
 */
async function rollbackGit(id: string): Promise<RollbackResult> {
  const m = readManifest(id) as ManifestWithGit | null
  const empty: RollbackResult = { ok: false, restored: 0, removed: 0, moved: 0, failed: [] }
  if (!m) return { ...empty, message: '找不到这个检查点（可能已清理，或当时未启用）' }
  if (!m.git) return { ...empty, message: '这个检查点没有 git 快照（目录不是 git 仓库或快照失败）' }
  const { top, tree } = m.git
  try {
    // a. 拍"当前"工作区 tree：同一套临时 index 手法，index 文件放系统 tmp（带 id 与时间戳，防并发互踩）
    const env = { ...process.env, GIT_INDEX_FILE: join(tmpdir(), `ahub-git-index-${m.id}-${Date.now()}`) }
    const curTree = await worktreeTree(top, env)
    // b. 两份相对路径清单（git 输出一律 / 分隔）
    const snapList = await lsTree(top, tree)
    const curList = await lsTree(top, curTree)
    // c. 差集：extra = 当前有而快照没有（快照后新建）；missing = 快照有而当前没有（快照后被删）
    const snapSet = new Set(snapList.map((e) => e.path))
    const curSet = new Set(curList.map((e) => e.path))
    const extra = curList.filter((e) => !snapSet.has(e.path))
    const missing = snapList.filter((e) => !curSet.has(e.path))
    // d. 内容恢复：restore 只认"快照 tree 里存在"的路径——被改的还原、被删的（missing 在
    //    source tree 里）一并重建；index 一并被重置到快照。这是设计行为，不是事故，
    //    界面确认弹窗里逐条写明。快照之后才诞生的文件不归它管，落到 extra 由下一步删。
    await gitRun(top, ['restore', `--source=${tree}`, '--worktree', '--staged', '--', '.'])
    const failed: RollbackResult['failed'] = []
    // restored 口径：内容与快照不同的已跟踪文件 + 被重建的 missing（按 blob sha 数出来，不拍脑袋）
    const curSha = new Map(curList.map((e) => [e.path, e.sha]))
    const restored =
      snapList.filter((e) => curSha.get(e.path) !== e.sha).length + missing.length
    // e. 删除快照后新建的文件。不走回收站：extra 文件不在任何 git 对象里，直接删就真没了——
    //    删除前先把原件 copy 进检查点 files 目录留档（命名沿用 backupPath 风格），"删除"仍可人工找回。
    let removed = 0
    for (const { path: rel } of extra) {
      const abs = resolvePath(top, rel)
      // f. 路径安全闸：逃逸出仓库根的路径一律拒绝并计入 failed（正常 ls-tree 不会给出这种路径，闸是兜底）
      if (relativeOf(top, abs) === null) {
        failed.push({ rel, message: '路径逃出仓库根，拒绝删除' })
        continue
      }
      try {
        const archive = backupPath(m.id, `git-extra/${rel}`)
        await fs.mkdir(dirname(archive), { recursive: true })
        await fs.copyFile(abs, archive)
        await fs.rm(abs, { force: true })
        removed++
      } catch (err) {
        failed.push({ rel, message: (err as Error).message })
      }
    }
    const ok = failed.length === 0
    return {
      ok,
      restored,
      removed,
      moved: 0,
      failed,
      message: ok
        ? `已按 git 快照还原全部已跟踪文件、删除 ${removed} 个快照后新建的文件（原件留档在检查点目录）、暂存区已重置`
        : `部分失败：${failed.map((f) => `${f.rel}（${f.message}）`).join('；')}`
    }
  } catch (e) {
    return { ...empty, message: `git 回滚失败：${(e as Error).message}` }
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

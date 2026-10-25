// 应用内更新：请求 GitHub Releases latest 比对版本号 + 下载便携包（下载与校验哈希）+ 暂存 + 一键换入。
// 自动检查 3 天节流（手动不受限）；失败静默不打扰（手动检查时返回错误信息）。
// 换入边界（写进 UI 文案的承诺）：只换便携版的明文 resources/app 目录，绝不碰 AgentHub.exe 与
// Electron 运行时文件；绝不自动触发——"应用更新"永远是用户点按钮才动手（不静默安装是本产品的
// 立身原则）；NSIS/asar 安装版不做一键换入（整包替换安装目录是安装器的事）。哈希校验没通过的
// 包不暂存、更不会换入。
import { app, net } from 'electron'
import { join, dirname, basename } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, unlinkSync, rmSync, renameSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extractZip } from './zip'

const RELEASES_API = 'https://api.github.com/repos/mihayoufamily/agenthub/releases/latest'
const RELEASES_URL = 'https://github.com/mihayoufamily/agenthub/releases/latest'
const THROTTLE_MS = 3 * 24 * 3600 * 1000

/** 便携包资产名：与发布产物的命名约定保持一致（大小写不敏感，防发布时改了大小写就找不到） */
const PORTABLE_ASSET_RE = /AgentHub.*win-x64.*\.zip$/i

export interface UpdateCheckResult {
  current: string
  hasUpdate: boolean
  latest?: string
  releaseUrl?: string
  /** 便携包资产信息（确认弹窗显示文件大小用；发布里没有便携包时缺省） */
  asset?: { name: string; size: number }
  error?: string
}

/** 下载进度事件：total 取资产声明大小（拿不到按 0，界面显示"未知大小"） */
export interface DownloadProgress {
  type: 'progress'
  got: number
  total: number
  pct: number
}
export interface DownloadDone {
  type: 'done'
  path: string
  /** 计算出的 SHA-256（十六进制小写） */
  sha256: string
  /** 与发布说明里的哈希比对结果；发布说明没写哈希时为 false 且带 hashNote */
  verified: boolean
  /** 说明性备注（如"发布说明里没找到哈希，仅显示计算值"） */
  hashNote?: string
  /** 暂存结果：true 表示已解包进 staged/ 待应用（横幅随之亮出「应用更新」）；false/缺省看 stagedNote */
  staged?: boolean
  /** 暂存的版本号（staged/package.json 的 version） */
  stagedVersion?: string
  /** 未暂存的原因（哈希没比对上 / 版本不比当前新 / 解包失败）——如实带给界面，不吞 */
  stagedNote?: string
}
export interface DownloadError {
  type: 'error'
  message: string
}
export type UpdateDownloadEvent = DownloadProgress | DownloadDone | DownloadError

function statePath(): string {
  return join(app.getPath('userData'), 'update-state.json')
}

/** 语义化版本比较（v 前缀可选；解析失败返回 0，即视为无更新，不误报） */
function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map(Number)
  const pb = b.replace(/^v/i, '').split('.').map(Number)
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) return 0
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export async function checkUpdate(manual: boolean): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  if (!manual) {
    try {
      const p = statePath()
      if (existsSync(p)) {
        const st = JSON.parse(readFileSync(p, 'utf-8')) as { lastCheck?: number }
        if (typeof st.lastCheck === 'number' && Date.now() - st.lastCheck < THROTTLE_MS) {
          return { current, hasUpdate: false } // 节流期内静默跳过
        }
      }
    } catch { /* 状态读取失败照常检查 */ }
  }
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { 'User-Agent': 'AgentHub-Updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // lastCheck 只在真拿到响应后写：写在 fetch 之前的话，"没查成"（离线/超时/非 2xx）会被当成
    // "查过了"，一次失败就把自动检查再压 3 天（旧写法正是这样，离线一次 → 3 天不再自动检查）
    try {
      writeFileSync(statePath(), JSON.stringify({ lastCheck: Date.now() }))
    } catch { /* 持久化失败不阻塞检查 */ }
    const data = (await res.json()) as { tag_name?: string; assets?: { name?: string; size?: number }[] }
    const tag = (data.tag_name ?? '').trim()
    // 顺手把便携包资产带给界面（确认弹窗要显示文件大小；同一次响应里就有，不再单独请求）
    const asset = (data.assets ?? []).find((a) => typeof a.name === 'string' && PORTABLE_ASSET_RE.test(a.name))
    return {
      current,
      hasUpdate: cmpVersion(tag, current) > 0,
      latest: tag || undefined,
      releaseUrl: RELEASES_URL,
      ...(asset && typeof asset.size === 'number' ? { asset: { name: asset.name as string, size: asset.size } } : {})
    }
  } catch (e) {
    // 自动检查失败静默；手动检查把错误带回给界面提示
    return { current, hasUpdate: false, error: (e as Error).message }
  }
}

// ---------- 便携包下载（只下载与校验，绝不执行） ----------

/** 下载中标志：重复调用 update:download 直接拒绝，防止两个流写同一个文件 */
let inFlight = false

export function isDownloading(): boolean {
  return inFlight
}

/** 下载落盘目录：<userData>/updates（目录不预建，下载时确保） */
export function updatesDir(): string {
  return join(app.getPath('userData'), 'updates')
}

interface ReleaseAsset {
  name: string
  size: number
  url: string
}

/**
 * 从发布说明（markdown）里抓 sha256：优先在与资产名同段的行里抓（同一行/同一表格行），
 * 抓不到再全文兜底抓第一个 sha256 标记后的 64 位十六进制。发布方排版不可控，这里刻意写宽松；
 * 真抓不到就返回 null，调用方如实标注"发布说明里没找到哈希"，不伪造校验结论。
 */
function extractExpectedHash(body: string, assetName: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes(assetName)) continue
    const m = /sha256[^0-9a-f]{0,24}([0-9a-fA-F]{64})/.exec(line) ?? /([0-9a-fA-F]{64})/.exec(line)
    if (m) return m[1].toLowerCase()
  }
  const fallback = /sha256[\s`]*([0-9a-fA-F]{64})/i.exec(body)
  return fallback ? fallback[1].toLowerCase() : null
}

/**
 * 下载最新 release 的便携包到 <userData>/updates/，流式写盘并增量计算 SHA-256，
 * 完成后与发布说明里的哈希比对；比对通过再把 zip 解包暂存进 staged/（stageDownloadedZip）。
 * 结果经返回值交给 ipc 层推给渲染层（update:event）。
 * 本函数绝不执行下载的文件——换入发生在用户点「应用更新」之后（applyStagedUpdate），不在这里。
 */
export async function downloadPortable(onProgress: (p: DownloadProgress) => void): Promise<UpdateDownloadEvent> {
  if (inFlight) return { type: 'error', message: '已有下载在进行中，请等待完成' }
  inFlight = true
  let dest = ''
  try {
    // 取 release 元数据：与 checkUpdate 同一 URL / UA / 超时（10s 是给元数据请求的，
    // 下面的资产下载刻意不设这个超时——大包按 10s 掐会被误杀）
    const metaRes = await net.fetch(RELEASES_API, {
      headers: { 'User-Agent': 'AgentHub-Updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000)
    })
    if (!metaRes.ok) throw new Error(`获取发布信息失败：HTTP ${metaRes.status}`)
    const data = (await metaRes.json()) as {
      tag_name?: string
      body?: string
      assets?: { name?: string; size?: number; browser_download_url?: string }[]
    }
    const found = (data.assets ?? []).find((a) => typeof a.name === 'string' && PORTABLE_ASSET_RE.test(a.name))
    if (!found || typeof found.browser_download_url !== 'string') {
      return { type: 'error', message: '最新发布里没有找到 win-x64 便携包资产，请前往 Releases 页手动下载' }
    }
    const asset: ReleaseAsset = { name: found.name as string, size: typeof found.size === 'number' ? found.size : 0, url: found.browser_download_url }

    const dir = updatesDir()
    mkdirSync(dir, { recursive: true })
    dest = join(dir, asset.name)

    const hash = createHash('sha256')
    let got = 0
    let lastEmit = 0
    const emit = (force: boolean) => {
      const now = Date.now()
      // 进度节流：chunk 很密，每个都发会把渲染层淹了；120ms 一次足够顺滑（force 给最后收尾用）
      if (!force && now - lastEmit < 120) return
      lastEmit = now
      onProgress({ type: 'progress', got, total: asset.size, pct: asset.size > 0 ? Math.min(100, Math.round((got / asset.size) * 100)) : 0 })
    }
    const res = await net.fetch(asset.url, { headers: { 'User-Agent': 'AgentHub-Updater' } })
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
    await pipeline(
      Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          got += chunk.byteLength
          emit(false)
          yield chunk
        }
      },
      createWriteStream(dest)
    )
    emit(true)

    const sha256 = hash.digest('hex')
    const expected = data.body ? extractExpectedHash(data.body, asset.name) : null
    if (expected === null) {
      return {
        type: 'done',
        path: dest,
        sha256,
        verified: false,
        hashNote: '发布说明里没找到哈希，仅显示计算值（可与 Releases 页公布值自行比对）',
        staged: false,
        stagedNote: '哈希未能与发布说明比对，未暂存（请自行核对后手动换入）'
      }
    }
    if (sha256 !== expected) {
      return {
        type: 'done',
        path: dest,
        sha256,
        verified: false,
        hashNote: '与发布说明的哈希不一致，请勿使用这份文件，建议重新下载',
        staged: false,
        stagedNote: '哈希与发布说明不一致，未暂存'
      }
    }
    // 校验通过才暂存：解包进 staged/ 并核对版本；暂存失败不吞，原因带在 done 事件里如实给界面
    // （下载本身成功了，所以仍是 done——失败的是"暂存"这一步，两件事要分开说）
    const stagedR = stageDownloadedZip(dest, sha256)
    return {
      type: 'done',
      path: dest,
      sha256,
      verified: true,
      ...(stagedR.ok ? { staged: true as const, stagedVersion: stagedR.version } : { staged: false as const, stagedNote: stagedR.error })
    }
  } catch (e) {
    // 半截文件没意义还占地方：best-effort 清掉（清不掉留着也无妨，下次同名下载会覆盖）
    if (dest) {
      try { unlinkSync(dest) } catch { /* 文件被占用等：忽略 */ }
    }
    return { type: 'error', message: (e as Error).message }
  } finally {
    inFlight = false
  }
}

// ---------- 暂存与一键换入（只换便携版明文 resources/app；用户点了按钮才动手） ----------
//
// 两条通路，终点相同（staged 整目录 rename 成 resources/app）：
//  1. 热交换：用户点「应用更新」时当场换。运行中的进程对旧目录的文件句柄在 require 完成后多数
//     已关闭，但只要有一个被占（安全软件扫描、杀毒、资源管理器开着预览），rename 就失败——
//     此时立即恢复现场（.bak 改回原名）并写 pending.json，把这件事交给下次启动；
//  2. 启动早期：index.ts 拿到单实例锁后、建窗口前调 consumePendingUpdate() 补做——此刻旧文件
//     最可能未被锁定。无论成败都删 pending 并 relaunch：成功则新进程加载换入的新包，
//     失败也用当前包正常启动（日志如实留痕）。换入逻辑的任何异常都不许阻止应用启动。

/** 暂存就绪记录：<userData>/updates/staged.json（stagedStatus 读它给横幅亮「应用更新」态） */
export interface StagedUpdate {
  version: string
  sha256: string
  stagedAt: number
}

/** update:apply 的回执：ok=true 时主进程随后自行 relaunch；pending=true 表示这次没能热交换、已挂待启动补做 */
export interface ApplyResult {
  ok: boolean
  relaunch?: boolean
  pending?: boolean
  message?: string
}

function stagedDir(): string {
  return join(updatesDir(), 'staged')
}

function stagedMetaPath(): string {
  return join(updatesDir(), 'staged.json')
}

function pendingPath(): string {
  return join(updatesDir(), 'pending.json')
}

/** 读暂存状态：元数据在而目录没了（已被换入/被清）视为孤儿——顺手清掉元数据，如实返回 null */
export function stagedStatus(): StagedUpdate | null {
  try {
    const p = stagedMetaPath()
    if (!existsSync(p)) return null
    const st = JSON.parse(readFileSync(p, 'utf-8')) as Partial<StagedUpdate>
    if (typeof st.version !== 'string' || !st.version || !existsSync(join(stagedDir(), 'package.json'))) {
      try { unlinkSync(p) } catch { /* 清不掉就留给下次再判 */ }
      return null
    }
    return { version: st.version, sha256: String(st.sha256 ?? ''), stagedAt: Number(st.stagedAt ?? 0) }
  } catch {
    return null
  }
}

/**
 * 把下载完并校验通过的 zip 解包进 <userData>/updates/staged/，写 staged.json。
 * 版本闸：staged/package.json 的 version 必须高于当前版本，不高于就清掉暂存并如实报——
 * 拿旧包盖新包等于把用户降级，没有意义。发布 zip 若把便携目录整体套了一层（如 AgentHub-win-x64/），
 * 识别唯一顶层目录作为应用根；两种布局都收。
 */
function stageDownloadedZip(zipPath: string, sha256: string): { ok: true; version: string } | { ok: false; error: string } {
  const dir = stagedDir()
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const { skipped } = extractZip(readFileSync(zipPath), dir)
    // 官方包应零跳过：有跳过说明包坏了或被动过，整包拒绝——换入的是"整个应用"，一个条目残缺都不行
    if (skipped.length > 0) {
      rmSync(dir, { recursive: true, force: true })
      return { ok: false, error: `包里有 ${skipped.length} 个无法解出的条目（如 ${skipped[0]}），已拒绝暂存` }
    }
    // 顶层包装目录识别：没有顶层 package.json 但唯一顶层目录里有，就把它当应用根
    let root = dir
    if (!existsSync(join(root, 'package.json'))) {
      const top = readdirSync(dir, { withFileTypes: true })
      if (top.length === 1 && top[0].isDirectory() && existsSync(join(dir, top[0].name, 'package.json'))) {
        root = join(dir, top[0].name)
      } else {
        rmSync(dir, { recursive: true, force: true })
        return { ok: false, error: '包里没有 package.json，不是有效的应用包' }
      }
    }
    // 把应用根提升到 staged 顶层：换入时 staged 要整目录 rename 成 resources/app，中间不能再有壳
    if (root !== dir) {
      const lifted = `${dir}.lift`
      renameSync(root, lifted)
      rmSync(dir, { recursive: true, force: true })
      renameSync(lifted, dir)
    }
    let version = ''
    try {
      version = String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { version?: unknown }).version ?? '')
    } catch { /* version 留空，走下面的版本闸如实拒掉 */ }
    if (cmpVersion(version, app.getVersion()) <= 0) {
      rmSync(dir, { recursive: true, force: true })
      return { ok: false, error: `下载的版本（${version || '未知'}）不比当前（${app.getVersion()}）新，已清理暂存` }
    }
    writeFileSync(stagedMetaPath(), JSON.stringify({ version, sha256, stagedAt: Date.now() } satisfies StagedUpdate))
    return { ok: true, version }
  } catch (e) {
    // 半截暂存目录没有意义：best-effort 清掉（清不掉时 stagedStatus 会按缺 package.json 判"无暂存"）
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    return { ok: false, error: `暂存失败：${(e as Error).message}` }
  }
}

/** 一次换入动作的回执（成功带备份目录路径，收尾和日志都要用） */
interface SwapResult {
  ok: boolean
  error?: string
  bak?: string
}

/**
 * 热交换核心：appDir 整目录 rename 成 app.bak-<时间戳>（同一分区 rename，原子）→ staged rename 成 appDir。
 * 只认明文 <…>/resources/app（便携版）：app.asar（NSIS 安装版）与其它形态一律拒绝——asar 换入要
 * 整包替换安装目录，留给安装器。失败立即把 .bak 改回原名恢复现场：旧目录不还原的话重启就是白屏，
 * 宁可如实报失败。
 */
function performSwap(): SwapResult {
  const appDir = app.getAppPath()
  const parent = dirname(appDir)
  if (basename(appDir) !== 'app' || basename(parent) !== 'resources' || appDir.includes('.asar')) {
    return { ok: false, error: '当前不是便携版明文 resources/app 形态，不支持一键换入（安装版请用安装器更新）' }
  }
  if (!existsSync(join(stagedDir(), 'package.json'))) {
    return { ok: false, error: '暂存目录不完整，无法换入' }
  }
  const bak = join(parent, `app.bak-${Date.now()}`)
  try {
    renameSync(appDir, bak)
  } catch (e) {
    return { ok: false, error: `旧 app 目录挪不动（文件被占用）：${(e as Error).message}` }
  }
  try {
    renameSync(stagedDir(), appDir)
  } catch (e) {
    try {
      renameSync(bak, appDir)
    } catch (e2) {
      // 恢复也失败是最坏情况：旧版还完整在 bak 里，如实告诉用户位置，不伪装成"已恢复"
      return { ok: false, error: `换入失败（${(e as Error).message}），且恢复现场也失败（${(e2 as Error).message}）；旧版本完整保存在 ${bak}` }
    }
    return { ok: false, error: `新包换入失败（文件被占用）：${(e as Error).message}` }
  }
  return { ok: true, bak }
}

/** 交换成功后的收尾：staged.json 已失效（目录被挪走）清掉；.bak 只留最近一个；写一条结果记录 */
function afterSwapOk(bak: string, version: string): void {
  try { unlinkSync(stagedMetaPath()) } catch { /* 本来就没有就算了 */ }
  // .bak 只保留一个（刚生成的这个，即换入前的版本）：更旧的没有回滚价值，白占双份体积
  try {
    for (const ent of readdirSync(dirname(bak))) {
      if (/^app\.bak-/.test(ent) && ent !== basename(bak)) {
        try { rmSync(join(dirname(bak), ent), { recursive: true, force: true }) } catch { /* 被占用就留给下次 */ }
      }
    }
  } catch { /* 列不出目录就跳过清理，不影响换入结果 */ }
  // 结果记录：应用过什么版本、何时——排查"我到底跑的哪版"时是唯一凭据
  try {
    writeFileSync(join(updatesDir(), 'applied.json'), JSON.stringify({ version, appliedAt: Date.now() }))
  } catch { /* 记录失败不影响换入本身 */ }
}

/**
 * 用户点「应用更新」（唯一调用方是 ipc 的 update:apply，而那个通道只被按钮打到——绝不自动触发）：
 * 立即尝试热交换。成功 → 返回 relaunch=true，由 ipc 层延迟片刻后 app.relaunch()+quit；
 * 失败（典型：运行中的进程还占着旧目录里的文件）→ 写 pending.json，下次启动早期自动补做。
 */
export function applyStagedUpdate(): ApplyResult {
  if (!app.isPackaged) {
    return { ok: false, message: '开发模式不支持一键更新（源码目录没有可换入的 resources/app）' }
  }
  const st = stagedStatus()
  if (!st) return { ok: false, message: '没有已就绪的更新，请先完成下载' }
  const r = performSwap()
  if (r.ok && r.bak) {
    afterSwapOk(r.bak, st.version)
    console.log(`[updater] 已换入 v${st.version}，即将重启生效（旧版备份：${r.bak}）`)
    return { ok: true, relaunch: true }
  }
  // 热交换走不通：挂 pending，把同一件事交给"最可能没被锁定"的启动早期（index.ts 消费）。
  // staged 目录原样保留——pending 消费时换的就是它。
  try {
    mkdirSync(updatesDir(), { recursive: true })
    writeFileSync(pendingPath(), JSON.stringify({ version: st.version, at: Date.now() }))
  } catch (e) {
    return { ok: false, message: `${r.error}；且待启动标记写不进（${(e as Error).message}），请关闭应用后手动替换 resources/app` }
  }
  return { ok: false, pending: true, message: `${r.error}。将在下次启动时自动应用` }
}

/**
 * 启动早期消费 pending.json（index.ts 在拿到单实例锁后、建窗口前调用）：
 * 存在则执行与 applyStagedUpdate 相同的交换——此刻旧文件最可能未被锁定。
 * 无论成败都删 pending（失败重试无意义：文件还锁着的话再试还是败；删掉让用户下次能重新点按钮），
 * 然后一律 relaunch：成功换入则新进程加载新包；换入失败也用当前包正常启动，日志如实留痕。
 * 本函数整体自守：任何异常都不外抛、不 quit——绝不让换入问题阻止应用启动。
 * 返回 true 表示确实有 pending 且已处理（调用方应立即 return，别再往下建窗口——本进程马上要退）。
 */
export function consumePendingUpdate(): boolean {
  let pending: { version?: string } | null = null
  try {
    const p = pendingPath()
    if (!existsSync(p)) return false
    pending = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string }
  } catch {
    // 标记读不出来（截断/手改）：它代表的事没法可靠执行，删掉照常启动
    try { unlinkSync(pendingPath()) } catch { /* noop */ }
    return false
  }
  if (!pending) return false
  let swap: SwapResult = { ok: false, error: '未知错误' }
  try {
    swap = performSwap()
  } catch (e) {
    swap = { ok: false, error: (e as Error).message }
  }
  try { unlinkSync(pendingPath()) } catch { /* 删不掉也只是下次启动再判一次（staged 没了会按失败走） */ }
  if (swap.ok && swap.bak) {
    afterSwapOk(swap.bak, pending.version ?? '')
    console.log(`[updater] 启动早期已完成待定换入（v${pending.version ?? '未知'}），重启后加载新包`)
  } else {
    console.log(`[updater] 待定换入失败（${swap.error}），按当前包正常启动`)
  }
  // 复用兼容模式重启的等锁重试（AGENTHUB_RELAUNCH）：旧实例退出与单实例锁释放存在竞态
  process.env.AGENTHUB_RELAUNCH = '1'
  app.relaunch()
  app.quit()
  return true
}

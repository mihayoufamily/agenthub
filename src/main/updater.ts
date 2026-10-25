// 应用内更新：请求 GitHub Releases latest 比对版本号 + 可选下载便携包（只下载与校验哈希）。
// 自动检查 3 天节流（手动不受限）；失败静默不打扰（手动检查时返回错误信息）。
// 不做自动安装/替换：下载的文件只落盘校验，绝不执行——安装/替换由用户自己动手。
import { app, net } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
 * 完成后与发布说明里的哈希比对。结果经返回值交给 ipc 层推给渲染层（update:event）。
 * 本函数绝不执行下载的文件——安装/替换由用户自己动手，这是写进 UI 文案的承诺。
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
        hashNote: '发布说明里没找到哈希，仅显示计算值（可与 Releases 页公布值自行比对）'
      }
    }
    return {
      type: 'done',
      path: dest,
      sha256,
      verified: sha256 === expected,
      ...(!sha256 || sha256 !== expected ? { hashNote: '与发布说明的哈希不一致，请勿使用这份文件，建议重新下载' } : {})
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

// ============ GitHub raw 的镜像回退通道（official-models / market 共用） ============
//
// 事实（2026-10-27 实测）：raw.githubusercontent.com 在国内网络大面积不可达（本机 TLS 握手
// 直挂），api.github.com 通常可达（不同基础设施，本机 200）。凡是从官方注册表仓库拉数据的
// 功能（官方模型清单、技能市场）都走这里：raw 先试，失败自动换 api contents 接口（base64
// 解码），再不行由调用方回退到随应用打包的内置快照。
// 安全口径：镜像只改变"从哪读字节"，不绕过任何校验——技能包的 sha256、注册表的逐条闸都照过。
import { Buffer } from 'node:buffer'

/** raw.githubusercontent.com URL → api.github.com contents URL（含 ?ref=分支）。非 raw 官方域返回 null */
export function apiUrlFromRaw(rawUrl: string): string | null {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/(refs\/)?(heads\/)?([A-Za-z0-9._-]+)\/(.+)$/.exec(rawUrl)
  if (!m) return null
  return `https://api.github.com/repos/${m[1]}/${m[2]}/contents/${m[6]}?ref=${m[5]}`
}

/** api contents 响应体 → 原文件文本（encoding=base64 才收；其他形态如实拒绝） */
export function decodeApiContents(body: string): string | null {
  try {
    const j = JSON.parse(body) as { encoding?: string; content?: string }
    if (j.encoding !== 'base64' || typeof j.content !== 'string') return null
    return Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf-8')
  } catch {
    return null
  }
}

export interface MirrorFetchText {
  ok: boolean
  text?: string
  /** 实际生效的通道：raw=原样；api=镜像（raw 失败换道）；none=两条都失败 */
  via: 'raw' | 'api' | 'none'
  message?: string
}

/** 文本拉取（json 清单用）：raw → api 镜像。ETag/304 语义只在 raw 通道有效（api 不带缓存协商） */
export async function fetchTextWithMirror(
  url: string,
  netFetch: (u: string, init?: RequestInit) => Promise<Response>,
  init?: RequestInit
): Promise<MirrorFetchText> {
  // ① raw 原样
  try {
    const res = await netFetch(url, init)
    if (res.ok) return { ok: true, text: await res.text(), via: 'raw' }
  } catch { /* 掉到镜像 */ }
  // ② api 镜像（api.github.com 国内可达性远好于 raw；Content-Type json）
  const api = apiUrlFromRaw(url)
  if (api) {
    try {
      const res = await netFetch(api, {
        headers: { 'User-Agent': 'AgentHub-Updater', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(12000)
      })
      if (res.ok) {
        const text = decodeApiContents(await res.text())
        if (text != null) return { ok: true, text, via: 'api' }
      }
    } catch { /* 掉到调用方兜底 */ }
  }
  return { ok: false, via: 'none', message: 'raw 与 api.github.com 镜像均不可达' }
}

/** 二进制拉取（技能包 zip 用）：raw → api 镜像（contents 接口 base64 还原字节） */
export async function fetchBufferWithMirror(
  url: string,
  netFetch: (u: string, init?: RequestInit) => Promise<Response>
): Promise<{ ok: boolean; buf?: Buffer; via: 'raw' | 'api' | 'none'; message?: string }> {
  try {
    const res = await netFetch(url, { headers: { 'User-Agent': 'AgentHub-Updater' }, signal: AbortSignal.timeout(30000) })
    if (res.ok && res.body) {
      const chunks: Buffer[] = []
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
      return { ok: true, buf: Buffer.concat(chunks), via: 'raw' }
    }
  } catch { /* 掉到镜像 */ }
  const api = apiUrlFromRaw(url)
  if (api) {
    try {
      const res = await netFetch(api, {
        headers: { 'User-Agent': 'AgentHub-Updater', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30000)
      })
      if (res.ok) {
        const j = JSON.parse(await res.text()) as { encoding?: string; content?: string; size?: number }
        if (j.encoding === 'base64' && typeof j.content === 'string') {
          // 单文件上限 1MB（contents 接口的硬限制，技能包 <2MB 且 zip 压缩后远小于此；超限如实报错不静默）
          if ((j.size ?? 0) > 1024 * 1024) return { ok: false, via: 'api', message: `api 镜像单文件上限 1MB（该文件 ${(j.size! / 1024).toFixed(0)}KB）` }
          return { ok: true, buf: Buffer.from(j.content.replace(/\n/g, ''), 'base64'), via: 'api' }
        }
      }
    } catch { /* 掉到调用方兜底 */ }
  }
  return { ok: false, via: 'none', message: 'raw 与 api.github.com 镜像均不可达' }
}

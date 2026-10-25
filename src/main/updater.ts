// 应用内更新检查：请求 GitHub Releases latest 比对版本号。
// 自动检查 3 天节流（手动不受限）；失败静默不打扰（手动检查时返回错误信息）。
// 不做自动下载/安装：发现新版本仅提示，由用户前往 Releases 页自行下载。
import { app, net } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const RELEASES_API = 'https://api.github.com/repos/mihayoufamily/agenthub/releases/latest'
const RELEASES_URL = 'https://github.com/mihayoufamily/agenthub/releases/latest'
const THROTTLE_MS = 3 * 24 * 3600 * 1000

export interface UpdateCheckResult {
  current: string
  hasUpdate: boolean
  latest?: string
  releaseUrl?: string
  error?: string
}

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
    const data = (await res.json()) as { tag_name?: string }
    const tag = (data.tag_name ?? '').trim()
    return { current, hasUpdate: cmpVersion(tag, current) > 0, latest: tag || undefined, releaseUrl: RELEASES_URL }
  } catch (e) {
    // 自动检查失败静默；手动检查把错误带回给界面提示
    return { current, hasUpdate: false, error: (e as Error).message }
  }
}

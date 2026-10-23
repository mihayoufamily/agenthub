/**
 * 窗口导航裁决（纯函数，逻辑层可测）。主进程三个 handler（新窗口 / 导航 / 重定向）共用它，
 * 免得规则在 Electron 回调里写三份、改一漏二。
 * 现状：渲染层没有任何 target=_blank 或 window.open（全量 grep 0 命中），这里是防退化兜底。
 */
export type NavAction = 'allow' | 'external' | 'block'

/** 本应用自己的页面：生产是 resources/app/dist/renderer 下的 file://，开发是 VITE_DEV_SERVER_URL */
function isOwnPage(devServerUrl: string | null, parsed: URL): boolean {
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl)
      if (parsed.protocol === dev.protocol && parsed.host === dev.host) return true
    } catch {
      return false
    }
  }
  // file:// 只认渲染产物目录：拿 new URL() 归一化后的 pathname（不用原始串），
  // 因为解析会折叠 `..`/`%2e%2e`/`..\` 这类回退段——绕过串归一后 marker 就落到 renderer 之外了。
  // 反斜杠先换成正斜杠（Windows 的 `..\..\` 形态）。残留：便携版安装根不可预知（纯函数不读 fs/electron），
  // 故仍以 marker 结尾匹配——能落到 <任意根>/resources/app/dist/renderer/ 的前提是攻击者已可写构建产物目录。
  if (parsed.protocol !== 'file:') return false
  const norm = parsed.pathname.replace(/\\/g, '/')
  return /(^|\/)resources\/app\/dist\/renderer\/[^/]/i.test(norm)
}

export function navDecision(url: string, devServerUrl: string | null): NavAction {
  const u = (url ?? '').trim()
  if (!u) return 'block'
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return 'block'
  }
  const p = parsed.protocol
  if (p === 'file:') return isOwnPage(devServerUrl, parsed) ? 'allow' : 'block'
  if (p === 'http:' || p === 'https:') return isOwnPage(devServerUrl, parsed) ? 'allow' : 'external'
  // 其余协议（javascript:、data:、file 之外的自定义 scheme）一律不进窗口、也不丢给系统
  return 'block'
}

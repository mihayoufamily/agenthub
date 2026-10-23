/**
 * 窗口导航裁决（纯函数，逻辑层可测）。主进程三个 handler（新窗口 / 导航 / 重定向）共用它，
 * 免得规则在 Electron 回调里写三份、改一漏二。
 * 现状：渲染层没有任何 target=_blank 或 window.open（全量 grep 0 命中），这里是防退化兜底。
 */
export type NavAction = 'allow' | 'external' | 'block'

/** 本应用自己的页面：生产是 resources/app/dist/renderer 下的 file://，开发是 VITE_DEV_SERVER_URL */
function isOwnPage(url: string, devServerUrl: string | null): boolean {
  if (devServerUrl) {
    try {
      const target = new URL(url)
      const dev = new URL(devServerUrl)
      if (target.protocol === dev.protocol && target.host === dev.host) return true
    } catch {
      return false
    }
  }
  // file:// 只认渲染产物目录，C:\Windows\... 这类本地文件不该在窗口里加载
  return /^file:\/\/\/[^?#]*\/resources\/app\/dist\/renderer\//i.test(url)
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
  if (p === 'file:') return isOwnPage(u, devServerUrl) ? 'allow' : 'block'
  if (p === 'http:' || p === 'https:') return isOwnPage(u, devServerUrl) ? 'allow' : 'external'
  // 其余协议（javascript:、data:、file 之外的自定义 scheme）一律不进窗口、也不丢给系统
  return 'block'
}

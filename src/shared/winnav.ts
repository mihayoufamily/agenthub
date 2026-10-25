/**
 * 窗口导航裁决（纯函数，逻辑层可测）。主进程三个 handler（新窗口 / 导航 / 重定向）共用它，
 * 免得规则在 Electron 回调里写三份、改一漏二。
 * 现状：渲染层没有任何 target=_blank 或 window.open（全量 grep 0 命中），这里是防退化兜底。
 * 本模块刻意零 import（不引 electron / node:fs / node:url），真实安装根由调用方算好后
 * 以普通路径字符串传进来（ownRootPath 形参），保持纯函数与可测性。
 */
export type NavAction = 'allow' | 'external' | 'block'

/**
 * 把路径折成「正斜杠、去掉 . 与 ..、丢掉空段、小写」的段数组。
 * 反斜杠先折叠（Windows 的 `..\..\`），`..` 手工弹栈——因为分隔符本身被编码掉时
 * （`%2e%2e%2f`、`..%2f`、`%2e%2e%5c`）整串在 URL 里只是一个段，new URL() 无从折叠，
 * 必须解码到真实分隔符后自己算。drive 号当成普通段：`/D:/a/../../b` → `D:/b`，逃逸看得见。
 */
function toSegments(path: string): string[] {
  const out: string[] = []
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg.toLowerCase())
  }
  return out
}

/** target 是否严格落在 root 之内（相等只算目录本身，不算页面，故要求更长） */
function isInside(target: string[], root: string[]): boolean {
  if (root.length === 0 || target.length <= root.length) return false
  for (let i = 0; i < root.length; i++) {
    if (target[i] !== root[i]) return false
  }
  return true
}

/** 本应用自己的页面：开发是 VITE_DEV_SERVER_URL 同源，生产是真实 renderer 根目录内的 file:// */
function isOwnPage(
  devServerUrl: string | null,
  parsed: URL,
  ownRootPath?: string | null
): boolean {
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl)
      if (parsed.protocol === dev.protocol && parsed.host === dev.host) return true
    } catch {
      return false
    }
  }
  if (parsed.protocol !== 'file:') return false
  // 带主机名的 file: 在 Windows 上就是 UNC（\\主机\共享\…）——内容来自攻击者指定的远程共享，
  // 共享名也由攻击者摆布，绝不该被当成本机自己的页面。锚定根虽然也会把它挡在外面，
  // 这关仍要显式留着：它不依赖调用方传参，无锚点的弱回退路径同样受保护。
  if (parsed.host !== '') return false
  // 必须解码再折回退段：new URL() 只折叠它「看得见」的点段（`..`、`%2e%2e`），
  // 分隔符一起编码掉的 `..%2f..%2f`、`%2e%2e%5c` 它一个字都不动，解完码才是 ../../。
  // 畸形 % 序列会让 decodeURIComponent 抛 URIError（Chromium 也不会把它解成路径）→ 按不是自己页面处理。
  let decoded: string
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    return false
  }
  const target = toSegments(decoded)
  // 锚点（ownRootPath）缺失就一律不放行——fail-closed。生产三个调用点（src/main/index.ts 的新窗口 /
  // will-navigate / will-redirect）都带着由 __dirname 推出的真实 renderer 根（fixes-check 还有
  // "每个调用点都传真锚"的源码不变量钉着），所以无锚只可能来自测试或异常路径。
  // 原先那条"无锚退回 resources/app/dist/renderer marker 结尾匹配"的弱回退已删除：它是实测漏点——
  // `file:////evil.example\share\resources\app\dist\renderer\…` 这类远程共享串的 marker 就摆在
  // pathname 里，marker 认不出来照样放行。与其无锚时猜，不如全拦：宁可错拦一个测试，不放行一个远端。
  // 非字符串/空串同样走这里收口，且这一路刻意**不抛异常**：本函数是在 Electron 的
  // setWindowOpenHandler / will-navigate / will-redirect 回调里同步调用的，
  // 抛出会从导航回调里逸出（与"崩了也要把人救活"的取向相反），而放行是更坏的那一头，所以返回 block。
  if (typeof ownRootPath !== 'string' || ownRootPath === '') return false
  return isInside(target, toSegments(ownRootPath))
}

export function navDecision(
  url: string,
  devServerUrl: string | null,
  ownRootPath?: string | null
): NavAction {
  const u = (url ?? '').trim()
  if (!u) return 'block'
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return 'block'
  }
  const p = parsed.protocol
  if (p === 'file:') return isOwnPage(devServerUrl, parsed, ownRootPath) ? 'allow' : 'block'
  if (p === 'http:' || p === 'https:') return isOwnPage(devServerUrl, parsed, ownRootPath) ? 'allow' : 'external'
  // 其余协议（javascript:、data:、file 之外的自定义 scheme）一律不进窗口、也不丢给系统
  return 'block'
}

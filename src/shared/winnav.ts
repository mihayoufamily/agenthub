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
  // ownRootPath 传了就以它为准，且**只**以它为准：折不出根段（空串）、或根本不是字符串
  // （脏调用方递进来一个数字/对象/数组）都一律不放行——fail-closed。非字符串这一路刻意**不抛异常**：
  // 本函数是在 Electron 的 setWindowOpenHandler / will-navigate / will-redirect 回调里同步调用的，
  // 抛出会从导航回调里逸出（与"崩了也要把人救活"的取向相反），而放行是更坏的那一头，所以返回 block。
  // 两种情况都不悄悄退回下面那条宽松的 marker 回退。
  if (ownRootPath !== undefined && ownRootPath !== null) {
    if (typeof ownRootPath !== 'string') return false
    return isInside(target, toSegments(ownRootPath))
  }
  // 弱回退（ownRootPath 缺失：单元测试、老调用点）：退回 marker 结尾匹配。
  // 已知弱点：<任意根>/resources/app/dist/renderer/ 下的文件会被放行——生产调用点必须传真实根。
  return /(^|\/)resources\/app\/dist\/renderer\/[^/]/i.test('/' + target.join('/'))
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

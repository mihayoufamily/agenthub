/**
 * 关闭请求的裁决与"是否有任务在跑"的跨模块状态。
 *
 * 为什么单独拆出来：Ctrl+W 之前会静默退出应用，根因是 Electron 默认菜单的 close 加速键
 * 直接关掉唯一窗口 → window-all-closed → app.quit()，中间没有任何拦截点。
 * 现在关闭请求先过 decideClose()：空闲 → 缩到系统托盘（应用常驻，退出走托盘/菜单栏）；
 * 正在执行工作流时必须问用户（默认后台继续运行）；已确认退出才真关。
 *
 * busy 由渲染层上报（ipc.ts 的 app:setBusy）——主进程不自己猜引擎在不在跑。
 */
export interface CloseInput {
  busy: boolean
  /** 用户已经确认过要退出（托盘"退出"或确认框选"仍然退出"） */
  quitting: boolean
}

export type CloseDecision = 'quit' | 'ask' | 'hide'

/** 纯函数，便于断言 */
export function decideClose(s: CloseInput): CloseDecision {
  if (s.quitting) return 'quit'
  if (s.busy) return 'ask'
  return 'hide'
}

let busy = false
let quitting = false
/** busy 变化的监听（index.ts 用来刷新托盘 tooltip；不引入 index↔ipc 环） */
let busyListener: ((busy: boolean) => void) | null = null

export function onBusyChange(cb: (busy: boolean) => void) {
  busyListener = cb
}

export function setBusy(v: boolean) {
  if (busy === v) return
  busy = v
  try {
    busyListener?.(v)
  } catch { /* 监听器异常不阻塞状态更新 */ }
}

export function isBusy() {
  return busy
}

export function setQuitting(v = true) {
  quitting = v
}

export function isQuitting() {
  return quitting
}

export function decideCloseNow(): CloseDecision {
  return decideClose({ busy, quitting })
}

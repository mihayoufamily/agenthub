/**
 * 关闭请求的裁决与"是否有任务在跑"的跨模块状态。
 *
 * 为什么单独拆出来：Ctrl+W 之前会静默退出应用，根因是 Electron 默认菜单的 close 加速键
 * 直接关掉唯一窗口 → window-all-closed → app.quit()，中间没有任何拦截点。
 * 现在关闭请求先过 decideClose()：正在执行工作流时必须问用户（默认后台继续运行）。
 *
 * busy 由渲染层上报（ipc.ts 的 app:setBusy）——主进程不自己猜引擎在不在跑。
 */
export interface CloseInput {
  busy: boolean
  /** 用户已经确认过要退出（托盘"退出"或确认框选"仍然退出"） */
  quitting: boolean
}

export type CloseDecision = 'quit' | 'ask'

/** 纯函数，便于断言 */
export function decideClose(s: CloseInput): CloseDecision {
  if (s.quitting) return 'quit'
  if (s.busy) return 'ask'
  return 'quit'
}

let busy = false
let quitting = false

export function setBusy(v: boolean) {
  busy = v
}

export function isBusy() {
  return busy
}

export function setQuitting(v = true) {
  quitting = v
}

export function decideCloseNow(): CloseDecision {
  return decideClose({ busy, quitting })
}

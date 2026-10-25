/**
 * 进入工作站的过渡动画该不该播（纯判定，逻辑层跑真代码断言）。
 *
 * 根因不是观感：大字层原先没有状态位，`Workbench` 每次重挂载都重播一遍——而重启恢复、
 * 切任务、切会话都会让 `App.tsx` 重新挂载它。所以"挡事"的是**每次重挂载都播**，
 * 不是动画本身。只有用户真切模式那三类触发动作才该播一次。
 */
export const ENTRY_CAUSES = ['enter-mode', 'hotkey', 'sidebar-switch'] as const
export type EntryCause = (typeof ENTRY_CAUSES)[number]

/** 只有白名单里的触发动作才播；`null`/`undefined`（纯重挂载）与任何脏值都不播 */
export function shouldPlayEntry(cause: unknown): cause is EntryCause {
  return typeof cause === 'string' && (ENTRY_CAUSES as readonly string[]).includes(cause)
}

/** cause 在 Workbench 挂载消费进站时**立刻清空**（不等播完）：它的职责是防止重挂载重播，
 *  不是控制大字层何时消失——清位若挂在定时器上，窗口被遮挡时被 Chromium 钳到秒级，
 *  位不清的窗口期里切会话/切任务重挂载就会重播（2026-10-25 真机回归实测）。
 *  本常量只用于大字层的收场时长，与新时间线对齐 */
export const ENTRY_TOTAL_MS = 780

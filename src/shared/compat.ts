/**
 * 沙箱/GPU 崩溃降级的纯决策层（Task 6：可见 + 可改）。
 *
 * 为什么单拆一个 shared 模块：`src/main/index.ts` 里那条"崩溃两次就悄悄关掉 Chromium 沙箱"
 * 的阶梯，原先把**判断**和**执行**混在事件回调里，逻辑层测不到（起不了 electron），
 * 用户看到的只有一个莫名出现的黄徽章或者干脆什么都没有。判断放这里之后：
 *  - 主进程只执行动作（弹窗 / relaunch / 报错退出），不自己决定策略；
 *  - 徽章措辞也在这里（渲染进程不能 import 主进程模块，共享层是双方唯一能共用的地方）；
 *  - 两条都在 verify/fixes-check.mjs 里逐条断言。
 *
 * 约定：本文件不 import electron / node:fs —— 共享层要保持能被子进程与渲染进程同时引用。
 */

/** 用户对"要不要替我关掉沙箱"的三种选择（config.sandboxFallback，Task 2 已进迁移链） */
export type SandboxFallbackPolicy = 'auto' | 'ask' | 'off'

/** 决策结果：none=还没轮到沙箱这一级；fail=不降级、按启动失败处理 */
export type FallbackAction = 'none' | 'downgrade-silent' | 'ask' | 'fail'

/** 实际关掉过什么（事实，不是配置） */
export interface CompatFacts {
  noSandbox: boolean
  noGpu: boolean
}

/** app:compat 的返回形状（徽章与设置页都读它） */
export interface CompatState extends CompatFacts {
  policy: SandboxFallbackPolicy
  /** 降级来源说明：sandbox / gpu / sandbox(forced)（空串＝什么都没关） */
  reason: string
}

/** 第几次"窗口显示前崩溃"才进入沙箱这一级（第 1 次先试软件渲染） */
export const SANDBOX_CRASH_THRESHOLD = 2

/** 验证专用启动开关：ipc.ts 的整份导入通道与这里的强制降级门控共用同一个字符串 */
export const VERIFY_SWITCH = '--ahub-verify'

/** 真机验证用 env：与 VERIFY_SWITCH 同时成立才把状态呈现为"已降级" */
export const FORCE_SANDBOX_CRASH_ENV = 'AGENTHUB_FORCE_SANDBOX_CRASH'

/**
 * 策略归一：脏值（手改 config.json、旧版本没写过这个键、大小写不对）一律回 auto。
 * 取向是"不让老机器因为一次脏数据突然开不了机"，也不是"突然变成每次都要点确认"。
 */
export function normalizePolicy(policy: unknown): SandboxFallbackPolicy {
  return policy === 'auto' || policy === 'ask' || policy === 'off' ? policy : 'auto'
}

/**
 * 降级阶梯上"沙箱这一级"该做什么。
 *
 * 只看两件事：崩了几次、用户选了什么策略。**不看**当前是否已经开着沙箱——
 * 那条由调用方挡（已经在兼容模式里还继续崩，重启用同样的参数只会原地打转）。
 */
export function decideFallback(policy: unknown, crashCount: unknown): FallbackAction {
  const n = typeof crashCount === 'number' && Number.isFinite(crashCount) ? crashCount : 0
  if (n < SANDBOX_CRASH_THRESHOLD) return 'none'
  const p = normalizePolicy(policy)
  if (p === 'off') return 'fail'
  if (p === 'ask') return 'ask'
  return 'downgrade-silent'
}

/**
 * 徽章文案：**按实际关掉了什么出，不按配置里写了什么出**。
 * 配置着 auto 而机器一切正常时不该有徽章（那就是噪音）；真把沙箱关了却藏进设置页也不该。
 * 返回 null = 不渲染。
 */
export function compatBadgeText(facts: unknown): string | null {
  if (!facts || typeof facts !== 'object') return null
  const f = facts as Partial<CompatFacts>
  const sandbox = f.noSandbox === true
  const gpu = f.noGpu === true
  if (!sandbox && !gpu) return null
  if (sandbox && gpu) return '兼容模式 · 渲染沙箱与硬件加速都已关闭'
  return sandbox ? '兼容模式 · 渲染沙箱已关闭' : '兼容模式 · 硬件加速已关闭'
}

/**
 * 强制"已降级"呈现的门控判定（真机断言要能看到徽章，可又不能让用户双击就中招）。
 * 两道闸同时成立才算数：验证启动参数 --ahub-verify **且** env 恰好是 '1'。
 * 少一道都不开：正常双击的 argv 里没有 --ahub-verify，残留的环境变量也就不起作用。
 */
export function forcedCompatCrashEnabled(argv: unknown, envValue: unknown): boolean {
  if (envValue !== '1') return false
  return Array.isArray(argv) && argv.includes(VERIFY_SWITCH)
}

/**
 * 三条策略的界面文案：一处定义，设置页的选择器与首次降级的提示都从这里取。
 * 每条都要说清两件事——它做什么、它的代价是什么（尤其 off：不是"更安全"，是可能开不了机）。
 */
export const SANDBOX_FALLBACK_OPTIONS: readonly { value: SandboxFallbackPolicy; label: string; desc: string }[] = [
  {
    value: 'auto',
    label: '自动降级',
    desc: '渲染进程连续崩溃后直接以兼容模式重启（关闭 Chromium 沙箱），起来后非阻塞提示一次。代价：渲染进程隔离等级下降，但不会被启动流程拦住。'
  },
  {
    value: 'ask',
    label: '每次问我',
    desc: '每次要关沙箱前先弹窗确认，你选「不重启」就按启动失败退出。代价：崩溃时需要有人点一下才起得来，无人值守的机器上会卡在这里。'
  },
  {
    value: 'off',
    label: '不自动降级',
    desc: '绝不擅自关闭 Chromium 沙箱：沙箱被安全软件破坏的机器会直接报「启动失败」，要自己运行 start-compat-mode.cmd 进兼容模式。代价很直白——这台机器可能就开不了机。'
  }
]

/** 按值取选项（设置页与提示文案都用它，避免到处 find(...) 各写一遍兜底） */
export function sandboxFallbackOption(policy: unknown) {
  const p = normalizePolicy(policy)
  return SANDBOX_FALLBACK_OPTIONS.find((o) => o.value === p) ?? SANDBOX_FALLBACK_OPTIONS[0]
}

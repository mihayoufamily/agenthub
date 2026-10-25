/**
 * 工作流引擎的纯数据变换（并发修复后的抽离 + 任务队列 + 计划态 CLI 补偿）。
 *
 * 为什么单独成文件：verify 的逻辑层套件要能直接加载被测代码做快照测试，而 workflow.ts
 * 长在渲染层（zustand + IPC 桥），构建产物里没有它。这里只放"给定输入必得输出"的
 * 函数与常量——不 import zustand / electron / 渲染层任何东西（类型从 './types' 来），
 * main 构建（out/shared/engine-transitions.js）就能被 verify/engine-check.mjs 直接
 * require。workflow.ts 里的接线（谁在什么时候调这些函数）不在该构建里，由 tsc
 * typecheck 保证——套件头部如实写了这条边界。
 */
import type { RoleCard, ReviewGate, Stage, TaskStatus, WorkflowRun } from './types'

/** 三角色（渲染层 lib/rolePrompts 里有同名类型，两边结构一致、按结构兼容）；纯函数层不反向依赖渲染层，故在此重复声明 */
export type WorkflowRole = 'planner' | 'executor' | 'reviewer'

/** 卡片角色里参与"续跑推断"的三个（delivery/system 卡不参与） */
const RESUME_ROLES: readonly string[] = ['planner', 'executor', 'reviewer']

// ============ 状态口径：忙 / 终态 / 出口卡 ============

/**
 * 引擎忙状态（runBusy 的判定口径）：占用位语义只有三个——准备中、执行中、审核角色正在跑。
 * 抽成常量是为了让快照测试能拿它核对"终态与忙态互斥"（原先这份列表散在 runBusy 与
 * makeWatchdog 两处，谁改了一份漏一份没有测试拦得住）。
 */
export const BUSY_STATUSES: readonly TaskStatus[] = ['preparing', 'running', 'waiting_review']

/**
 * 真终态：任务到此为止。队列自动开始只在它们之后发生。
 * 刻意不含 waiting_user（挂门 = 等人决定，不是跑完）与 interrupted（重启后状态未核对，
 * 不该替用户接着烧额度）。
 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'completed', 'failed', 'cancelled', 'rework_limit', 'timeout', 'token_limit', 'budget_limit'
]

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/**
 * 是否有"出口卡"：七个终态在 TaskView 里各有一张收尾操作卡（新建/继续修改/导出），
 * 让用户停在死任务界面时看得见出路。interrupted 也有卡，但那是"从中断处继续"的续跑卡
 * ——任务没结束，不算出口，所以不在这里。
 */
export function hasExitCard(status: TaskStatus): boolean {
  return isTerminal(status)
}

// ============ 带门起链 / 快照还原 ============

/**
 * 带门起链的统一形状：清门 + 置 running + 设 stage，一次 set 完成。
 * 为什么必须是"同一次"：runBusy 把带门的 run 当空闲（门挂出时引擎确实空转等人），
 * 若先清门再置 running 分两步写，中间那一拍既无门又非 running 的矛盾态会让
 * 切换/新建的守卫失效；反过来先置 running 后清门则可能把门残留到链上。
 */
export function clearGateForRun(run: WorkflowRun, status: 'running', stage: Stage | null): WorkflowRun {
  return { ...run, status, stage, gate: undefined }
}

/** 单角色重跑前捕获的状态快照（rerunRole 捕获、收尾原样还原） */
export interface RunSnapshot {
  status: WorkflowRun['status']
  stage: Stage | null
  gate: ReviewGate | undefined
}

/**
 * 快照还原：单角色重跑只是"借引擎位补一张卡"，收尾把任务放回重跑前的样子——
 * waiting_user 带门 → 门重新挂上让人拿最新结论再决定；completed → 仍 completed。
 * 不还原则 run 永停 running，runBusy 恒真，切换/新建/删除全被空占，只能手动 stop。
 */
export function restoreSnapshot(run: WorkflowRun, snap: RunSnapshot): WorkflowRun {
  return { ...run, status: snap.status, stage: snap.stage, ...(snap.gate ? { gate: snap.gate } : { gate: undefined }) }
}

// ============ 中断续跑：该从谁接着跑 ============

export interface ResumePick {
  /** 接着跑的角色：planner/executor 直接起链；role 为 reviewer 时看 producedRole 分流 */
  role: WorkflowRole
  /** 最后一张相关卡是否真产出过结论（done 且结论非空） */
  produced: boolean
  /** 产出过结论的那张卡的角色；没有任何产出时为 null。重挂门要从它取验收清单 */
  producedRole: WorkflowRole | null
  /** 最后一张相关卡（可能没产出）；一张相关卡都没有时为 null */
  card: RoleCard | null
}

/**
 * 中断续跑的"该从谁接"推断：看**最后一张**三角色卡。
 * - 真产出过结论（done 且结论非空）：从链上它的下一环接着跑，不重放已发生的调用
 *   （重放 = 重复扣额度、重复写文件）；reviewer 已产出 → 仍返回 reviewer，由调用方
 *   重挂确认门把那份结论摊给人决定，绝不自作主张交付或返工。
 * - 最后一张卡还 streaming/error 或结论为空：那一步等于没发生，返回该角色**重跑它**，
 *   而不是拿更早的旧结论往下跳（旧口径会拿上一轮的审核卡重挂门，门里的结论是旧的）。
 * - 一张相关卡都没有：从头跑规划。
 * cards 不是数组（脏数据 / IPC 形状变了）时返回 null：调用方按"从规划起跑"兜底，
 * 这里不猜、也不抛——续跑入口抛异常会把任务卡死在中断态。
 */
export function pickNextResumeRole(cards: RoleCard[]): ResumePick | null {
  if (!Array.isArray(cards)) return null
  const last = [...cards].reverse().find((c) => RESUME_ROLES.includes(c.role))
  if (!last) return { role: 'planner', produced: false, producedRole: null, card: null }
  const produced = last.status === 'done' && (last.conclusion ?? '').trim().length > 0
  if (!produced) return { role: last.role as WorkflowRole, produced: false, producedRole: null, card: last }
  const producedRole = last.role as WorkflowRole
  // planner 产出 → 接执行；executor 产出 → 接审核；reviewer 产出 → 停在 reviewer（重挂门）
  const role: WorkflowRole = producedRole === 'planner' ? 'executor' : 'reviewer'
  return { role, produced: true, producedRole, card: last }
}

// ============ 任务队列（排队制并行：单执行循环不变，终态后自动接队） ============

/**
 * 队列里的一条任务。边界（都是刻意的，UI 与注释同一口径）：
 * - 队列只存在内存里，不持久化——重启即清空，绝不假装"排过的任务还在"；
 * - 只带文本附件的**拼好的正文**，图片附件不入队（图片走 base64/dataUrl，又大又不能落盘）；
 * - 计划态单次开关在入队那一刻定格，出队时不再看当前开关。
 */
export interface QueuedTask {
  goal: string
  attachmentText?: string
  planNextTask?: boolean
  queuedAt: number
}

/** 队列上限：排队是"省得人盯着等"，不是无限挂单——超了就明说，不悄悄丢 */
export const MAX_QUEUE = 10

export function enqueue(queue: QueuedTask[], item: QueuedTask): { queue: QueuedTask[]; rejected?: string } {
  if (!Array.isArray(queue)) return { queue: [], rejected: '队列数据异常，已重置' }
  if (queue.length >= MAX_QUEUE) {
    return { queue, rejected: `队列已满（最多 ${MAX_QUEUE} 个），等当前任务结束后再排` }
  }
  return { queue: [...queue, item] }
}

/** FIFO 取队头；空队列返回 null（调用方不接队） */
export function takeNext(queue: QueuedTask[]): { item: QueuedTask; queue: QueuedTask[] } | null {
  if (!Array.isArray(queue) || queue.length === 0) return null
  const [item, ...rest] = queue
  return { item, queue: rest }
}

// ============ 计划态对 CLI 角色的补偿（拦不住就透明） ============

/**
 * 计划态的扩展字段：挂在 run 上、随 runs/ 落盘（JSON 往返会原样保留未知字段）。
 * 为什么不进 types.ts 的 WorkflowRun：那是 main/preload/renderer 三方共用的状态机类型，
 * 这组字段只服务于计划态审计这一个渲染层特性，加进去要三方对齐——用交叉类型扩展，
 * 读取侧经 planAuditOf 显式收窄，主进程当普通 JSON 存，不需要知道这些字段存在。
 */
export interface PlanCliDelta {
  added: string[]
  removed: string[]
  /** 任一侧清单触到上限被截断：差集只是部分，界面必须说明，不给"没有变化"的假象 */
  truncated?: boolean
}

export interface PlanAuditedRun extends WorkflowRun {
  /** 计划态起跑前拍的产物目录清单（相对路径）；只有三角色里有 CLI 角色时才拍 */
  planStartFiles?: string[]
  planStartFilesTruncated?: boolean
  /** 计划门挂出时：planStartFiles 与当前清单的路径差集 */
  planCliDelta?: PlanCliDelta
}

export const PLAN_FILES_CAP = 2000
export const PLAN_DELTA_CAP = 200

/** 读取侧收窄：run 上可能带着审计字段（老记录没有则 undefined） */
export function planAuditOf(run: WorkflowRun): PlanAuditedRun {
  return run as PlanAuditedRun
}

/** 存启动清单（上限 PLAN_FILES_CAP 条，超了截断并记标记） */
export function withPlanStartFiles(run: WorkflowRun, files: string[], truncated: boolean): WorkflowRun {
  const ext: PlanAuditedRun = {
    ...run,
    planStartFiles: files.slice(0, PLAN_FILES_CAP),
    planStartFilesTruncated: truncated || files.length > PLAN_FILES_CAP
  }
  return ext
}

/**
 * 存计划门挂出时的路径差集（各上限 PLAN_DELTA_CAP 条 + 截断标记）。
 * delta 为 null（没有基线，比如三角色里没有 CLI 角色）时保持 run 上没有该字段。
 */
export function withPlanCliDelta(
  run: WorkflowRun,
  delta: { added: string[]; removed: string[] } | null,
  truncated: boolean
): WorkflowRun {
  if (!delta) return run
  const over = delta.added.length > PLAN_DELTA_CAP || delta.removed.length > PLAN_DELTA_CAP
  const ext: PlanAuditedRun = {
    ...run,
    planCliDelta: {
      added: delta.added.slice(0, PLAN_DELTA_CAP),
      removed: delta.removed.slice(0, PLAN_DELTA_CAP),
      ...(truncated || over ? { truncated: true as const } : {})
    }
  }
  return ext
}

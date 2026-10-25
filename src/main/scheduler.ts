/**
 * 定时任务的调度内核（main 侧，纯计算 + 注入式 IO）。
 *
 * 为什么单独成文件：due 判定/下次触发时间/保存闸门都是"给定输入必得输出"的纯函数，
 * 混在 ipc.ts 里就只能在真机上靠手点验证。这里不 import electron 任何东西——
 * tick 里只做纯计算 + 调 fire 回调，IPC/webContents 的接线全部留在 ipc.ts（调用方注入）。
 * 与 shared/engine-transitions 的分野：这是 main 侧模块，不参与渲染层构建，但纯函数
 * 同样可被逻辑层直接加载断言。
 */
import type { AppConfig, TaskSchedule } from '../shared/types'

/** tick 周期：30 秒——分钟级精度的调度不需要更细，也不值得为它常驻更密的定时器 */
export const SCHEDULE_TICK_MS = 30_000

/** interval 型的最小间隔（分钟）：挡"每 1 分钟烧一次钱"的误配，UI 与闸门同一口径 */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 5

/** 定时任务条数上限：调度是省人力的工具，不是无限挂单器 */
export const SCHEDULES_MAX = 50

/** HH:mm 解析（本地时区的小时分钟；严格 0-23 / 0-59，前导零可选） */
export function parseHHmm(time: string): { h: number; m: number } | null {
  if (typeof time !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return { h, m: min }
}

/** 本地时区的日期键（YYYY-MM-DD）："今天跑过没有"只看日期，不看时刻 */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 某天的 HH:mm 是否已到（含整分那一刻）：getHours/getMinutes 全是本地时区值 */
function timeReached(now: Date, h: number, m: number): boolean {
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)
}

/**
 * 到点判定（纯函数，逻辑层可直接断言）。返回 true 时调用方负责 fire 并把 lastRunAt 写为当时刻。
 *
 * 三种频率的边界（与 UI 文案"不补跑"同一口径）：
 * - daily：本地时区当天 time 已过（≥ 整分）且 lastRunAt 不在今天。23:59 的任务在
 *   [23:59, 24:00) 的任一 tick 触发一次；跨过午夜后 dayKey 翻新，不会再触发。
 *   当天内晚开（09:00 的任务 10:00 才开应用）仍会触发一次——这不算"补跑"；
 *   前一天错过的隔天不再补。
 * - weekly：now 的星期几 == weekday（0=周日…6=周六，Date.getDay() 口径）且 time 已过
 *   且 lastRunAt 不在今天。判定只看"今天星期几"，不依赖连续 tick：周日 23:50 建的
 *   "每周日 23:45"任务周一不会补触发（dayKey 已翻新）。
 * - interval：基线 = lastRunAt ?? createdAt（从未跑过则从创建时刻起算，不是"保存后立刻跑"），
 *   now - 基线 ≥ intervalMinutes 分钟即到点。闰日/周边界对它无意义（纯时长比较）。
 * - 闰日：daily 每天都算，weekly 按星期几算，二者都不引用"几月几日"，2/29 无特判。
 *
 * 形状不合法（time 不是 HH:mm、kind 未知、interval 非法、weekday 越界）一律返回 false：
 * 闸门挡不住的手改 config.json 不该让调度器抛异常，宁可静默不触发。
 */
export function isDue(s: TaskSchedule, now: Date, lastRunAt?: number): boolean {
  if (!s || typeof s !== 'object' || s.enabled !== true) return false
  if (s.kind === 'interval') {
    const mins = typeof s.intervalMinutes === 'number' && s.intervalMinutes >= SCHEDULE_MIN_INTERVAL_MINUTES ? s.intervalMinutes : NaN
    if (!Number.isFinite(mins)) return false
    const base = typeof lastRunAt === 'number' && Number.isFinite(lastRunAt)
      ? lastRunAt
      : typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : NaN
    if (!Number.isFinite(base)) return false
    return now.getTime() - base >= mins * 60_000
  }
  const t = parseHHmm(s.time ?? '')
  if (!t) return false
  // 今天已经跑过：一次 tick 里 fire 后 lastRunAt 落盘，下一个 tick 的 30 秒内不会重复触发
  const last = typeof lastRunAt === 'number' && Number.isFinite(lastRunAt) ? new Date(lastRunAt) : null
  if (last && dayKey(last) === dayKey(now)) return false
  if (s.kind === 'daily') return timeReached(now, t.h, t.m)
  if (s.kind === 'weekly') {
    if (typeof s.weekday !== 'number' || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) return false
    if (now.getDay() !== s.weekday) return false
    return timeReached(now, t.h, t.m)
  }
  return false
}

/**
 * 下次触发时刻（本地时区毫秒时间戳；纯函数，UI 展示与逻辑层测试用）。
 * 返回 null = 形状不合法（同 isDue 的脏数据口径），调用方按"不显示下次时间"处理。
 * 口径：daily/weekly 已过点的今天不重算（今天跑过或已过点都顺延到下一个匹配日）；
 * interval 返回 基线 + 间隔（已过点说明该触发了，调用方 tick 很快会追上）。
 */
export function nextFireAt(s: TaskSchedule, from: Date, lastRunAt?: number): number | null {
  if (!s || typeof s !== 'object' || s.enabled !== true) return null
  if (s.kind === 'interval') {
    const mins = typeof s.intervalMinutes === 'number' && s.intervalMinutes >= SCHEDULE_MIN_INTERVAL_MINUTES ? s.intervalMinutes : NaN
    if (!Number.isFinite(mins)) return null
    const base = typeof lastRunAt === 'number' && Number.isFinite(lastRunAt)
      ? lastRunAt
      : typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : null
    return base === null ? null : base + mins * 60_000
  }
  const t = parseHHmm(s.time ?? '')
  if (!t) return null
  const last = typeof lastRunAt === 'number' && Number.isFinite(lastRunAt) ? new Date(lastRunAt) : null
  const ranToday = !!last && dayKey(last) === dayKey(from)
  if (s.kind === 'daily') {
    // 今天没跑过且还没到点 → 今天；否则从明天起算（逐日推进不跨月误算， setDate 自己管进位）
    if (!ranToday && !timeReached(from, t.h, t.m)) return atTime(from, 0, t.h, t.m)
    return atTime(from, 1, t.h, t.m)
  }
  if (s.kind === 'weekly') {
    if (typeof s.weekday !== 'number' || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) return null
    // 从今天起最多看 8 天（一定覆盖到下一个匹配的星期几）
    for (let k = 0; k < 8; k++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + k)
      if (d.getDay() !== s.weekday) continue
      if (k === 0 && (ranToday || !timeReached(from, t.h, t.m))) continue
      return d.getTime() + t.h * 3_600_000 + t.m * 60_000
    }
    return null
  }
  return null
}

/** from 当天偏移 k 天后的 HH:mm 时刻（本地时区；setDate 处理月/年进位与闰日） */
function atTime(from: Date, k: number, h: number, m: number): number {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + k, h, m).getTime()
}

/** 读路径的形状闸门（schedule:list 用）：滤掉手改 config.json 塞进来的 null/非对象，不让设置页解引用炸掉 */
export function sanitizeSchedules(raw: unknown): TaskSchedule[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is TaskSchedule => !!s && typeof s === 'object')
}

/**
 * 保存整表时的逐条校验闸门（schedule:set 用，mcp:set 的 partitionMcpServers 同一口径）：
 * 界面提交的永远是整表，主进程按条校验后只落合格的那半，不合格的**点名拒收**（rejected 回界面），
 * 不做静默过滤。校验项：id/name/goal 非空、kind 合法、daily/weekly 的 time 必须是 HH:mm、
 * weekly 的 weekday 0-6、interval 的 intervalMinutes ≥5。超上限的整条拒收并说明。
 */
export function partitionSchedules(list: unknown): { kept: TaskSchedule[]; rejected: { id: string; message: string }[] } {
  const kept: TaskSchedule[] = []
  const rejected: { id: string; message: string }[] = []
  if (!Array.isArray(list)) return { kept, rejected: [{ id: '#', message: 'schedule:set 只接受数组' }] }
  for (let i = 0; i < list.length; i++) {
    const s = list[i] as Partial<TaskSchedule> | null
    const at = (s && typeof s.id === 'string' && s.id.trim()) ? s.id.trim() : `#${i}`
    if (!s || typeof s !== 'object') {
      rejected.push({ id: at, message: '不是对象' })
      continue
    }
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    const goal = typeof s.goal === 'string' ? s.goal.trim() : ''
    if (!name) { rejected.push({ id: at, message: '名称为空' }); continue }
    if (!goal) { rejected.push({ id: at, message: '目标为空' }); continue }
    if (s.kind !== 'daily' && s.kind !== 'weekly' && s.kind !== 'interval') {
      rejected.push({ id: at, message: `频率类型不合法：${String(s.kind)}` }); continue
    }
    if (s.kind === 'daily' || s.kind === 'weekly') {
      if (!parseHHmm(s.time ?? '')) { rejected.push({ id: at, message: `时间格式应为 HH:mm：${String(s.time ?? '')}` }); continue }
    }
    if (s.kind === 'weekly' && (typeof s.weekday !== 'number' || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6)) {
      rejected.push({ id: at, message: 'weekly 需要 0-6 的星期（0=周日）' }); continue
    }
    if (s.kind === 'interval' && (typeof s.intervalMinutes !== 'number' || s.intervalMinutes < SCHEDULE_MIN_INTERVAL_MINUTES)) {
      rejected.push({ id: at, message: `间隔分钟数需 ≥${SCHEDULE_MIN_INTERVAL_MINUTES}` }); continue
    }
    if (kept.length >= SCHEDULES_MAX) {
      rejected.push({ id: at, message: `已到 ${SCHEDULES_MAX} 条上限，这一条没有保存` })
      continue
    }
    kept.push({
      id: at.slice(0, 64),
      name: name.slice(0, 40),
      goal: goal.slice(0, 8000),
      kind: s.kind,
      ...(s.kind !== 'interval' ? { time: String(s.time).trim() } : {}),
      ...(s.kind === 'weekly' ? { weekday: s.weekday } : {}),
      ...(s.kind === 'interval' ? { intervalMinutes: s.intervalMinutes as number } : {}),
      enabled: s.enabled !== false,
      ...(s.planFirst === true ? { planFirst: true } : {}),
      createdAt: typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
      ...(typeof s.lastRunAt === 'number' && Number.isFinite(s.lastRunAt) ? { lastRunAt: s.lastRunAt } : {})
    })
  }
  return { kept, rejected }
}

export interface SchedulerDeps {
  /** 读当前配置（每 tick 现读，不缓存：设置页保存后下一 tick 即生效） */
  getConfig: () => AppConfig | undefined
  /** 到点通知：ipc.ts 注入 `webContents.send('scheduler:fire', s)`；窗口不可用时事件自然丢弃 */
  fire: (s: TaskSchedule) => void
  /** lastRunAt 写盘（store.setTaskSchedules；渲染层不回写，lastRunAt 由 main 侧记账） */
  setSchedules: (list: TaskSchedule[]) => void
}

let timer: ReturnType<typeof setInterval> | null = null

/**
 * 启动 30 秒 tick。registerIpc 每次启动只调一次（init 里有防重入闸）。
 * 错过不补跑：应用没开着就是没开——tick 不在，判定与触发都不存在；能补的只有
 * "当天内晚开"那一档（见 isDue 注释），这是刻意保留的边界而非遗漏。
 */
export function init(deps: SchedulerDeps): void {
  if (timer) return
  const tick = () => {
    let schedules: TaskSchedule[]
    try {
      const cfg = deps.getConfig()
      schedules = sanitizeSchedules(cfg?.taskSchedules)
    } catch {
      return // 配置读不到（磁盘被占等）这一拍跳过，下一 tick 再试，不掀掉主进程
    }
    if (schedules.length === 0) return
    const now = new Date()
    const fired: TaskSchedule[] = []
    const next = schedules.map((s) => {
      if (isDue(s, now, s.lastRunAt)) {
        fired.push(s)
        return { ...s, lastRunAt: now.getTime() }
      }
      return s
    })
    if (fired.length === 0) return
    // 先记账再 fire：fire 是异步链的起点，先落 lastRunAt 才不会在下个 tick 因记账未达而重复触发
    try {
      deps.setSchedules(next)
    } catch (e) {
      console.log(`[scheduler] lastRunAt 写盘失败，本拍不触发（防重复）：${(e as Error).message}`)
      return
    }
    for (const s of fired) {
      try {
        deps.fire(s)
      } catch (e) {
        console.log(`[scheduler] 触发事件发送失败（定时任务「${s.name}」）：${(e as Error).message}`)
      }
    }
  }
  timer = setInterval(tick, SCHEDULE_TICK_MS)
}

/** 停表（目前仅测试与收尾用途；应用生命周期内调度器常驻） */
export function stop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

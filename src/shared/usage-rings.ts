import type { LedgerUsageRow } from './types'

/**
 * 把调用账本折成环数据（纯函数，逻辑层逐条断言）。
 *
 * 诚实边界先说清：账本只留最近 2000 条，且 CLI 多数不上报 usage，所以"总计"只代表
 * **ledger 可见调用**。未上报的那些按调用次数单列一格，**绝不折算成 token**——折了就是编一个数给用户看。
 */
export interface RingSlice {
  key: string
  label: string
  tokens: number
  share: number
  calls: number
  noUsage: number
}

export interface Rings {
  /** 内圈：按接入方（harness）合并 */
  inner: RingSlice[]
  /** 外圈：按 harness × 模型 拆分 */
  outer: RingSlice[]
  totalTokens: number
  unreportedCalls: number
}

function fold(rows: LedgerUsageRow[], keyOf: (r: LedgerUsageRow) => string, labelOf: (r: LedgerUsageRow) => string): RingSlice[] {
  const m = new Map<string, RingSlice>()
  for (const r of rows) {
    const k = keyOf(r)
    let s = m.get(k)
    if (!s) {
      s = { key: k, label: labelOf(r), tokens: 0, share: 0, calls: 0, noUsage: 0 }
      m.set(k, s)
    }
    s.tokens += r.tokens ?? 0
    s.calls += r.calls ?? 0
    s.noUsage += r.noUsage ?? 0
  }
  const list = [...m.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls)
  const total = list.reduce((a, s) => a + s.tokens, 0)
  // 零 token 不参与归一：否则一个没有任何 usage 的接入方会分到 0 宽度的扇区，看着像"有但极小"
  for (const s of list) s.share = total > 0 && s.tokens > 0 ? s.tokens / total : 0
  return list
}

export function buildRings(rows: LedgerUsageRow[]): Rings {
  const real = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object') as LedgerUsageRow[]
  const inner = fold(real, (r) => r.harness || '（未知接入方）', (r) => r.harness || '（未知接入方）')
  const outer = fold(real, (r) => `${r.harness}|${r.model}`, (r) => r.model || '（未上报模型名）')
  return {
    inner,
    outer,
    totalTokens: real.reduce((a, r) => a + (r.tokens ?? 0), 0),
    unreportedCalls: real.reduce((a, r) => a + (r.noUsage ?? 0), 0)
  }
}

/**
 * 环形扇区的 SVG 路径（零依赖手写，不引图表库）。
 * 外弧顺时针、内弧逆时针，各自拆成两段：`span` 接近整圆时起终点几乎重合，
 * 单段弧会被浏览器按"零角度"画不出来。
 */
export function donutPath(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number): string {
  const span = Math.min(Math.max(a1 - a0, 0), Math.PI * 2 - 1e-6)
  const p = (r: number, a: number): string => `${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`
  const large = span > Math.PI ? 1 : 0
  const mid = a0 + span / 2
  const end = a0 + span
  const outer = `A${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, mid)} A${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, end)}`
  const inner = `A${rInner} ${rInner} 0 ${large} 0 ${p(rInner, mid)} A${rInner} ${rInner} 0 ${large} 0 ${p(rInner, a0)}`
  return `M${p(rOuter, a0)} ${outer} L${p(rInner, end)} ${inner} Z`
}

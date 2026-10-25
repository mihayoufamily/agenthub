// 单价表覆盖：内置表是手写快照，价格会变、也未必收录你在用的模型。
// 这里存"你自己填的单价"，优先于内置表，并带着填写日期一起显示——
// 让界面能说清"这个金额按的是哪份价"，而不是拿一个不知年份的数字冒充准确。
import type { ModelPricing } from './pricing'
import type { PriceOverride, RejectedEntry } from './types'

export type { PriceOverride }

/**
 * `prices:set` 的落盘闸门（复审 finding：与 hooks/mcp 同一类静默丢）。
 * 旧实现在 handler 里 `.filter(pattern 非空).slice(0, 100)`：空模式行与第 101 条都是无声消失。
 * 现在：**空模式一律不生效但点名回界面**（空模式的正则会匹配所有模型，绝不能留），
 * **负数/非数字单价同样点名拒绝**——旧写法 `Number(x) || 0` 会原样放行 -5（负数是真值），
 * 负费用让"超预算即停"的闸永不触发；缺失/非数字也不静默猜成 0。
 * 合法条目一律保留、不再截断（上限交给界面新增那一关）。
 */
export function partitionPriceOverrides(list: unknown): { kept: PriceOverride[]; rejected: RejectedEntry[] } {
  const incoming: unknown[] = Array.isArray(list) ? list : []
  const kept: PriceOverride[] = []
  const rejected: RejectedEntry[] = []
  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i]
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    const pattern = typeof obj?.pattern === 'string' ? obj.pattern.trim() : ''
    if (!pattern) {
      rejected.push({ id: pattern || `#${i + 1}`, message: '每行都要填匹配模式；空模式会匹配所有模型，所以这一条不生效也没有保存' })
      continue
    }
    // 单价必须是 ≥ 0 的有限数：负价放行会让预算闸永不触发，非数字/缺失也不静默改值——
    // 沿用空模式的口径，进 rejected 点名回界面，让用户改完再存。
    const input = Number(obj?.input)
    const output = Number(obj?.output)
    if (!(Number.isFinite(input) && input >= 0) || !(Number.isFinite(output) && output >= 0)) {
      rejected.push({ id: pattern, message: '单价必须是 ≥ 0 的数字（负价会让预算闸永不触发，空/非数字也不猜成 0），这一条没有保存' })
      continue
    }
    kept.push({
      pattern,
      input,
      output,
      ...(obj?.cacheHit != null ? { cacheHit: Number(obj.cacheHit) || 0 } : {}),
      asOf: String(obj?.asOf ?? '').slice(0, 40)
    })
  }
  return { kept, rejected }
}

let overrides: PriceOverride[] = []

/** 由主进程载入 / 渲染层从 IPC 拿到后注入（两侧共用同一个 estimateCost，口径才不会分叉） */
export function configurePriceOverrides(list: PriceOverride[] | undefined | null) {
  overrides = Array.isArray(list) ? list.filter((o) => o && typeof o.pattern === 'string' && o.pattern.trim()) : []
}

export function priceOverrides(): PriceOverride[] {
  return overrides
}

/** 编译后的覆盖（正则非法的条目跳过：坏条目不该把整个计价打挂） */
export function overridePricings(): ModelPricing[] {
  const out: ModelPricing[] = []
  for (const o of overrides) {
    try {
      out.push({ pattern: new RegExp(o.pattern, 'i'), input: o.input, output: o.output, ...(o.cacheHit != null ? { cacheHit: o.cacheHit } : {}) })
    } catch {
      continue
    }
  }
  return out
}

/** 该模型是否被覆盖表命中（界面据此标"你填写的价"还是"内置价"） */
export function overrideOf(modelId: string | undefined): PriceOverride | null {
  if (!modelId) return null
  for (const o of overrides) {
    try {
      if (new RegExp(o.pattern, 'i').test(modelId)) return o
    } catch {
      continue
    }
  }
  return null
}

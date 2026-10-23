// 单价表覆盖：内置表是手写快照，价格会变、也未必收录你在用的模型。
// 这里存"你自己填的单价"，优先于内置表，并带着填写日期一起显示——
// 让界面能说清"这个金额按的是哪份价"，而不是拿一个不知年份的数字冒充准确。
import type { ModelPricing } from './pricing'
import type { PriceOverride } from './types'

export type { PriceOverride }

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

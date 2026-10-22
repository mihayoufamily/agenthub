// ============ 模型单价与上下文窗口对照表（main/renderer 共用） ============
// 单价单位：元 / 1M tokens（输入、输出；cacheHit 为缓存命中输入价）。
// 只收录有官方公开价格的模型；查不到 = 界面只显示 token 不折算金额（不编造价格）。

import type { UsageInfo } from './types'

export interface ModelPricing {
  /** 匹配 modelId 的正则（忽略大小写） */
  pattern: RegExp
  /** 元 / 1M tokens */
  input: number
  output: number
  /** 缓存命中输入价（可选） */
  cacheHit?: number
}

const PRICING: ModelPricing[] = [
  // DeepSeek 官方价格（2025 年公布价）
  { pattern: /deepseek-reasoner/i, input: 4, output: 16, cacheHit: 1 },
  { pattern: /deepseek-chat/i, input: 1, output: 8, cacheHit: 0.1 },
  { pattern: /deepseek/i, input: 1, output: 8, cacheHit: 0.1 }
]

/** 查某模型的单价；没有公开价格返回 null（界面据此只显示 token） */
export function pricingOf(modelId: string | undefined): ModelPricing | null {
  if (!modelId) return null
  return PRICING.find((p) => p.pattern.test(modelId)) ?? null
}

/** 折算单次用量费用（元）；无单价数据返回 null */
export function estimateCost(modelId: string | undefined, usage: UsageInfo | undefined): number | null {
  const p = pricingOf(modelId)
  if (!p || !usage) return null
  const completion = usage.completion ?? 0
  const prompt = usage.prompt ?? Math.max((usage.tokens ?? 0) - completion, 0)
  if (!prompt && !completion) return null
  const cost = (prompt / 1_000_000) * p.input + (completion / 1_000_000) * p.output
  return Math.round(cost * 1e6) / 1e6
}

/** 格式化金额：小额用 4 位小数，大额 2 位 */
export function fmtCost(yuan: number | null | undefined): string {
  if (yuan == null) return '—'
  if (yuan === 0) return '¥0'
  if (yuan < 0.01) return `¥${yuan.toFixed(4)}`
  return `¥${yuan.toFixed(2)}`
}

/** 上下文窗口对照表（tokens；用于上下文用量条分母） */
const CONTEXT_WINDOWS: { pattern: RegExp; size: number }[] = [
  { pattern: /deepseek/i, size: 64 * 1024 },
  { pattern: /claude/i, size: 200 * 1024 },
  { pattern: /gpt-5|o1|o3/i, size: 400 * 1024 },
  { pattern: /gpt-4o|gpt-4\.1/i, size: 128 * 1024 },
  { pattern: /step/i, size: 128 * 1024 },
  { pattern: /qwen/i, size: 128 * 1024 },
  { pattern: /gemini/i, size: 1024 * 1024 },
  { pattern: /glm/i, size: 128 * 1024 }
]

const DEFAULT_CONTEXT_WINDOW = 32 * 1024

/** 推断上下文窗口：显式配置优先，其次内置表，最后默认 32K */
export function contextWindowOf(modelId: string | undefined, explicit?: number): number {
  if (explicit && explicit > 0) return explicit
  if (modelId) {
    const hit = CONTEXT_WINDOWS.find((c) => c.pattern.test(modelId))
    if (hit) return hit.size
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 估算一段文本的 token 数（无接口 usage 时的近似）：
 * CJK 字符约 1 token/字，其余约 1 token/4 字符（对中英文混排够用）。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 4)
}

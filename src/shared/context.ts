// 长对话的上下文装配：装不下时把最旧的几轮折成一条摘要，而不是直接报错或悄悄截断。
// 摘要是规则式的（每条取首句/前若干字），不额外花额度叫模型总结——
// 所以界面与摘要文本都要写着"规则式压缩"，不能让读者以为那是模型读懂之后写的。
import { estimateTokens } from './pricing'

/** 留 3 成余量给系统块、工具结果与模型自己的输出 */
export const CONTEXT_BUDGET_RATIO = 0.7
/** 再挤也不能挤掉最近的轮次：这些才是"当前在说什么" */
export const MIN_RECENT_TURNS = 4
const FOLDED_MAX_CHARS = 1200
const PER_MESSAGE_CHARS = 90

export interface HistoryTurn {
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  ts?: number
}

export function turnTokens(t: HistoryTurn): number {
  return estimateTokens(t.text ?? '') + estimateTokens(t.reasoning ?? '')
}

/**
 * 按预算把最旧的轮次折起来：返回保留与折叠两段。
 * 预算给得再小也至少保留最近 MIN_RECENT_TURNS 条——宁可超一点也别把当前问题丢掉。
 */
export function fitHistory(turns: HistoryTurn[], budgetTokens: number): { kept: HistoryTurn[]; folded: HistoryTurn[] } {
  const kept = [...turns]
  const folded: HistoryTurn[] = []
  let total = kept.reduce((n, t) => n + turnTokens(t), 0)
  while (total > budgetTokens && kept.length > MIN_RECENT_TURNS) {
    const drop = kept.shift()
    if (!drop) break
    folded.push(drop)
    total -= turnTokens(drop)
  }
  return { kept, folded }
}

/** 折叠出来的摘要：按时间顺序，标明是规则式压缩、且原文已被丢掉 */
export function foldTranscript(folded: HistoryTurn[]): string {
  if (!folded.length) return ''
  const lines = folded.map((t) => {
    const body = (t.text || '').replace(/\s+/g, ' ').trim().slice(0, PER_MESSAGE_CHARS)
    return `- ${t.role === 'user' ? '我' : '助手'}：${body || '（空）'}${(t.text || '').length > PER_MESSAGE_CHARS ? '…' : ''}`
  })
  let text = lines.join('\n')
  let cut = folded.length
  // 总长超限时从最旧的那些开始丢（保留接近当下的部分）
  while (text.length > FOLDED_MAX_CHARS && cut > 1) {
    cut--
    text = lines.slice(lines.length - cut).join('\n')
  }
  const head = `【此前 ${folded.length} 轮对话的摘要（AgentHub 规则式压缩：取每条开头，不是模型读完写的总结，原文本轮未发送）】`
  return `${head}\n${text}${cut < folded.length ? `\n…（更早的 ${folded.length - cut} 轮未列入摘要）` : ''}`
}

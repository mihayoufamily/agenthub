// 长期记忆的检索与注入（纯函数，main / renderer / 验证脚本共用）
//
// 为什么不是"全量塞"：记忆攒到几十条后再全量注入，每轮都驮着与本次任务无关的历史，
// 既贵又会把模型注意力带走。所以按当前目标做一次关键词打分，只取相关的几条，
// 并且如实标出命中强度——弱命中的条目让人自己判断，不冒充"相关"。
import type { MemoryEntry } from './types'

export const MEMORY_INJECT_LIMIT = 8
export const MEMORY_INJECT_MAX_CHARS = 4000

const STOP = new Set(['的', '了', '和', '与', '是', '在', '有', '请', '把', '给', '一个', '这个', '那个', '以及', '然后', '需要', '可以', '不要', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'your'])

/** 中英混排的分词：拉丁词按词切，CJK 按相邻二字组合切（没有分词器时这已经够用） */
export function tokenize(s: string): string[] {
  if (!s) return []
  const out: string[] = []
  const lower = s.toLowerCase()
  for (const m of lower.match(/[a-z0-9_.-]{2,}/g) ?? []) if (!STOP.has(m)) out.push(m)
  const cjk = lower.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) {
      if (!STOP.has(run)) out.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2)
      if (!STOP.has(bigram)) out.push(bigram)
    }
  }
  return out
}

/** 目标与一条记忆的重合度：命中词按"出现在记忆里"计，短记忆不因字数少而吃亏 */
export function scoreEntry(queryTokens: string[], entry: MemoryEntry): number {
  if (!queryTokens.length) return 0
  const hay = `${entry.kind} ${entry.text}`.toLowerCase()
  let hits = 0
  for (const t of new Set(queryTokens)) if (hay.includes(t)) hits++
  return hits
}

export interface ScoredMemory {
  entry: MemoryEntry
  score: number
}

/** 按分数取前 limit 条；0 分的条目不注入（宁可不给，也别拿无关历史带偏模型） */
export function rankMemories(query: string, entries: MemoryEntry[], limit = MEMORY_INJECT_LIMIT): ScoredMemory[] {
  const qt = tokenize(query)
  return entries
    .map((entry) => ({ entry, score: scoreEntry(qt, entry) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)
    .slice(0, limit)
}

const KIND_LABEL: Record<MemoryEntry['kind'], string> = {
  goal: '目标',
  constraint: '约束',
  decision: '决定',
  progress: '进展',
  review: '审核',
  confirm: '确认',
  summary: '成果'
}

/**
 * 拼成注入段落。总量有上限（超了就少给几条，而不是每条都截一半），
 * 并注明这些是历史记忆、与本次目标冲突时以本次为准。
 */
export function renderMemoryBlock(scored: ScoredMemory[]): string {
  if (!scored.length) return ''
  const lines: string[] = []
  let used = 0
  for (const s of scored) {
    const line = `- [${KIND_LABEL[s.entry.kind] ?? s.entry.kind}] ${s.entry.text.replace(/\s+/g, ' ').slice(0, 300)}`
    if (used + line.length > MEMORY_INJECT_MAX_CHARS) break
    used += line.length + 1
    lines.push(line)
  }
  if (!lines.length) return ''
  return `【历史任务记忆里与本任务相关的条目（AgentHub 自动检索，非本次目标；与本次目标冲突时以本次为准）】\n${lines.join('\n')}`
}

/** 一步到位：检索 + 拼装；没有命中就返回空串（不硬凑） */
export function memoryBlockFor(query: string, entries: MemoryEntry[], limit = MEMORY_INJECT_LIMIT): string {
  return renderMemoryBlock(rankMemories(query, entries, limit))
}

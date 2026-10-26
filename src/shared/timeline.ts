import type { ToolCall, FileChange } from './types'

/**
 * 回复的时间线段（对标 zcode/Claude Code 的过程流）：一条 assistant 回复不再是
 * "思考折叠 + 工具卡堆叠 + 正文气泡"三段式，而是按事件真实到达顺序穿插的段序列。
 *
 * 事件链路（openai.ts / cli.ts）本来就按真实顺序吐事件——是 store 合并处把顺序抹掉了。
 * 本模块是合并的唯一口径：store 每收一个事件走 applyEventToSegments，渲染层 MessageRow
 * 按 segments.map 渲染。tool 段只存 tcId 引用（实体在 msg.toolCalls，避免双写大对象）。
 */
export type MsgSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; tcId: string }

/** 一个事件如何落到时间线上（纯函数；messages 用接受并返回，store 侧不可变更新） */
export function applyEventToSegments(
  segments: MsgSegment[] | undefined,
  ev: { type: string; text?: string; toolCall?: ToolCall }
): MsgSegment[] {
  const segs: MsgSegment[] = segments ? [...segments] : []
  if (ev.type === 'delta' && ev.text) {
    const last = segs[segs.length - 1]
    if (last && last.kind === 'text') last.text += ev.text
    else segs.push({ kind: 'text', text: ev.text })
    return segs
  }
  if (ev.type === 'reasoning' && ev.text) {
    const last = segs[segs.length - 1]
    // 与旧 reasoningOpen 同语义：紧跟上一段思考的思考续写，否则新开一段
    if (last && last.kind === 'reasoning') last.text += (last.text ? '\n\n' : '') + ev.text
    else segs.push({ kind: 'reasoning', text: ev.text })
    return segs
  }
  if (ev.type === 'tool' && ev.toolCall) {
    const i = segs.findIndex((s) => s.kind === 'tool' && s.tcId === ev.toolCall!.id)
    if (i >= 0) return segs // 已在时间线上（running→done 原位更新 toolCalls 实体即可）
    segs.push({ kind: 'tool', tcId: ev.toolCall.id })
    return segs
  }
  return segs
}

/**
 * 会话级文件改动聚合：把全会话各消息检查点条里的登记合并去重。
 * FileChange 去重键 = path+kind（同一路径既被改又被删是两条事实，都保留）。
 * 导出给 ChatView 的聚合条与逻辑层断言共用。
 */
export function aggregateSessionChanges(
  changes: { rel: string; path: string; kind: FileChange['kind'] }[]
): { counts: Record<FileChange['kind'], number>; items: { rel: string; kind: FileChange['kind'] }[] } {
  const counts = { created: 0, modified: 0, deleted: 0, moved: 0 } as Record<FileChange['kind'], number>
  const seen = new Set<string>()
  const items: { rel: string; kind: FileChange['kind'] }[] = []
  for (const c of changes) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1
    const key = `${c.kind}:${c.rel}`
    if (!seen.has(key)) {
      seen.add(key)
      items.push({ rel: c.rel, kind: c.kind })
    }
  }
  return { counts, items }
}

/**
 * dsh headless 输出的结构化行探测（纯函数）：dsh 当前版本吐纯文本（原样透传），
 * 未来版本若吐 ndjson 则自动升级成结构化事件——不猜协议、不写死版本号：
 * 行能解析成 JSON 且带本仓事件语义的形态才认，否则返回 null（调用方维持纯文本透传）。
 */
export function parseDshStructuredLine(
  line: string
): { type: 'reasoning' | 'tool'; text?: string; toolCall?: { id: string; tool: string; args: Record<string, unknown>; status: 'done' } } | null {
  const s = line.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(s) as Record<string, unknown>
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  // 思考行：{type|event:'thinking'|'reasoning', text|content}
  const kind = String(j.type ?? j.event ?? '').toLowerCase()
  const body = typeof j.text === 'string' ? j.text : typeof j.content === 'string' ? j.content : ''
  if ((kind === 'thinking' || kind === 'reasoning') && body) {
    return { type: 'reasoning', text: body }
  }
  // 工具行：{type|event:'tool'|'tool_call', name|tool, args|arguments?}
  if (kind === 'tool' || kind === 'tool_call' || kind === 'tool_result') {
    const tool = String(j.name ?? j.tool ?? '')
    if (!tool) return null
    const args = (j.args && typeof j.args === 'object' && !Array.isArray(j.args) ? j.args : j.arguments && typeof j.arguments === 'object' ? j.arguments : {}) as Record<string, unknown>
    const output = typeof j.output === 'string' ? j.output : typeof j.result === 'string' ? j.result : ''
    return {
      type: 'tool',
      toolCall: {
        id: String(j.id ?? `dsh_${Math.random().toString(36).slice(2, 8)}`),
        tool,
        args,
        status: 'done',
        ...(output ? { output: output.slice(0, 8000) } : {})
      } as { id: string; tool: string; args: Record<string, unknown>; status: 'done' }
    }
  }
  return null
}

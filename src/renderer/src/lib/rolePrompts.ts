// 工作流角色提示词与结构化输出解析（真实模型接入用）
// 约定：角色输出为单个 JSON 对象（conclusion + checklist）；
// 解析失败时降级为纯文本结论，绝不伪造结构化验收结果。
import type { ChecklistItem } from '@shared/types'

/** 一次真实运行的跨角色上下文 */
export interface RunContext {
  goal: string
  round: number
  maxRounds: number
  /** 上一轮审核问题项（返工时注入） */
  prevReviewIssues?: string[]
  /** 用户返工意见 */
  reworkFeedback?: string
  /** 用户补充要求（下一轮生效） */
  supplements?: string[]
  /** "继续修改"携带的上一任务上下文 */
  carryOver?: string
  /** 首轮注入的用户文本附件内容（拼接后的原文） */
  attachmentText?: string
  /** 本轮规划结论（执行/审核角色使用） */
  planConclusion?: string
  /** 本轮验收清单（执行/审核角色使用） */
  planChecklist?: ChecklistItem[]
  /** 本轮执行结论（审核角色使用） */
  execConclusion?: string
}

export type WorkflowRole = 'planner' | 'executor' | 'reviewer'

const SYSTEM_PROMPTS: Record<WorkflowRole, string> = {
  planner:
    '你是工作流中的"规划 Agent"。职责：把任务目标拆解为可执行步骤，并给出可检查的验收标准。\n' +
    '只输出一个 JSON 对象，不要输出其它任何内容，格式：\n' +
    '{"conclusion": "面向用户的规划说明（2-4 句话）", "checklist": [{"text": "任务步骤或验收标准，一句一项"}]}\n' +
    '要求：checklist 3-6 项；每项必须可被第三方独立检查；不要虚构无法验证的标准；纯文本任务按内容质量定标准。',
  executor:
    '你是工作流中的"执行 Agent"。按规划清单完成任务并如实报告。\n' +
    '当前接入为纯文本模型（无本机工具执行权限）：如任务涉及本机操作，请产出可直接使用的完整文本成果（方案/代码/文案等），并如实说明无法代为执行的部分，绝不虚构已执行的操作。\n' +
    '只输出一个 JSON 对象，不要输出其它任何内容，格式：\n' +
    '{"conclusion": "执行结果说明或完整成果（成果较长时直接放在此处）", "checklist": [{"text": "对应规划步骤", "done": true}]}\n' +
    '要求：done 只能如实填写，未完成的一律 false 并在 conclusion 说明原因。',
  reviewer:
    '你是工作流中的"审核 Agent"。对照验收清单逐项检查执行结果，不因执行方自称完成而放行；无法核实的内容按 issue 处理并说明。\n' +
    '只输出一个 JSON 对象，不要输出其它任何内容，格式：\n' +
    '{"conclusion": "审核总结（通过情况、问题与建议）", "checklist": [{"text": "验收项", "verdict": "pass"}]}\n' +
    '要求：checklist 与验收清单一一对应（可补充关键新发现项）；verdict 只能是 "pass" 或 "issue"；不许为了放行而放宽标准。'
}

export function buildRoleMessages(role: WorkflowRole, ctx: RunContext): { system: string; user: string } {
  const lines: string[] = [`任务目标：${ctx.goal}`]
  if (ctx.attachmentText) {
    lines.push(`\n用户提供的文本附件（真实文件内容，规划时请据此拆解）：${ctx.attachmentText}`)
  }
  if (ctx.carryOver) {
    lines.push(`\n上一任务上下文（本次为继续修改）：\n${sliceCtx(ctx.carryOver)}`)
  }
  if (ctx.round > 1 && ctx.prevReviewIssues?.length) {
    lines.push(`\n上一轮审核未通过的问题：\n${ctx.prevReviewIssues.map((i) => `- ${i}`).join('\n')}\n请针对以上问题调整本轮工作。`)
  }
  if (ctx.reworkFeedback) {
    lines.push(`\n用户返工意见：${ctx.reworkFeedback}`)
  }
  if (ctx.supplements?.length) {
    lines.push(`\n用户补充要求：\n${ctx.supplements.map((s) => `- ${s}`).join('\n')}`)
  }
  if (role !== 'planner') {
    if (ctx.planConclusion) lines.push(`\n本轮规划结论：\n${sliceCtx(ctx.planConclusion)}`)
    if (ctx.planChecklist?.length) {
      lines.push(`\n验收清单：\n${ctx.planChecklist.map((i, n) => `${n + 1}. ${i.text}`).join('\n')}`)
    }
  }
  if (role === 'reviewer' && ctx.execConclusion) {
    lines.push(`\n执行结果：\n${sliceCtx(ctx.execConclusion)}`)
  }
  if (role === 'planner') {
    lines.push(`\n（当前第 ${ctx.round} 轮，返工上限 ${ctx.maxRounds} 轮）`)
  }
  return { system: SYSTEM_PROMPTS[role], user: lines.join('\n') }
}

/** 上下文截断：防止历史结论把请求撑爆（保留头尾） */
function sliceCtx(text: string, max = 2000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max / 2)}\n…（已截断）…\n${text.slice(-max / 2)}`
}

export interface ParsedRoleOutput {
  conclusion: string
  checklist?: ChecklistItem[]
}

/** 平衡括号扫描：提取文本中第一个完整 JSON 对象（正确处理字符串内的花括号与转义引号） */
function firstBalancedJson(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 解析模型角色输出。支持 ```json 围栏或裸 JSON。
 * 返回 null 表示无法解析（调用方降级为纯文本结论）。
 */
export function parseRoleOutput(raw: string): ParsedRoleOutput | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], raw]
  for (const c of candidates) {
    if (!c) continue
    // 候选范围：first{..last} 整体范围（单一 JSON 带前后缀文本），失败再用平衡扫描取第一个完整对象
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    const ranges: string[] = []
    if (start >= 0 && end > start) ranges.push(c.slice(start, end + 1))
    const balanced = firstBalancedJson(c)
    if (balanced) ranges.push(balanced)
    for (const range of ranges) {
    try {
      const obj = JSON.parse(range) as {
        conclusion?: unknown
        checklist?: { text?: unknown; verdict?: unknown; done?: unknown }[]
      }
      if (typeof obj.conclusion !== 'string' || !obj.conclusion.trim()) continue
      const checklist = Array.isArray(obj.checklist)
        ? obj.checklist
            .filter((it) => it && typeof it.text === 'string' && (it.text as string).trim())
            .slice(0, 12)
            .map((it) => {
              const verdict = it.verdict === 'pass' || it.verdict === 'issue' ? it.verdict : undefined
              return {
                text: String(it.text).slice(0, 200),
                done: verdict === 'pass' ? true : verdict === 'issue' ? false : it.done !== false,
                ...(verdict ? { verdict } : {})
              } satisfies ChecklistItem
            })
        : undefined
      return {
        conclusion: obj.conclusion.trim(),
        ...(checklist && checklist.length > 0 ? { checklist } : {})
      }
    } catch { /* 尝试下一个范围 */ }
    }
  }
  return null
}

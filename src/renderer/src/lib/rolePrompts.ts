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
  /** 本次任务生效的产物目录（执行/审核角色使用：真实文件产物应落在此目录） */
  outputDir?: string
  /** 产物目录下自动读取到的项目约定段落（AGENTS.md / CLAUDE.md 原文，含来源标题） */
  conventions?: string
}

export type WorkflowRole = 'planner' | 'executor' | 'reviewer'

const PLANNER_PROMPT =
  '你是工作流中的"规划 Agent"。职责：把任务目标拆解为可执行步骤，并给出可检查的验收标准。\n' +
  '只输出一个 JSON 对象，不要输出其它任何内容，格式：\n' +
  '{"conclusion": "面向用户的规划说明（2-4 句话）", "checklist": [{"text": "任务步骤或验收标准，一句一项"}]}\n' +
  '要求：checklist 3-6 项；每项必须可被第三方独立检查；不要虚构无法验证的标准；纯文本任务按内容质量定标准。'

const REVIEWER_PROMPT =
  '你是工作流中的"审核 Agent"。对照验收清单逐项检查执行结果，不因执行方自称完成而放行；无法核实的内容按 issue 处理并说明。\n' +
  '只输出一个 JSON 对象，不要输出其它任何内容，格式：\n' +
  '{"conclusion": "审核总结（通过情况、问题与建议）", "checklist": [{"text": "验收项", "verdict": "pass"}]}\n' +
  '要求：checklist 与验收清单一一对应（可补充关键新发现项）；verdict 只能是 "pass" 或 "issue"；不许为了放行而放宽标准。'

const EXEC_HEAD = '你是工作流中的"执行 Agent"。按规划清单完成任务并如实报告。\n'
const EXEC_TAIL =
  '只输出一个 JSON 对象，不要输出其它任何内容，格式：\n' +
  '{"conclusion": "执行结果说明或完整成果（成果较长时直接放在此处）", "checklist": [{"text": "对应规划步骤", "done": true}]}\n' +
  '要求：done 只能如实填写，未完成的一律 false 并在 conclusion 说明原因。'

const EXEC_NO_TOOLS =
  '当前接入为纯文本模型（无本机工具执行权限）：如任务涉及本机操作，请产出可直接使用的完整文本成果（方案/代码/文案等），并如实说明无法代为执行的部分，绝不虚构已执行的操作。\n' +
  '注意：你的 conclusion 会被原样保存为本次任务的文本产物文件，因此 conclusion 必须是成果本体（可复制使用的全文），不要只写"已完成"或摘要。'
const EXEC_WITH_TOOLS = '当前已授权文件工具：可在指定目录内读取/写入/列出/删除（回收站）/移动文件，可递归文本搜索、通配符查找文件、精准替换片段。请优先用工具产出真实文件产物（代码、文档等）；工具无法完成的部分如实说明，绝不虚构已执行的操作。'
const EXEC_CLI =
  '你是通过本机 CLI 执行任务 Agent（可读写文件、可执行命令）。请把成果真实写入文件（代码、文档、脚本等工程文件），不要只在回复里贴文本；' +
  '并在 conclusion 中列出产出的文件名、如何运行/验证、以及未覆盖的部分。绝不虚构已执行的操作。'

/** 执行角色的能力形态（决定提示词怎么描述"能不能落盘"） */
export interface ExecutorCapability {
  /** model = AgentHub 提供工具层；cli = 该 Agent 用自身 CLI 执行能力 */
  kind: 'model' | 'cli'
  /** 本次任务的文件工作根（产物目录）；模型未授权工具时空字符串 */
  dir: string
  /** 模型 Agent 是否已授权文件工具（CLI 一律视为具备自身执行能力） */
  hasTools: boolean
  allowCommands?: boolean
  allowWeb?: boolean
}

/** 执行角色提示词：按"用什么方式落盘"如实拼装，避免把 CLI / 已授权工具的 Agent 误描述成无能力 */
function buildExecutorSystem(exec: ExecutorCapability): string {
  const parts: string[] = [EXEC_HEAD]
  parts.push(exec.kind === 'cli' ? EXEC_CLI : exec.hasTools ? EXEC_WITH_TOOLS : EXEC_NO_TOOLS)
  if (exec.dir) {
    const dirNote =
      exec.kind === 'cli'
        ? `本次任务的工作目录（成果文件请落在此目录，相对路径以此为基准）：${exec.dir}`
        : exec.hasTools
          ? `本次任务的产物目录（文件工具的工作根目录，相对路径以此为基准）：${exec.dir}`
          : `本次任务的文本产物将由 AgentHub 保存到：${exec.dir}（你无法直接写盘，请把成果完整写在 conclusion 中）`
    parts.push(dirNote)
  }
  if (exec.kind === 'model' && exec.hasTools) {
    if (exec.allowCommands) {
      parts.push('此外已授权执行 shell 命令（工作目录为授权目录，超时 60 秒）：可用于构建、测试等产物验证。')
    }
    if (exec.allowWeb) {
      parts.push('此外已授权联网：web_fetch 可抓取网页（HTML 自动转文本）、web_search 可搜索（DuckDuckGo）。需要查资料/引用最新信息时使用。')
    }
  }
  parts.push(EXEC_TAIL)
  return parts.join('\n')
}

export function buildRoleMessages(
  role: WorkflowRole,
  ctx: RunContext,
  exec?: ExecutorCapability,
  agentSystemPrompt?: string
): { system: string; user: string } {
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
    if (ctx.outputDir) lines.push(`产物目录：${ctx.outputDir}（验收标准可指向此目录内的具体文件）`)
  }
  if (role === 'reviewer' && ctx.outputDir) {
    lines.push(`\n产物目录：${ctx.outputDir}（执行方声称的文件成果应在此目录，可据此核实）`)
  }
  const base = role === 'executor' ? buildExecutorSystem(exec ?? { kind: 'model', dir: '', hasTools: false }) : role === 'planner' ? PLANNER_PROMPT : REVIEWER_PROMPT
  // 追加顺序固定：角色协议 → 项目约定 → 该执行者的常驻要求。
  // 协议（输出格式、能力边界）在最前，不能被仓库里的文字或用户提示词覆盖掉
  const extras: string[] = []
  if (ctx.conventions?.trim()) extras.push(ctx.conventions.trim())
  if (agentSystemPrompt?.trim()) extras.push(`【该执行者的常驻要求，请始终遵守】\n${agentSystemPrompt.trim()}`)
  const system = extras.length ? `${base}\n\n${extras.join('\n\n')}` : base
  return { system, user: lines.join('\n') }
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

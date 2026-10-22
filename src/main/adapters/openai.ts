import type { CustomModelConfig, ModelTestResult, ToolGrant, ToolCall } from '../../shared/types'
import { execTool, toolDefs, MAX_OUTPUT } from '../tools'

/**
 * OpenAI 兼容接口适配层（接入"模型 API"而非"现成 Agent"）。
 * 由 AgentHub 提供：消息发送、流式事件、取消、用量尽力解析、
 * 可选文件/命令工具层（Agent 级授权制，见 main/tools.ts）。
 */

/** 工具循环的对话消息（兼容 OpenAI tool 协议的扩展形状） */
export type ChatMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; content: string; tool_call_id: string }

export interface ChatChunkEvent {
  reqId: string
  type: 'delta' | 'reasoning' | 'done' | 'error' | 'usage' | 'tool' | 'notice'
  text?: string
  message?: string
  usage?: { tokens?: number }
  /** type === 'tool' 时的调用记录（含执行状态与结果） */
  toolCall?: ToolCall
  /** type === 'tool' 且 write_file 成功时的绝对路径（登记产物用） */
  writtenPath?: string
}

const activeStreams = new Map<string, AbortController>()

/** 工具调用轮数上限：防止模型无限循环调用工具 */
const MAX_TOOL_ROUNDS = 16

/**
 * 思考增量（reasoning_content）是否回传给接口：默认不回传——
 * DeepSeek 官方建议不在后续请求回传该字段，OpenAI o 系列等接口也不接受，
 * 多轮工具循环时回传可能直接 400。确需回传可设 AGENTHUB_PASS_REASONING=1。
 */
const PASS_REASONING = process.env.AGENTHUB_PASS_REASONING === '1'

/**
 * 错误信息中文化：常见 CLI / 模型接口错误 → 人话 + 原文（未命中时原样返回）。
 * 只做提示语转换，不吞掉任何原始信息。
 */
export function humanizeError(raw: string): string {
  const r = raw.trim()
  const rules: [RegExp, string][] = [
    [/429|rate.?limit|too many requests/i, '该模型正在限流：请换一个模型或稍后再试'],
    [/authentication required|not logged in|请先登录|未登录/i, 'CLI 未登录：请在终端运行该 CLI 并完成登录（如 codebuddy 后输入 /login）'],
    [/MISSING_CREDENTIAL|missing.{0,20}credential/i, '缺少模型凭据：请设置对应环境变量（如 DEEPSEEK_API_KEY）或先在该 CLI 中完成配置'],
    [/permission.{0,30}denied|权限.{0,10}拒绝/i, 'CLI 拒绝了工具权限：非交互模式下没有审批界面（可调整其 permission-mode 设置）'],
    [/EADDRINUSE|address already in use|EADDRNOTAVAIL/i, '本地端口被占用：可能有其他 CLI 或 IDE 实例正在运行，请关闭后重试（或换一个工作目录）'],
    [/\b401\b|unauthorized|invalid.{0,10}api.?key/i, '认证失败：API Key 无效或已过期，请检查后重新填写'],
    [/\b404\b|not found/i, '接口地址或模型不存在：请检查 Base URL 与模型 ID'],
    [/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i, '网络连接失败：请检查网络或服务地址']
  ]
  for (const [re, text] of rules) {
    if (re.test(r)) return `${text}\n（原文：${r.slice(0, 200)}）`
  }
  return r
}

function headers(cfg: CustomModelConfig, apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function testConnection(cfg: CustomModelConfig, apiKey: string): Promise<ModelTestResult> {
  try {
    const url = joinUrl(cfg.baseUrl, '/models')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(url, { headers: headers(cfg, apiKey), signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status} ${res.statusText || ''}`.trim() }
    }
    const data = (await res.json()) as { data?: { id?: string }[] }
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).slice(0, 50)
    return { ok: true, message: `连接成功，发现 ${models.length} 个模型`, models }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') return { ok: false, message: '连接超时（8 秒）' }
    return { ok: false, message: `连接失败：${err.message}` }
  }
}

/** 列出接口真实可用的模型（切换模型用；只返回接口实际报告的，不虚构选项） */
export async function listModels(cfg: CustomModelConfig, apiKey: string): Promise<{ ok: boolean; models?: string[]; message?: string }> {
  try {
    const url = joinUrl(cfg.baseUrl, '/models')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(url, { headers: headers(cfg, apiKey), signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} ${res.statusText || ''}`.trim() }
    const data = (await res.json()) as { data?: { id?: string }[] }
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean)
    if (models.length === 0) return { ok: false, message: '接口未返回任何模型' }
    return { ok: true, models }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') return { ok: false, message: '请求超时（8 秒）' }
    return { ok: false, message: `获取模型列表失败：${err.message}` }
  }
}

/** 累积中的工具调用（流式分片按 index 拼接） */
interface AccToolCall { id: string; name: string; args: string }

interface RoundResult {
  finish: 'stop' | 'tool_calls' | null
  toolCalls: AccToolCall[]
  usage?: { tokens?: number }
  /** 思考模型本轮的思考内容（仅 UI 展示；是否随 assistant 消息回传由 PASS_REASONING 控制） */
  reasoning: string
}

/** 单轮对话请求（流式）：文本增量直发 onDelta、思考增量直发 onReasoning；结束时返回工具调用与完成原因 */
async function chatRound(
  cfg: CustomModelConfig,
  apiKey: string,
  messages: ChatMsg[],
  tools: unknown[] | undefined,
  onDelta: (t: string) => void,
  signal: AbortSignal,
  onReasoning?: (t: string) => void
): Promise<RoundResult> {
  const url = joinUrl(cfg.baseUrl, '/chat/completions')
  const body = {
    model: cfg.modelId,
    messages,
    stream: true,
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {})
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg, apiKey),
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const acc = new Map<number, AccToolCall>()
  let finish: RoundResult['finish'] = null
  let usage: { tokens?: number } | undefined
  let reasoning = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const choice = json.choices?.[0]
        const delta = choice?.delta
        if (typeof delta?.content === 'string' && delta.content) onDelta(delta.content)
        // 思考模型的思考增量（reasoning_content）：收集并在事件流转发（UI 展示 + 多轮回传协议）
        const rc = delta?.reasoning_content
        if (typeof rc === 'string' && rc) {
          reasoning += rc
          onReasoning?.(rc)
        }
        // 流式工具调用分片：按 index 拼接 id/name/arguments
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0
            const cur = acc.get(idx) ?? { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            acc.set(idx, cur)
          }
        }
        if (choice?.finish_reason === 'stop') finish = 'stop'
        else if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call') finish = 'tool_calls'
        if (json.usage) usage = { tokens: json.usage.total_tokens }
      } catch { /* 忽略不完整 JSON 行 */ }
    }
  }
  return {
    finish,
    toolCalls: [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    usage,
    reasoning
  }
}

/** 展示/记录用的参数摘要（长内容截断，避免消息存储膨胀） */
function argsSummary(argsJson: string): Record<string, string> {
  try {
    const o = JSON.parse(argsJson) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      out[k] = s.length > 200 ? s.slice(0, 200) + '…' : s
    }
    return out
  } catch {
    return { raw: argsJson.slice(0, 200) }
  }
}

/**
 * 完整对话（含工具循环）。grant 存在时启用工具：
 * 模型返回 tool_calls -> 沙箱执行 -> 结果回传 -> 继续对话，直至普通回复或达轮数上限。
 */
export function chatStream(
  cfg: CustomModelConfig,
  apiKey: string,
  reqId: string,
  messages: ChatMsg[],
  onEvent: (e: ChatChunkEvent) => void,
  grant?: ToolGrant
) {
  const ctrl = new AbortController()
  activeStreams.set(reqId, ctrl)
  const tools = grant ? toolDefs(!!grant.allowCommands, !!grant.allowWeb) : undefined

  void (async () => {
    try {
      const convo: ChatMsg[] = [...messages]
      let tokens = 0
      let rounds = 0
      for (;;) {
        const r = await chatRound(cfg, apiKey, convo, tools, (t) => onEvent({ reqId, type: 'delta', text: t }), ctrl.signal, (t) => onEvent({ reqId, type: 'reasoning', text: t }))
        if (r.usage?.tokens) tokens += r.usage.tokens
        if (r.finish !== 'tool_calls' || !grant || r.toolCalls.length === 0) {
          if (tokens) onEvent({ reqId, type: 'usage', usage: { tokens } })
          onEvent({ reqId, type: 'done' })
          activeStreams.delete(reqId)
          return
        }
        rounds++
        if (rounds > MAX_TOOL_ROUNDS) {
          convo.push({ role: 'user', content: `（系统）已达到工具调用轮数上限（${MAX_TOOL_ROUNDS}），请直接给出最终答复。` })
          // 标记后继续：下一轮无 tool_calls 自然收束
          const r2 = await chatRound(cfg, apiKey, convo, undefined, (t) => onEvent({ reqId, type: 'delta', text: t }), ctrl.signal, (t) => onEvent({ reqId, type: 'reasoning', text: t }))
          if (r2.usage?.tokens) tokens += r2.usage.tokens
          if (tokens) onEvent({ reqId, type: 'usage', usage: { tokens } })
          onEvent({ reqId, type: 'done' })
          activeStreams.delete(reqId)
          return
        }
        // 记录 assistant 的工具调用消息（思考增量默认不回传，见 PASS_REASONING），逐个执行并回传结果
        convo.push({
          role: 'assistant',
          content: null,
          ...(r.reasoning && PASS_REASONING ? { reasoning_content: r.reasoning } : {}),
          tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.args } }))
        })
        for (const tc of r.toolCalls) {
          // 取消后不再发起新的工具执行（已取消的请求由下方统一收尾）
          if (ctrl.signal.aborted) {
            if (tokens) onEvent({ reqId, type: 'usage', usage: { tokens } })
            onEvent({ reqId, type: 'done', message: '已取消' })
            activeStreams.delete(reqId)
            return
          }
          const call: ToolCall = { id: uid('tool'), tool: tc.name, args: argsSummary(tc.args), status: 'running', ts: Date.now() }
          onEvent({ reqId, type: 'tool', toolCall: call })
          // 取消信号透传：正在执行的命令/联网可被立即中断
          const res = await execTool(grant, tc.name, tc.args, ctrl.signal)
          const done: ToolCall = {
            ...call,
            status: res.ok ? 'done' : 'error',
            result: res.output.length > 5000 ? res.output.slice(0, 5000) + '…（已截断）' : res.output
          }
          onEvent({ reqId, type: 'tool', toolCall: done, ...(res.writtenPath ? { writtenPath: res.writtenPath } : {}) })
          convo.push({ role: 'tool', tool_call_id: tc.id, content: res.output.slice(0, MAX_OUTPUT) })
        }
      }
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') {
        onEvent({ reqId, type: 'done', message: '已取消' })
      } else {
        onEvent({ reqId, type: 'error', message: humanizeError(err.message) })
      }
      activeStreams.delete(reqId)
    }
  })()
}

export function cancelStream(reqId: string) {
  activeStreams.get(reqId)?.abort()
  activeStreams.delete(reqId)
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const normalized = path.startsWith('/') ? path : `/${path}`
  // 常见坑：用户填 https://host/v1 结尾缺斜杠
  return b + normalized
}

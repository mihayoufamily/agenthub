import type { CustomModelConfig, ModelTestResult } from '../../shared/types'

/**
 * OpenAI 兼容接口适配层（接入"模型 API"而非"现成 Agent"）。
 * 由 AgentHub 提供：消息发送、流式事件、取消、用量尽力解析。
 * 能力边界如实声明：不支持工具调用执行、不支持审批，仅文本对话。
 */

export interface ChatChunkEvent {
  reqId: string
  type: 'delta' | 'done' | 'error' | 'usage'
  text?: string
  message?: string
  usage?: { tokens?: number }
}

const activeStreams = new Map<string, AbortController>()

function headers(cfg: CustomModelConfig, apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
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

export function chatStream(
  cfg: CustomModelConfig,
  apiKey: string,
  reqId: string,
  messages: { role: string; content: string }[],
  onEvent: (e: ChatChunkEvent) => void
) {
  const ctrl = new AbortController()
  activeStreams.set(reqId, ctrl)
  const url = joinUrl(cfg.baseUrl, '/chat/completions')
  const body = {
    model: cfg.modelId,
    messages,
    stream: true,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {})
  }

  fetch(url, {
    method: 'POST',
    headers: headers(cfg, apiKey),
    body: JSON.stringify(body),
    signal: ctrl.signal
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        onEvent({ reqId, type: 'error', message: `HTTP ${res.status} ${text.slice(0, 200)}` })
        activeStreams.delete(reqId)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let usage: { tokens?: number } | undefined
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
            const delta = json.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) onEvent({ reqId, type: 'delta', text: delta })
            if (json.usage) usage = { tokens: json.usage.total_tokens }
          } catch { /* 忽略不完整 JSON 行 */ }
        }
      }
      onEvent({ reqId, type: 'usage', usage })
      onEvent({ reqId, type: 'done' })
      activeStreams.delete(reqId)
    })
    .catch((e: Error) => {
      if (e.name === 'AbortError') {
        onEvent({ reqId, type: 'done', message: '已取消' })
      } else {
        onEvent({ reqId, type: 'error', message: e.message })
      }
      activeStreams.delete(reqId)
    })
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

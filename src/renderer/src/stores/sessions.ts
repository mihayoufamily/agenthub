// 会话状态：每个 Agent 独立的消息、草稿、滚动位置；演示回复引擎 + 真实模型流式接入
import { create } from 'zustand'
import type { AgentSession, ChatMessage, Attachment } from '@shared/types'
import { bridge } from '../lib/ipc'
import { uid, chunkText, sleep, safeName, fmtSize } from '../lib/utils'
import { useAgents, saveSessionPayload } from './agents'
import { useUi } from './ui'
import { demoChatReply, demoHandoffNote } from '../lib/demo'

interface SessionsState {
  sessions: Record<string, AgentSession>
  /** 运行中的模型流 reqId -> agentId，避免重复提交 */
  activeStreams: Record<string, string>

  ensure: (agentId: string) => Promise<void>
  messagesOf: (agentId: string) => ChatMessage[]
  draftOf: (agentId: string) => string
  setDraft: (agentId: string, text: string) => void
  sendMessage: (agentId: string, text: string, attachments: Attachment[]) => Promise<void>
  /** 导出单个 Agent 的聊天会话为 Markdown 文件 */
  exportSession: (agentId: string) => Promise<void>
  handoff: (fromId: string, toId: string) => void
}

function persistSession(s: AgentSession) {
  saveSessionPayload(s)
}

export const useSessions = create<SessionsState>()((set, get) => ({
  sessions: {},
  activeStreams: {},

  ensure: async (agentId) => {
    if (get().sessions[agentId]) return
    let loaded: AgentSession | null = null
    try {
      loaded = await bridge.sessions.load(agentId)
    } catch { /* 首次无会话文件 */ }
    set((s) => {
      const mem = s.sessions[agentId]
      if (mem) {
        // 加载期间用户已输入/发送（冷启动时 IPC 可能延迟到达）：保留内存草稿与新消息，仅补入磁盘历史，绝不覆盖
        const base = loaded ?? { agentId, messages: [] as AgentSession['messages'], draft: '' }
        const memIds = new Set(mem.messages.map((m) => m.id))
        return {
          sessions: {
            ...s.sessions,
            [agentId]: {
              ...mem,
              messages: [...base.messages.filter((m) => !memIds.has(m.id)), ...mem.messages],
              draft: mem.draft || base.draft
            }
          }
        }
      }
      return { sessions: { ...s.sessions, [agentId]: loaded ?? { agentId, messages: [], draft: '' } } }
    })
  },

  messagesOf: (agentId) => get().sessions[agentId]?.messages ?? [],

  draftOf: (agentId) => get().sessions[agentId]?.draft ?? '',

  setDraft: (agentId, text) => {
    set((s) => {
      const cur = s.sessions[agentId] ?? { agentId, messages: [], draft: '' }
      const next = { ...cur, draft: text }
      return { sessions: { ...s.sessions, [agentId]: next } }
    })
    const ses = get().sessions[agentId]
    if (ses) persistSession(ses)
  },

  sendMessage: async (agentId, text, attachments) => {
    const agents = useAgents.getState()
    const agent = agents.agents.find((a) => a.id === agentId)
    if (!agent) return

    const userMsg: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      text,
      ts: Date.now(),
      model: agent.model,
      attachments: attachments.length ? attachments : undefined
    }
    const streamKey = `chat:${agentId}`
    if (get().activeStreams[streamKey]) {
      useUi.getState().toast('该 Agent 正在回复中，请稍候', 'warn')
      return
    }

    set((s) => {
      const cur = s.sessions[agentId] ?? { agentId, messages: [], draft: '' }
      return { sessions: { ...s.sessions, [agentId]: { ...cur, messages: [...cur.messages, userMsg], draft: '' } } }
    })
    persistSession(get().sessions[agentId])
    agents.setStatus(agentId, 'running')

    if (agent.kind === 'demo') {
      // ---- 演示回复：脚本化流式输出，明确标注演示 ----
      const reply = demoChatReply(text, agent.name)
      const msgId = uid('msg')
      const demoMsg: ChatMessage = {
        id: msgId, role: 'assistant', text: '', ts: Date.now(),
        demo: true, streaming: true, model: agent.model
      }
      set((s) => {
        const cur = s.sessions[agentId]
        return { sessions: { ...s.sessions, [agentId]: { ...cur, messages: [...cur.messages, demoMsg] } } }
      })
      set((s) => ({ activeStreams: { ...s.activeStreams, [streamKey]: agentId } }))
      for (const chunk of chunkText(reply, 4)) {
        await sleep(24)
        set((s) => {
          const cur = s.sessions[agentId]
          return {
            sessions: {
              ...s.sessions,
              [agentId]: {
                ...cur,
                messages: cur.messages.map((m) => (m.id === msgId ? { ...m, text: m.text + chunk } : m))
              }
            }
          }
        })
      }
      set((s) => {
        const cur = s.sessions[agentId]
        const activeStreams = { ...s.activeStreams }
        delete activeStreams[streamKey]
        return {
          activeStreams,
          sessions: {
            ...s.sessions,
            [agentId]: { ...cur, messages: cur.messages.map((m) => (m.id === msgId ? { ...m, streaming: false } : m)) }
          }
        }
      })
      // 后台完成提醒：不在当前页时计未读
      if (useAgents.getState().selectedId !== agentId) useAgents.getState().bumpUnread(agentId)
      useAgents.getState().setStatus(agentId, 'available')
      persistSession(get().sessions[agentId])
      return
    }

    if ((agent.kind === 'model' && agent.modelConfig) || (agent.kind === 'cli' && agent.cliConfig)) {
      // ---- 真实流式接入：自定义模型（OpenAI 兼容）或本机 CLI Agent ----
      const reqId = uid('req')
      const msgId = uid('msg')
      const replyMsg: ChatMessage = { id: msgId, role: 'assistant', text: '', ts: Date.now(), streaming: true, model: agent.model }
      set((s) => {
        const cur = s.sessions[agentId]
        return { sessions: { ...s.sessions, [agentId]: { ...cur, messages: [...cur.messages, replyMsg] } } }
      })
      set((s) => ({ activeStreams: { ...s.activeStreams, [streamKey]: agentId } }))

      // 携带最近的历史作为上下文（过长截断；真实工作流任务的完整上下文由 workflow 角色注入）
      const HISTORY_WINDOW = 24
      // 文本附件内容拼入本次 user 消息（真实模型/CLI 均可收到；binary 附件只保留引用不发送）
      const attachmentText = attachments
        .filter((a) => a.status === 'ok' && a.kind === 'text' && a.content !== undefined)
        .map((a) => `\n\n[附件：${a.name}]\n${a.content}`)
        .join('')
      const history = get().sessions[agentId].messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-HISTORY_WINDOW)
        .map((m) => ({ role: m.role, content: m.id === userMsg.id ? m.text + attachmentText : m.text }))

      let off = bridge.models.onEvent((ev) => {
        if (ev.reqId !== reqId) return
        if (ev.type === 'delta' && ev.text) {
          set((s) => {
            const cur = s.sessions[agentId]
            return {
              sessions: {
                ...s.sessions,
                [agentId]: {
                  ...cur,
                  messages: cur.messages.map((m) => (m.id === msgId ? { ...m, text: m.text + ev.text } : m))
                }
              }
            }
          })
        } else if (ev.type === 'tool' && ev.toolCall) {
          // 工具调用执行记录：合并进当前回复消息（同 id 更新状态与结果，新 id 追加）
          const tc = ev.toolCall
          set((s) => {
            const cur = s.sessions[agentId]
            return {
              sessions: {
                ...s.sessions,
                [agentId]: {
                  ...cur,
                  messages: cur.messages.map((m) => {
                    if (m.id !== msgId) return m
                    const calls = m.toolCalls ? [...m.toolCalls] : []
                    const i = calls.findIndex((c) => c.id === tc.id)
                    if (i >= 0) calls[i] = tc
                    else calls.push(tc)
                    return { ...m, toolCalls: calls }
                  })
                }
              }
            }
          })
        } else if (ev.type === 'error') {
          set((s) => {
            const cur = s.sessions[agentId]
            return {
              sessions: {
                ...s.sessions,
                [agentId]: {
                  ...cur,
                  messages: cur.messages.map((m) =>
                    m.id === msgId ? { ...m, streaming: false, error: ev.message ?? '未知错误' } : m
                  )
                }
              }
            }
          })
          useAgents.getState().setStatus(agentId, 'failed')
        } else if (ev.type === 'done') {
          set((s) => {
            const cur = s.sessions[agentId]
            return {
              activeStreams: { ...s.activeStreams, [streamKey]: '' },
              sessions: {
                ...s.sessions,
                [agentId]: { ...cur, messages: cur.messages.map((m) => (m.id === msgId ? { ...m, streaming: false } : m)) }
              }
            }
          })
          if (useAgents.getState().selectedId !== agentId) useAgents.getState().bumpUnread(agentId)
          useAgents.getState().setStatus(agentId, 'available')
          persistSession(get().sessions[agentId])
        }
      })

      const r = agent.kind === 'cli'
        ? await bridge.cli.chat(agent.cliConfig!.cli, { model: agent.cliConfig!.model, exePath: agent.cliConfig!.exePath }, reqId, history)
        : await bridge.models.chat(agent.modelConfig!, reqId, history, agent.tools ? { tools: agent.tools } : undefined)
      if (!r.ok) {
        set((s) => {
          const cur = s.sessions[agentId]
          return {
            activeStreams: { ...s.activeStreams, [streamKey]: '' },
            sessions: {
              ...s.sessions,
              [agentId]: {
                ...cur,
                messages: cur.messages.map((m) =>
                  m.id === msgId ? { ...m, streaming: false, error: agent.kind === 'cli' ? '请求未发出（CLI 不可用或已卸载）' : '请求未发出（缺少 API Key 或配置）' } : m
                )
              }
            }
          }
        })
        useAgents.getState().setStatus(agentId, 'failed')
      }
      // 注意：off 在 done/error 后仍保留监听（一次会话内事件有限，进程级泄漏可忽略）
      return
    }

    // 未知类型：如实提示
    const cur = get().sessions[agentId]
    const sysMsg: ChatMessage = {
      id: uid('msg'), role: 'system', text: '该 Agent 尚未连接，无法执行。请在"添加 Agent"中完成连接或选择演示 Agent。',
      ts: Date.now()
    }
    set((s) => ({ sessions: { ...s.sessions, [agentId]: { ...cur, messages: [...cur.messages, sysMsg] } } }))
    agents.setStatus(agentId, 'awaiting')
  },

  exportSession: async (agentId) => {
    const agent = useAgents.getState().agents.find((a) => a.id === agentId)
    const ses = get().sessions[agentId]
    if (!ses || ses.messages.length === 0) {
      useUi.getState().toast('该 Agent 暂无会话记录可导出', 'info')
      return
    }
    const lines: string[] = [`# AgentHub 会话导出：${agent?.name ?? agentId}`, '']
    if (agent?.isDemo) lines.push('> 此会话包含演示 Agent 的脚本化回复（非真实模型输出）', '')
    for (const m of ses.messages) {
      const t = new Date(m.ts).toLocaleString()
      if (m.role === 'user') {
        lines.push(`## 我 · ${t}`, '', m.text, '')
        if (m.attachments?.length) {
          lines.push(`附件：${m.attachments.map((a) => `${a.name}（${a.status === 'error' ? '读取失败' : fmtSize(a.size)}）`).join('、')}`, '')
        }
      } else if (m.role === 'assistant') {
        lines.push(`## ${agent?.name ?? 'Agent'} · ${t}${m.demo ? '（演示）' : ''}${m.error ? '（发送失败）' : ''}`, '', m.text, '')
      } else if (m.role === 'system') {
        lines.push(`> 系统 · ${t}：${m.text}`, '')
      }
    }
    const name = safeName(`agenthub-chat-${agent?.name ?? agentId}-${Date.now()}`) + '.md'
    const r = await bridge.dialogs.saveFile(name, lines.join('\n'))
    useUi.getState().toast(r.ok ? `已导出到 ${r.message}` : '已取消导出', r.ok ? 'ok' : 'info')
  },

  handoff: (fromId, toId) => {
    const agents = useAgents.getState()
    const from = agents.agents.find((a) => a.id === fromId)
    const to = agents.agents.find((a) => a.id === toId)
    if (!from || !to) return
    const fromSession = get().sessions[fromId]
    const lastAssistant = [...(fromSession?.messages ?? [])].reverse().find((m) => m.role === 'assistant')
    const note = demoHandoffNote(from.name, to.name, lastAssistant?.text ?? '（无最近结论可交接）')
    const msg: ChatMessage = {
      id: uid('msg'),
      role: 'system',
      text: note,
      ts: Date.now(),
      handoff: { fromAgentId: fromId, fromAgentName: from.name }
    }
    set((s) => {
      const cur = s.sessions[toId] ?? { agentId: toId, messages: [], draft: '' }
      return { sessions: { ...s.sessions, [toId]: { ...cur, messages: [...cur.messages, msg] } } }
    })
    persistSession(get().sessions[toId])
    useUi.getState().toast(`已交接给 ${to.name}`, 'ok')
  }
}))

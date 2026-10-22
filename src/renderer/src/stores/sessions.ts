// 会话状态：每个 Agent 独立的多会话（列表/切换/重命名/删除）+ 草稿随会话保留；
// 演示回复引擎 + 真实模型流式接入；磁盘为 v2 多会话格式（旧单会话文件由主进程自动迁移）
import { create } from 'zustand'
import type { AgentSession, ChatMessage, Attachment, Skill } from '@shared/types'
import { bridge } from '../lib/ipc'
import { uid, chunkText, sleep, safeName, fmtSize } from '../lib/utils'
import { estimateCost } from '@shared/pricing'
import { useAgents } from './agents'
import { useUi } from './ui'
import { useSettings } from './settings'
import { demoChatReply, demoHandoffNote } from '../lib/demo'

interface SessionsState {
  /** agentId -> 会话列表（新的在前） */
  sessions: Record<string, AgentSession[]>
  /** agentId -> 当前活跃会话 id（随磁盘持久化，重启恢复） */
  activeOf: Record<string, string>
  /** 运行中的模型流 reqId -> agentId，避免重复提交 */
  activeStreams: Record<string, string>

  ensure: (agentId: string) => Promise<void>
  /** 某 Agent 的会话列表（面板展示用） */
  listOf: (agentId: string) => AgentSession[]
  /** 活跃会话（无会话时返回 undefined，不隐式创建） */
  activeSessionOf: (agentId: string) => AgentSession | undefined
  messagesOf: (agentId: string) => ChatMessage[]
  draftOf: (agentId: string) => string
  setDraft: (agentId: string, text: string) => void
  /** 发送消息；skills 为本次引用的 Skill 提示包（注入对话上下文，仅记录名称） */
  sendMessage: (agentId: string, text: string, attachments: Attachment[], skills?: Skill[]) => Promise<void>
  newSession: (agentId: string) => void
  switchSession: (agentId: string, sessionId: string) => void
  renameSession: (agentId: string, sessionId: string, title: string) => void
  deleteSession: (agentId: string, sessionId: string) => void
  /** 导出单个 Agent 当前活跃会话为 Markdown 文件 */
  exportSession: (agentId: string) => Promise<void>
  handoff: (fromId: string, toId: string) => void
}

/** 新建空会话 */
function mkSession(agentId: string, title = '新会话'): AgentSession {
  return { id: uid('ses'), agentId, title, messages: [], draft: '', createdAt: Date.now() }
}

type Core = Pick<SessionsState, 'sessions' | 'activeOf'>

/** 取某 Agent 的活跃会话引用（容错：activeOf 失效时取最后一个；无会话返回 undefined） */
function activeOf(state: Core, agentId: string): AgentSession | undefined {
  const list = state.sessions[agentId]
  if (!list || list.length === 0) return undefined
  return list.find((x) => x.id === state.activeOf[agentId]) ?? list[list.length - 1]
}

/** 变更活跃会话（无会话时自动创建默认会话；activeOf 失效时自动纠正），返回 set 所需 partial */
function withActive(state: Core, agentId: string, fn: (ses: AgentSession) => AgentSession): { sessions: Record<string, AgentSession[]>; activeOf: Record<string, string> } {
  let list = state.sessions[agentId]
  let activeId = state.activeOf[agentId]
  if (!list || list.length === 0) {
    const ns = mkSession(agentId)
    list = [ns]
    activeId = ns.id
  } else if (!list.some((x) => x.id === activeId)) {
    activeId = list[list.length - 1].id
  }
  return {
    sessions: { ...state.sessions, [agentId]: list.map((s) => (s.id === activeId ? fn(s) : s)) },
    activeOf: { ...state.activeOf, [agentId]: activeId }
  }
}

/** 持久化某 Agent 的全部会话与活跃 id */
function persistAgent(agentId: string) {
  const st = useSessions.getState()
  void bridge.sessions.save(agentId, st.sessions[agentId] ?? [], st.activeOf[agentId])
}

/** 从用户消息提取会话默认标题（去换行、限长） */
function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 16 ? t.slice(0, 16) + '…' : t
}

export const useSessions = create<SessionsState>()((set, get) => ({
  sessions: {},
  activeOf: {},
  activeStreams: {},

  ensure: async (agentId) => {
    if (get().sessions[agentId]?.length) return
    let loaded: { sessions: AgentSession[]; activeId?: string } | null = null
    try {
      loaded = await bridge.sessions.load(agentId)
    } catch { /* 首次无会话文件 */ }
    set((s) => {
      const mem = s.sessions[agentId]
      if (mem && mem.length > 0) {
        // 加载期间用户已输入/发送（冷启动时 IPC 可能延迟到达）：内存版本优先，仅补入磁盘上内存缺失的会话
        const memIds = new Set(mem.map((x) => x.id))
        const merged = [...(loaded?.sessions ?? []).filter((x) => !memIds.has(x.id)), ...mem]
        return { sessions: { ...s.sessions, [agentId]: merged } }
      }
      const list = loaded && loaded.sessions.length > 0 ? loaded.sessions : [mkSession(agentId)]
      const act = loaded?.activeId && list.some((x) => x.id === loaded!.activeId) ? loaded.activeId : list[0].id
      return { sessions: { ...s.sessions, [agentId]: list }, activeOf: { ...s.activeOf, [agentId]: act } }
    })
  },

  listOf: (agentId) => get().sessions[agentId] ?? [],

  activeSessionOf: (agentId) => activeOf(get(), agentId),

  messagesOf: (agentId) => activeOf(get(), agentId)?.messages ?? [],

  draftOf: (agentId) => activeOf(get(), agentId)?.draft ?? '',

  setDraft: (agentId, text) => {
    set((s) => withActive(s, agentId, (ses) => ({ ...ses, draft: text })))
    persistAgent(agentId)
  },

  sendMessage: async (agentId, text, attachments, skills) => {
    const agents = useAgents.getState()
    const agent = agents.agents.find((a) => a.id === agentId)
    if (!agent) return

    const streamKey = `chat:${agentId}`
    if (get().activeStreams[streamKey]) {
      useUi.getState().toast('该 Agent 正在回复中，请稍候', 'warn')
      return
    }

    const userMsg: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      text,
      ts: Date.now(),
      model: agent.model,
      attachments: attachments.length ? attachments : undefined,
      skills: skills?.length ? skills.map((s) => s.name) : undefined
    }
    set((s) => withActive(s, agentId, (ses) => ({
      ...ses,
      // 首条消息后自动命名（用户手动改过标题则不再覆盖）
      title: ses.title === '新会话' && text.trim() ? titleFrom(text) : ses.title,
      messages: [...ses.messages, userMsg],
      draft: '',
      updatedAt: Date.now()
    })))
    persistAgent(agentId)
    agents.setStatus(agentId, 'running')

    if (agent.kind === 'demo') {
      // ---- 演示回复：脚本化流式输出，明确标注演示 ----
      const reply = demoChatReply(text, agent.name)
      const msgId = uid('msg')
      const demoMsg: ChatMessage = {
        id: msgId, role: 'assistant', text: '', ts: Date.now(),
        demo: true, streaming: true, model: agent.model
      }
      set((s) => withActive(s, agentId, (ses) => ({ ...ses, messages: [...ses.messages, demoMsg] })))
      set((s) => ({ activeStreams: { ...s.activeStreams, [streamKey]: agentId } }))
      for (const chunk of chunkText(reply, 4)) {
        await sleep(24)
        set((s) => withActive(s, agentId, (ses) => ({
          ...ses,
          messages: ses.messages.map((m) => (m.id === msgId ? { ...m, text: m.text + chunk } : m))
        })))
      }
      set((s) => {
        const activeStreams = { ...s.activeStreams }
        delete activeStreams[streamKey]
        return {
          activeStreams,
          ...withActive(s, agentId, (ses) => ({
            ...ses,
            messages: ses.messages.map((m) => (m.id === msgId ? { ...m, streaming: false } : m)),
            updatedAt: Date.now()
          }))
        }
      })
      // 后台完成提醒：不在当前页时计未读
      if (useAgents.getState().selectedId !== agentId) useAgents.getState().bumpUnread(agentId)
      useAgents.getState().setStatus(agentId, 'available')
      persistAgent(agentId)
      return
    }

    if ((agent.kind === 'model' && agent.modelConfig) || (agent.kind === 'cli' && agent.cliConfig)) {
      // ---- 真实流式接入：自定义模型（OpenAI 兼容）或本机 CLI Agent ----
      const reqId = uid('req')
      const msgId = uid('msg')
      const replyMsg: ChatMessage = { id: msgId, role: 'assistant', text: '', ts: Date.now(), streaming: true, model: agent.model }
      set((s) => withActive(s, agentId, (ses) => ({ ...ses, messages: [...ses.messages, replyMsg] })))
      set((s) => ({ activeStreams: { ...s.activeStreams, [streamKey]: agentId } }))

      // CLI Agent 工作目录兜底（存量 Agent 未设 workDir 时）：默认文档工作区并持久化告知——
      // 不拦截对话，但绝不能让 CLI 在应用安装目录里执行（会污染程序文件）
      let cliWorkDir = agent.cliConfig?.workDir
      if (agent.kind === 'cli' && agent.cliConfig && !cliWorkDir) {
        const docs = useSettings.getState().appInfo?.documentsPath
        if (docs) {
          cliWorkDir = `${docs}\\AgentHub-workspaces\\${agent.cliConfig.cli}`
          useAgents.getState().updateAgent(agent.id, { cliConfig: { ...agent.cliConfig, workDir: cliWorkDir } })
          useUi.getState().toast(`该 Agent 未设工作目录，已默认使用 ${cliWorkDir}（可在顶栏"目录"修改）`, 'warn')
        }
      }

      // 携带最近的历史作为上下文（过长截断；真实工作流任务的完整上下文由 workflow 角色注入）
      const HISTORY_WINDOW = 24
      // 文本附件内容拼入本次 user 消息（真实模型/CLI 均可收到；binary 附件只保留引用不发送）
      const attachmentText = attachments
        .filter((a) => a.status === 'ok' && a.kind === 'text' && a.content !== undefined)
        .map((a) => `\n\n[附件：${a.name}]\n${a.content}`)
        .join('')
      // Skill 提示包：以 system 消息注入本次对话（CLI 由主进程 mergeMessages 折叠进 prompt 前缀）
      const skillBlock = skills?.length
        ? `【以下为本次对话引用的 Skill 提示包，请遵循其指令】\n\n${skills.map((s) => `### ${s.name}\n${s.content}`).join('\n\n')}`
        : ''
      const history = [
        ...(skillBlock ? [{ role: 'system', content: skillBlock }] : []),
        ...(activeOf(get(), agentId)?.messages ?? [])
        // 排除：报错消息（占位文本非模型输出）、演示消息、流式中的消息（含本轮刚 push 的空回复占位——
        // 思考模型+tools 协议要求所有 assistant 带 reasoning_content，空占位会导致 400）
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error && !m.demo && !m.streaming && m.id !== msgId)
        .slice(-HISTORY_WINDOW)
        .map((m) => ({
          role: m.role,
          content: m.id === userMsg.id ? m.text + attachmentText : m.text,
          // 思考模型协议（DeepSeek/方舟官方样例）：assistant 消息总是带 reasoning_content 字段
          // （无思考内容时为空串；非思考模型服务端会忽略该字段）
          ...(m.role === 'assistant' ? { reasoning_content: m.reasoning ?? '' } : {})
        }))
      ]

      let off = bridge.models.onEvent((ev) => {
        if (ev.reqId !== reqId) return
        if (ev.type === 'delta' && ev.text) {
          set((s) => withActive(s, agentId, (ses) => ({
            ...ses,
            messages: ses.messages.map((m) => (m.id === msgId ? { ...m, text: m.text + ev.text } : m))
          })))
        } else if (ev.type === 'reasoning' && ev.text) {
          // 思考模型的思考过程：追加到消息 reasoning 字段（UI 折叠展示；多轮对话回传协议）
          set((s) => withActive(s, agentId, (ses) => ({
            ...ses,
            messages: ses.messages.map((m) => (m.id === msgId ? { ...m, reasoning: (m.reasoning ?? '') + ev.text } : m))
          })))
        } else if (ev.type === 'notice' && ev.text) {
          // CLI 心跳提示（如 90 秒无输出可能卡在权限审批）：toast 一次，不打断消息
          useUi.getState().toast(ev.text, 'warn')
        } else if (ev.type === 'usage' && ev.usage) {
          // Token 用量：累计到 Agent（侧栏/设置展示）+ 明细落到本条消息（含估算费用）
          const usage = { tokens: ev.usage.tokens, prompt: ev.usage.prompt, completion: ev.usage.completion }
          if (ev.usage.tokens) useAgents.getState().addTokens(agentId, ev.usage.tokens)
          const cost = estimateCost(agent.modelConfig?.modelId ?? agent.model, usage)
          set((s) => withActive(s, agentId, (ses) => ({
            ...ses,
            messages: ses.messages.map((m) => (m.id === msgId ? { ...m, usage, ...(cost != null ? { cost } : {}) } : m))
          })))
        } else if (ev.type === 'tool' && ev.toolCall) {
          // 工具调用执行记录：合并进当前回复消息（同 id 更新状态与结果，新 id 追加）
          const tc = ev.toolCall
          set((s) => withActive(s, agentId, (ses) => ({
            ...ses,
            messages: ses.messages.map((m) => {
              if (m.id !== msgId) return m
              const calls = m.toolCalls ? [...m.toolCalls] : []
              const i = calls.findIndex((c) => c.id === tc.id)
              if (i >= 0) calls[i] = tc
              else calls.push(tc)
              return { ...m, toolCalls: calls }
            })
          })))
        } else if (ev.type === 'error') {
          // 错误（含 HTTP 4xx，如模型名不合法）：同样结束流并清理 activeStreams，
          // 否则流状态卡死、后续发送全部被"正在回复中"拒绝（实测踩坑）
          set((s) => {
            const activeStreams = { ...s.activeStreams }
            delete activeStreams[streamKey]
            return {
              activeStreams,
              ...withActive(s, agentId, (ses) => ({
                ...ses,
                messages: ses.messages.map((m) =>
                  m.id === msgId ? { ...m, streaming: false, error: ev.message ?? '未知错误' } : m
                )
              }))
            }
          })
          useAgents.getState().setStatus(agentId, 'failed')
        } else if (ev.type === 'done') {
          set((s) => {
            const activeStreams = { ...s.activeStreams }
            delete activeStreams[streamKey]
            return {
              activeStreams,
              ...withActive(s, agentId, (ses) => ({
                ...ses,
                messages: ses.messages.map((m) => (m.id === msgId ? { ...m, streaming: false } : m)),
                updatedAt: Date.now()
              }))
            }
          })
          if (useAgents.getState().selectedId !== agentId) useAgents.getState().bumpUnread(agentId)
          useAgents.getState().setStatus(agentId, 'available')
          persistAgent(agentId)
        }
      })

      const r = agent.kind === 'cli'
        ? await bridge.cli.chat(agent.cliConfig!.cli, { model: agent.cliConfig!.model, exePath: agent.cliConfig!.exePath, workDir: cliWorkDir, thinkingLevel: agent.cliConfig!.thinkingLevel }, reqId, history)
        : await bridge.models.chat(agent.modelConfig!, reqId, history, agent.tools ? { tools: agent.tools } : undefined)
      if (!r.ok) {
        set((s) => {
          const activeStreams = { ...s.activeStreams }
          delete activeStreams[streamKey]
          return {
            activeStreams,
            ...withActive(s, agentId, (ses) => ({
              ...ses,
              messages: ses.messages.map((m) =>
                m.id === msgId ? { ...m, streaming: false, error: agent.kind === 'cli' ? '请求未发出（CLI 不可用或已卸载）' : '请求未发出（缺少 API Key 或配置）' } : m
              )
            }))
          }
        })
        useAgents.getState().setStatus(agentId, 'failed')
      }
      // 注意：off 在 done/error 后仍保留监听（一次会话内事件有限，进程级泄漏可忽略）
      return
    }

    // 未知类型：如实提示
    const sysMsg: ChatMessage = {
      id: uid('msg'), role: 'system', text: '该 Agent 尚未连接，无法执行。请在"添加 Agent"中完成连接或选择演示 Agent。',
      ts: Date.now()
    }
    set((s) => withActive(s, agentId, (ses) => ({ ...ses, messages: [...ses.messages, sysMsg] })))
    agents.setStatus(agentId, 'awaiting')
  },

  newSession: (agentId) => {
    if (get().activeStreams[`chat:${agentId}`]) {
      useUi.getState().toast('回复进行中，稍后再开新会话', 'warn')
      return
    }
    const ns = mkSession(agentId)
    set((s) => ({
      sessions: { ...s.sessions, [agentId]: [ns, ...(s.sessions[agentId] ?? [])] },
      activeOf: { ...s.activeOf, [agentId]: ns.id }
    }))
    persistAgent(agentId)
    useUi.getState().toast('已开始新会话', 'ok')
  },

  switchSession: (agentId, sessionId) => {
    if (get().activeStreams[`chat:${agentId}`]) {
      useUi.getState().toast('回复进行中，稍后再切换会话', 'warn')
      return
    }
    const list = get().sessions[agentId]
    if (!list?.some((x) => x.id === sessionId)) return
    set((s) => ({ activeOf: { ...s.activeOf, [agentId]: sessionId } }))
    persistAgent(agentId)
  },

  renameSession: (agentId, sessionId, title) => {
    const t = title.trim().slice(0, 40)
    if (!t) return
    set((s) => ({
      sessions: {
        ...s.sessions,
        [agentId]: (s.sessions[agentId] ?? []).map((x) => (x.id === sessionId ? { ...x, title: t } : x))
      }
    }))
    persistAgent(agentId)
  },

  deleteSession: (agentId, sessionId) => {
    if (get().activeStreams[`chat:${agentId}`]) {
      useUi.getState().toast('回复进行中，稍后再删除会话', 'warn')
      return
    }
    set((s) => {
      const list = (s.sessions[agentId] ?? []).filter((x) => x.id !== sessionId)
      // 删空时保持至少一个默认会话（与"新会话"入口一致）
      const final = list.length > 0 ? list : [mkSession(agentId)]
      const cur = s.activeOf[agentId]
      const act = final.some((x) => x.id === cur) ? cur : final[0].id
      return { sessions: { ...s.sessions, [agentId]: final }, activeOf: { ...s.activeOf, [agentId]: act } }
    })
    persistAgent(agentId)
    useUi.getState().toast('会话已删除', 'ok')
  },

  exportSession: async (agentId) => {
    const agent = useAgents.getState().agents.find((a) => a.id === agentId)
    const ses = activeOf(get(), agentId)
    if (!ses || ses.messages.length === 0) {
      useUi.getState().toast('当前会话暂无记录可导出', 'info')
      return
    }
    const lines: string[] = [`# AgentHub 会话导出：${agent?.name ?? agentId}`, '', `> 会话：${ses.title}`, '']
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
    const name = safeName(`agenthub-chat-${agent?.name ?? agentId}-${ses.title}-${Date.now()}`) + '.md'
    const r = await bridge.dialogs.saveFile(name, lines.join('\n'))
    useUi.getState().toast(r.ok ? `已导出到 ${r.message}` : '已取消导出', r.ok ? 'ok' : 'info')
  },

  handoff: (fromId, toId) => {
    const agents = useAgents.getState()
    const from = agents.agents.find((a) => a.id === fromId)
    const to = agents.agents.find((a) => a.id === toId)
    if (!from || !to) return
    const fromSession = activeOf(get(), fromId)
    const lastAssistant = [...(fromSession?.messages ?? [])].reverse().find((m) => m.role === 'assistant')
    const note = demoHandoffNote(from.name, to.name, lastAssistant?.text ?? '（无最近结论可交接）')
    const msg: ChatMessage = {
      id: uid('msg'),
      role: 'system',
      text: note,
      ts: Date.now(),
      handoff: { fromAgentId: fromId, fromAgentName: from.name }
    }
    set((s) => withActive(s, toId, (ses) => ({ ...ses, messages: [...ses.messages, msg] })))
    persistAgent(toId)
    useUi.getState().toast(`已交接给 ${to.name}`, 'ok')
  }
}))

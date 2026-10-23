// 工作台聊天视图：消息流、跟随滚动、代码块复制、流式光标、交接入口、模型管理、用量显示
import React, { useEffect, useRef, useState } from 'react'
import type { ChatMessage, AgentConfig, AgentSession, ToolCall, Attachment, Skill, ThinkingLevel, McpServer } from '@shared/types'
import { useSessions } from '../stores/sessions'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { bridge } from '../lib/ipc'
import { Avatar, StatusDot, statusText, CopyButton, Button } from '../components/primitives'
import { Composer } from '../components/Composer'
import { Modal } from '../components/Modal'
import { Icon } from '../components/Icons'
import { CliModelOptions } from '../components/CliModels'
import { ThinkingText } from '../components/Thinking'
import { UsagePanel } from '../components/UsagePanel'
import { CheckpointBar } from '../components/CheckpointBar'
import { digestThinking } from '../lib/thinking'
import { fmtTime, fmtSize, fmtTokens, cls } from '../lib/utils'
import { contextWindowOf, estimateTokens, estimateCost, fmtCost, visionOf } from '@shared/pricing'

/** 稳定空数组：避免 selector 每次返回新引用导致多余渲染 */
const EMPTY_MSGS: ChatMessage[] = []

export function ChatView({ onHandoff }: { onHandoff: () => void }) {
  const agents = useAgents((s) => s.agents)
  const selectedId = useAgents((s) => s.selectedId)
  const colorOf = useAgents((s) => s.colorOf)
  // 直接订阅数据（而非 draftOf/messagesOf 函数引用）：否则 sessions 变化不触发重渲染，
  // 受控输入会被 React 重置回旧渲染值、发送按钮状态不更新（曾导致输入消失/演示 Agent 无输出）
  // 多会话：订阅会话数组与活跃 id，在组件内派生活跃会话（messages/draft 引用稳定）
  const sessionList = useSessions((s) => (selectedId ? s.sessions[selectedId] : undefined))
  const activeSesId = useSessions((s) => (selectedId ? s.activeOf[selectedId] : undefined))
  const setDraft = useSessions((s) => s.setDraft)
  const sendMessage = useSessions((s) => s.sendMessage)
  const newSession = useSessions((s) => s.newSession)
  const switchSession = useSessions((s) => s.switchSession)
  const renameSession = useSessions((s) => s.renameSession)
  const deleteSession = useSessions((s) => s.deleteSession)
  const exportSession = useSessions((s) => s.exportSession)
  const ensure = useSessions((s) => s.ensure)
  const homeDraft = useUi((s) => s.homeDraft)
  const setHomeDraft = useUi((s) => s.setHomeDraft)
  const enterToSend = useSettings((s) => s.prefs?.enterToSend ?? true)

  const agent = agents.find((a) => a.id === selectedId)
  const act = sessionList?.find((x) => x.id === activeSesId) ?? sessionList?.[sessionList.length - 1]
  const messages = act?.messages ?? EMPTY_MSGS
  const draft = act?.draft ?? ''

  useEffect(() => {
    if (selectedId) void ensure(selectedId)
  }, [selectedId, ensure])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const [mgmtOpen, setMgmtOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  const [sesOpen, setSesOpen] = useState(false)
  const [skillOpen, setSkillOpen] = useState(false)
  const skillBtnRef = useRef<HTMLButtonElement>(null)
  const sesBtnRef = useRef<HTMLButtonElement>(null)
  // 附件与 Skill 引用（随草稿所在会话；发送后清空）
  const [atts, setAtts] = useState<Attachment[]>([])
  const [pickedSkills, setPickedSkills] = useState<Skill[]>([])
  // 模型 Agent 余额（DeepSeek 官方接口；其他 provider 无余额接口时不显示）
  const [balance, setBalance] = useState<{ balance: number; currency: string } | null>(null)
  useEffect(() => {
    setAtts([])
    setPickedSkills([])
  }, [selectedId, activeSesId])
  useEffect(() => {
    setBalance(null)
    if (agent?.kind === 'model' && agent.modelConfig && /deepseek/i.test(agent.modelConfig.baseUrl)) {
      void bridge.models.balance(agent.modelConfig).then((r) => {
        if (r.ok && r.balance != null) setBalance({ balance: r.balance, currency: r.currency ?? 'CNY' })
      }).catch(() => { /* 余额查询失败静默：仅不显示 */ })
    }
  }, [agent?.id, agent?.modelConfig?.keyId])

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // 切换 Agent 或会话时恢复到底部
  useEffect(() => {
    scrollToBottom()
    setNearBottom(true)
    setNewCount(0)
  }, [selectedId, activeSesId])

  // 新内容到达：底部附近跟随；否则计数提示
  const lastLen = messages.length
  const lastMsgLen = messages.length ? messages[messages.length - 1].text.length : 0
  useEffect(() => {
    if (nearBottom) scrollToBottom()
    else if (lastLen > 0) setNewCount((c) => c + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLen, lastMsgLen])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nb = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setNearBottom(nb)
    if (nb) setNewCount(0)
  }

  if (!agent) return null

  const canSwitchModel = (agent.kind === 'model' && !!agent.modelConfig) || (agent.kind === 'cli' && !!agent.cliConfig)

  const doSend = () => {
    if (!draft.trim()) return
    // 图片要先过模型能力：明确不支持的直接拦下，未登记的提示后放行（不替服务端下结论）
    const imgs = atts.filter((a) => a.kind === 'image' && a.status === 'ok')
    if (imgs.length && agent.kind === 'model') {
      const v = visionOf(agent.modelConfig?.modelId ?? agent.model)
      if (v === 'no') {
        useUi.getState().toast(`当前模型（${agent.modelConfig?.modelId ?? agent.model}）不支持图片输入，请移除图片后再发送`, 'warn')
        return
      }
      if (v === 'unknown') useUi.getState().toast(`未登记「${agent.modelConfig?.modelId ?? agent.model}」是否支持图片，仍按多模态发送；若服务端报错请换支持视觉的模型`, 'info')
    }
    void sendMessage(agent.id, draft.trim(), atts, pickedSkills)
    setAtts([])
    setPickedSkills([])
  }

  return (
    <div className="wb-main">
      <div className="wb-topbar">
        <Avatar name={agent.name} color={colorOf(agent.id)} size={26} />
        <div>
          <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {agent.name}
            {agent.isDemo && <span className="demo-badge">演示模式</span>}
          </div>
          <div className="sub" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <StatusDot status={agent.status} /> {statusText(agent.status)} ·{' '}
          <button
            ref={sesBtnRef}
            className={`model-chip ${sesOpen ? 'open' : ''}`}
            onClick={() => setSesOpen((v) => !v)}
            title="会话列表：切换 / 新建 / 重命名 / 删除（草稿随会话保留）"
          >
            <Icon name="file" size={11} /> {act ? act.title : '会话'} <Icon name="chevron" size={10} />
          </button>
          {agent.tools?.access === 'full' && (
            <span className="full-access-badge" title="完全访问：文件工具不限目录、命令不限工作目录">完全访问</span>
          )}
          {agent.kind === 'model' && agent.modelConfig && (
            <button
              className="model-chip"
              onClick={() => setToolsOpen(true)}
              title="文件/命令/联网工具授权（沙箱或完全访问、命令执行开关、联网开关）"
            >
              <Icon name="file" size={11} /> 工具{agent.tools ? `·${[agent.tools.access === 'full' ? '完全访问' : '沙箱', agent.tools.allowCommands && (agent.tools.commandPolicy === 'auto' ? '命令·放行' : '命令·确认'), agent.tools.allowWeb && '联网'].filter(Boolean).join('·')}` : ''}
            </button>
          )}
          {agent.kind === 'cli' && agent.cliConfig && (
            <button
              className="model-chip"
              onClick={() => setDirOpen(true)}
              title="CLI 的工作目录（进程 cwd，其文件读写与命令执行都发生在此目录内）"
            >
              <Icon name="folder" size={11} /> {agent.cliConfig.workDir ? agent.cliConfig.workDir.split(/[\\/]/).pop() : '目录未设'}
            </button>
          )}
        </div>
        </div>
        {/* 兼容模式徽章不在这里挂：它单挂在 Shell（工作站/工作流两种模式共用一个挂载点），见 Shell.tsx */}
        <div className="spacer" />
        <Button variant="ghost" onClick={() => void exportSession(agent.id)} title="导出当前 Agent 的聊天记录为 Markdown">
          <Icon name="download" size={14} /> 导出会话
        </Button>
        <Button variant="ghost" onClick={onHandoff} title="把当前对话上下文交接给另一个 Agent">
          <Icon name="handoff" size={14} /> 交给其他 Agent
        </Button>
      </div>

      {mgmtOpen && <ModelManageModal agent={agent} onClose={() => setMgmtOpen(false)} />}
      {toolsOpen && <ToolsGrantModal agent={agent} onClose={() => setToolsOpen(false)} />}
      {dirOpen && <WorkDirModal agent={agent} onClose={() => setDirOpen(false)} />}
      {skillOpen && (
        <SkillPicker
          anchorRef={skillBtnRef}
          picked={pickedSkills}
          onToggle={(sk) => setPickedSkills((cur) => (cur.some((x) => x.id === sk.id) ? cur.filter((x) => x.id !== sk.id) : [...cur, sk]))}
          onManage={() => { setSkillOpen(false); useUi.getState().openSettings('skills') }}
          onClose={() => setSkillOpen(false)}
        />
      )}
      {sesOpen && (
        <SessionPanel
          list={sessionList ?? []}
          activeId={act?.id}
          anchorRef={sesBtnRef}
          onSwitch={(id) => { switchSession(agent.id, id); setSesOpen(false) }}
          onNew={() => { newSession(agent.id); setSesOpen(false) }}
          onRename={(id, title) => renameSession(agent.id, id, title)}
          onDelete={(id) => deleteSession(agent.id, id)}
          onClose={() => setSesOpen(false)}
        />
      )}

      {homeDraft.trim() && (
        <div style={{
          margin: '10px 24px 0', padding: '10px 14px', borderRadius: 'var(--r-md)',
          background: 'var(--warn-bg)', border: '1px solid rgba(180,83,9,0.3)', fontSize: 13, display: 'flex', gap: 10, alignItems: 'center'
        }}>
          <Icon name="info" size={15} />
          <div style={{ flex: 1, lineHeight: 1.55 }}>
            有一条来自首页的需求待发送：{homeDraft.length > 50 ? homeDraft.slice(0, 50) + '…' : homeDraft}
          </div>
          <Button variant="primary" style={{ height: 28 }} onClick={() => {
            setDraft(agent.id, homeDraft)
            setHomeDraft('')
          }}>填入输入框</Button>
          <Button variant="ghost" style={{ height: 28 }} onClick={() => setHomeDraft('')}>忽略</Button>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-list">
          {messages.length === 0 && <WelcomePanel agent={agent} />}
          {messages.map((m) => (
            <MessageRow key={m.id} msg={m} agentName={agent.name} agentColor={colorOf(agent.id)} />
          ))}
        </div>
      </div>

      {!nearBottom && (
        <button className="jump-bottom" onClick={() => { scrollToBottom(true); setNewCount(0) }}>
          <Icon name="down" size={13} />
          {newCount > 0 ? `${newCount} 条新内容 · 回到底部` : '回到底部'}
        </button>
      )}

      <div className="wb-composer-wrap">
        <ContextUsageBar
          agentId={agent.id}
          messages={messages}
          modelId={agent.modelConfig?.modelId ?? agent.model}
          contextWindow={contextWindowOf(agent.modelConfig?.modelId ?? agent.model, agent.modelConfig?.contextWindow ?? agent.cliConfig?.contextWindow)}
          agentName={agent.name}
          isDemo={!!agent.isDemo}
          onPickModel={canSwitchModel ? () => setMgmtOpen(true) : undefined}
          balance={balance}
          balanceSource={agent.modelConfig?.baseUrl}
        />
        <Composer
          value={draft}
          onChange={(v) => setDraft(agent.id, v)}
          onSend={doSend}
          enterToSend={enterToSend}
          placeholder={`给 ${agent.name} 发送消息…`}
          attachments={atts}
          onAttachmentsChange={setAtts}
          pickedSkills={pickedSkills}
          onSkillButtonRef={skillBtnRef}
          onOpenSkills={() => setSkillOpen((v) => !v)}
          onRemoveSkill={(id) => setPickedSkills((cur) => cur.filter((s) => s.id !== id))}
        />
      </div>
    </div>
  )
}

/** 对话栏底部条：模型选择 + 上下文用量 + 本会话消耗费用（用户要求这些信息离输入框最近） */
function ContextUsageBar({
  agentId,
  messages,
  modelId,
  contextWindow,
  agentName,
  isDemo,
  onPickModel,
  balance,
  balanceSource
}: {
  agentId: string
  messages: ChatMessage[]
  modelId?: string
  contextWindow: number
  agentName: string
  isDemo: boolean
  onPickModel?: () => void
  balance?: { balance: number; currency: string } | null
  balanceSource?: string
}) {
  const [usageOpen, setUsageOpen] = useState(false)
  // 有接口 usage 时以最后一条真实用量为准；否则按消息文本估算（含附件与思考内容）
  const lastUsage = [...messages].reverse().find((m) => m.usage?.tokens)?.usage
  const textTokens = messages.reduce((sum, m) => sum + estimateTokens(m.text ?? '') + estimateTokens(m.reasoning ?? '') + estimateTokens(m.toolCalls?.map((t) => (t.result ?? '')).join('') ?? ''), 0)
  const used = Math.max(lastUsage?.prompt != null ? lastUsage.prompt + (lastUsage.completion ?? 0) : 0, textTokens)
  const pct = Math.min(100, Math.round((used / contextWindow) * 1000) / 10)
  const tone = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--ok)'
  const sessionCost = messages.reduce((s, m) => s + (m.cost ?? 0), 0)
  const sessionTokens = messages.reduce((s, m) => s + (m.usage?.tokens ?? 0), 0)
  return (
    <div className="ctx-bar" title={`上下文用量：当前会话约 ${fmtTokens(used)} / ${fmtTokens(contextWindow)} tokens${modelId ? `（${modelId}）` : ''}。实际计费以接口返回为准。`}>
      {onPickModel ? (
        <button className="model-chip" onClick={onPickModel} title="模型管理：切换模型、思考强度（支持的 harness）、上下文窗口">
          {modelId ?? agentName} <Icon name="chevron" size={10} />
        </button>
      ) : (
        <span className="model-chip" title="该 Agent 的模型由接入方自身决定">{modelId ?? agentName}</span>
      )}
      <div className="ctx-track">
        <div className="ctx-fill" style={{ width: `${Math.max(pct, used > 0 ? 1.5 : 0)}%`, background: tone }} />
      </div>
      <span className="ctx-text" style={{ color: tone }}>
        上下文 {fmtTokens(used)} / {fmtTokens(contextWindow)}（{pct}%）
      </span>
      <span className="ctx-text" title={isDemo ? '演示数据：费用为脚本内容，不代表真实计费' : '本会话累计消耗（有接口 usage 时按真实用量折算）'}>
        本会话 {sessionTokens > 0 ? `${fmtTokens(sessionTokens)} tokens · ` : ''}{fmtCost(sessionCost)}
      </span>
      {/* 用量快捷入口：一个图标点开本 Agent 的调用账本，不用跑去设置页翻 */}
      <button className="icon-btn usage-open" title="用量统计（本 Agent 的调用与费用）" aria-label="用量统计" onClick={() => setUsageOpen(true)}>
        <Icon name="chart" size={15} />
      </button>
      {usageOpen && (
        <Modal open onClose={() => setUsageOpen(false)} title={`用量统计 · ${agentName}`} width={720}>
          <UsagePanel agentId={agentId} />
        </Modal>
      )}
      {balance && (
        <span className="model-chip" title={`来自 ${balanceSource} 的账户余额（DeepSeek 官方接口）`}>
          余额 {balance.currency === 'CNY' ? '¥' : ''}{balance.balance.toFixed(2)}
        </span>
      )}
    </div>
  )
}

function MessageRow({ msg, agentName, agentColor }: { msg: ChatMessage; agentName: string; agentColor: string }) {
  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div>
          <div className="bubble word-break">
            {msg.text}
            {msg.skills && msg.skills.length > 0 && (
              <div className="att-line">Skill：{msg.skills.join('、')}</div>
            )}
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="att-line">
                附件：{msg.attachments.map((a) => a.name).join('、')}
              </div>
            )}
          </div>
          <div className="msg-time">{fmtTime(msg.ts)}</div>
        </div>
      </div>
    )
  }
  return (
    <div className={cls('msg', msg.role === 'system' ? 'system' : 'assistant')}>
      {msg.role === 'assistant' && <Avatar name={agentName} color={agentColor} size={30} />}
      <div>
        {msg.role === 'system' && msg.handoff && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 3 }}>
            交接自 {msg.handoff.fromAgentName} <Icon name="handoff" size={11} />
          </div>
        )}
        {msg.toolCalls && msg.toolCalls.length > 0 && msg.toolCalls.map((tc) => (
          <ToolCallCard key={tc.id} tc={tc} />
        ))}
        {msg.reasoning && msg.reasoning.trim() && <ReasoningBlock text={msg.reasoning} streaming={msg.streaming && !msg.text} />}
        {(msg.text || !msg.toolCalls?.length) && (
          <div className={cls('bubble word-break')}>
            <MessageBody text={msg.text} />
            {msg.streaming && <span className="caret" />}
            {msg.error && <div className="err">⚠ {msg.error}</div>}
            {msg.demo && !msg.streaming && (
              <div style={{ marginTop: 6 }}>
                <span className="demo-badge">演示数据 · 非真实模型输出</span>
              </div>
            )}
          </div>
        )}
        {msg.checkpoint && !msg.streaming && <CheckpointBar id={msg.checkpoint} title="这次回复改动的文件" />}
        <div className="msg-time">
          {fmtTime(msg.ts)}
          {msg.model && ` · ${msg.model}`}
          {msg.usage?.tokens ? ` · ${fmtTokens(msg.usage.tokens)} tk${msg.usage.prompt != null ? `（入 ${fmtTokens(msg.usage.prompt)}/出 ${fmtTokens(msg.usage.completion ?? 0)}）` : ''}${msg.cost != null ? ` · ${fmtCost(msg.cost)}` : ''}` : ''}
          {msg.attachments && msg.attachments.length > 0 && ` · 附件 ${msg.attachments.length} 个${msg.attachments[0].size ? `（${fmtSize(msg.attachments[0].size)}）` : ''}`}
        </div>
      </div>
    </div>
  )
}

/** 会话面板：列表 / 切换 / 重命名 / 删除（fixed 定位防滚动容器裁切；空间不足自动上翻） */
function SessionPanel({ list, activeId, anchorRef, onSwitch, onNew, onRename, onDelete, onClose }: {
  list: AgentSession[]
  activeId?: string
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onSwitch: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // 定位：锚点下方 8px；下方空间不足时上翻
  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const needH = Math.min(340, list.length * 54 + 88)
    const top = window.innerHeight - r.bottom >= needH ? r.bottom + 8 : Math.max(12, r.top - needH - 8)
    setPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - 304)), top })
  }, [anchorRef, list.length])

  // Escape 关闭；点击面板/锚点之外关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [anchorRef, onClose])

  const commitEdit = () => {
    if (editingId && editText.trim()) onRename(editingId, editText)
    setEditingId(null)
  }

  if (!pos) return null
  return (
    <div ref={ref} className="ses-panel" style={pos} role="menu" aria-label="会话列表">
      <div className="ses-head">
        <span>会话（{list.length}）</span>
        <button className="ses-new" onClick={onNew}><Icon name="plus" size={12} /> 新会话</button>
      </div>
      <div className="ses-list">
        {list.map((s) => (
          <div
            key={s.id}
            className={`ses-item ${s.id === activeId ? 'active' : ''}`}
            onClick={() => { if (editingId !== s.id) onSwitch(s.id) }}
          >
            {editingId === s.id ? (
              <input
                autoFocus
                className="ses-edit"
                value={editText}
                maxLength={40}
                onChange={(e) => setEditText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onBlur={commitEdit}
              />
            ) : (
              <>
                <div className="ses-meta">
                  <div className="ses-title">{s.title}</div>
                  <div className="ses-sub">{s.messages.length} 条 · {fmtTime(s.createdAt)}</div>
                </div>
                <button
                  className="ses-act"
                  title="重命名"
                  onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditText(s.title) }}
                >
                  <Icon name="edit" size={12} />
                </button>
                <button
                  className="ses-act danger"
                  title="删除会话"
                  onClick={(e) => { e.stopPropagation(); onDelete(s.id) }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 文本 + ```代码块``` 渲染（代码块带复制按钮，不横向撑破） */
export function MessageBody({ text }: { text: string }) {
  const parts = text.split(/```/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <div key={i} className="codeblock" style={{ margin: '8px 0' }}>
            <button
              className="copy"
              onClick={() => void navigator.clipboard.writeText(p)}
            >
              复制
            </button>
            {p.replace(/^\w*\n/, '')}
          </div>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        )
      )}
    </>
  )
}

/** 空会话欢迎面板（文档一.2）：当前执行环境 + 可点击任务示例（仅填草稿）+ 最近真实任务 */
function WelcomePanel({ agent }: { agent: AgentConfig }) {
  const setDraft = useSessions((s) => s.setDraft)
  const [runs, setRuns] = useState<{ goal: string; status: string; startedAt: number }[] | null>(null)

  useEffect(() => {
    let off = false
    void bridge.runs.list()
      .then((rs) => {
        if (off) return
        setRuns(
          [...rs]
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 3)
            .map((r) => ({ goal: r.goal, status: r.status, startedAt: r.startedAt }))
        )
      })
      .catch(() => { if (!off) setRuns([]) })
    return () => { off = true }
  }, [])

  const EXAMPLES: Record<string, string[]> = {
    demo: ['介绍一下你自己和这个应用', '演示一次多轮对话', '展示你能做什么'],
    model: ['帮我总结一份文档的要点', '把一段代码翻译成 Python 并解释差异', '帮我起草一封简洁的邮件'],
    cli: ['在当前工作目录里写一个脚本并运行', '解释一段报错日志的原因', '查看工作目录并整理文件清单']
  }
  const examples = EXAMPLES[agent.kind] ?? EXAMPLES.demo

  const envLine: string[] = []
  if (agent.isDemo) envLine.push('演示模式（脚本化回复）')
  else {
    envLine.push(agent.model || '未设置模型')
    if (agent.kind === 'cli' && agent.cliConfig?.workDir) envLine.push(`工作目录：${agent.cliConfig.workDir}`)
    if (agent.kind === 'model' && agent.tools) envLine.push(`文件工具：${agent.tools.dir}${agent.tools.allowCommands ? '（含命令）' : ''}`)
    if (agent.kind === 'cli' && !agent.cliConfig?.workDir) envLine.push('工作目录：未设置（顶栏可配置）')
    if (agent.kind === 'model' && !agent.tools) envLine.push('文件工具：未启用（顶栏可配置）')
  }

  return (
    <div className="empty-state card-enter" style={{ padding: '6vh 20px', maxWidth: 620, margin: '0 auto' }}>
      <div className="title">和 {agent.name} 开始对话</div>
      <div className="desc">{agent.isDemo ? '回复为脚本化内容，用于体验界面与交互。' : '发送内容将通过已连接的接口真实送达。'}</div>
      <div className="wp-env">
        {envLine.map((e, i) => (
          <span key={i} className="wp-env-chip" title={e}>{e}</span>
        ))}
        <span className="wp-env-hint">模型 / 目录 / 工具可在顶栏调整</span>
      </div>
      <div className="wp-examples">
        {examples.map((ex) => (
          <button key={ex} className="wp-example" onClick={() => setDraft(agent.id, ex)} title="点击填入输入框，确认后再发送">
            {ex}
          </button>
        ))}
      </div>
      {runs !== null && (
        <div className="wp-runs">
          <div className="wp-runs-title">最近任务</div>
          {runs.length === 0 && <div className="wp-runs-empty">暂无历史任务</div>}
          {runs.map((r) => (
            <button key={r.startedAt} className="wp-run" onClick={() => setDraft(agent.id, r.goal)} title="点击把该目标填入输入框">
              <span className="wp-run-status">{r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : '·'}</span>
              <span className="wp-run-goal">{r.goal.length > 40 ? r.goal.slice(0, 40) + '…' : r.goal}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 思考过程块（思考模型 reasoning_content）：默认折叠，点击展开；流式期间显示进行中 */
function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  const lines = text.split('\n').filter((l) => l.trim()).length
  const digest = digestThinking(text)
  return (
    <div className="reasoning-block">
      <button className="rb-head" onClick={() => setOpen((v) => !v)} title="思考模型的思考过程（随消息保存；工具循环默认不回传给接口，避免严格接口报 400，可用 AGENTHUB_PASS_REASONING=1 开启）">
        <Icon name={open ? 'chevron' : 'up'} size={11} />
        <span>{streaming ? '思考中…' : '思考过程'}</span>
        <span className="rb-meta">
          {streaming
            ? `${text.length} 字`
            : `${lines} 行 · ${text.length} 字${digest.restCount > 0 ? ` · 默认只显重点（其余 ${digest.restCount} 段可展开）` : ''}`}
        </span>
      </button>
      {open && <div className="rb-body"><ThinkingText text={text} streaming={streaming} /></div>}
    </div>
  )
}

/** 工具调用卡片：真实执行的文件读写/命令记录（状态、参数、结果可展开） */
function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false)
  const TOOL_TEXT: Record<string, string> = {
    // AgentHub 模型 Agent 沙箱工具
    read_file: '读取文件',
    write_file: '写入文件',
    list_dir: '列出目录',
    delete_file: '删除（回收站）',
    move: '移动/重命名',
    run_command: '执行命令',
    search_files: '搜索文本',
    glob_files: '查找文件',
    replace_in_file: '替换内容',
    web_fetch: '抓取网页',
    web_search: '联网搜索',
    // CLI Agent 透传（Claude Code / CodeBuddy 的工具名 + codex 的事件）
    Read: '读取文件',
    Write: '写入文件',
    Edit: '编辑文件',
    Bash: '执行命令',
    Glob: '查找文件',
    Grep: '搜索文本',
    Task: '子任务',
    WebFetch: '抓取网页',
    WebSearch: '联网搜索',
    TodoWrite: '待办清单',
    file_change: '文件变更'
  }
  const argLine = Object.entries(tc.args)
    .map(([k, v]) => `${k}: ${v.length > 60 ? v.slice(0, 60) + '…' : v}`)
    .join(' · ')
  return (
    <div
      className="tool-call-card"
      style={{
        margin: '4px 0 6px', padding: '7px 10px', borderRadius: 'var(--r-sm)',
        border: `1px solid ${tc.status === 'error' ? 'rgba(220,38,38,.35)' : 'var(--border)'}`,
        background: tc.status === 'error' ? 'var(--danger-bg, rgba(220,38,38,.06))' : 'var(--surface-2)',
        fontSize: 12, lineHeight: 1.5
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center', width: '100%', boxSizing: 'border-box' }}
      >
        <Icon name={tc.tool === 'run_command' ? 'terminal' : 'file'} size={12} />
        <b style={{ flexShrink: 0 }}>{TOOL_TEXT[tc.tool] ?? tc.tool}</b>
        <span style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {argLine}
        </span>
        <span style={{ flexShrink: 0, color: tc.status === 'error' ? 'var(--danger)' : tc.status === 'running' ? 'var(--text-3)' : 'var(--ok)' }}>
          {tc.status === 'running' ? '执行中…' : tc.status === 'error' ? '失败' : '完成'}
        </span>
      </button>
      {open && tc.hooks?.length && (
        <div className="tool-diff" data-tool-hooks>
          {tc.hooks.map((h, i) => (
            <div key={`${h.id}-${i}`}>
              <b style={{ color: h.blocked ? 'var(--danger)' : 'var(--text-3)' }}>
                Hook {h.id} · 退出码 {h.exit ?? 'null'}{h.timedOut ? ' · 超时' : ''}{h.blocked ? ' · 已否决本次调用' : ''}
              </b>
              <div>{h.command}</div>
              {h.output && <div style={{ whiteSpace: 'pre-wrap' }}>{h.output}</div>}
            </div>
          ))}
        </div>
      )}
      {open && tc.change?.diff && (
        <div className="tool-diff" data-tool-diff>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
            {tc.change.kind === 'created' ? '新建文件' : tc.change.kind === 'modified' ? '改动内容' : '改动记录'}
            {tc.change.unbacked ? ` · 未纳入回滚：${tc.change.unbacked}` : ''}
          </div>
          {tc.change.diff}
        </div>
      )}
      {open && tc.result && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)', color: 'var(--text-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflowY: 'auto' }}>
          {tc.result}
        </div>
      )}
    </div>
  )
}

/** 工具授权弹窗（Agent 级授权制）：沙箱目录 + 命令执行开关 */
function ToolsGrantModal({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const updateAgent = useAgents((s) => s.updateAgent)
  const [enabled, setEnabled] = useState(!!agent.tools)
  const [dir, setDir] = useState(agent.tools?.dir ?? '')
  const [allowCommands, setAllowCommands] = useState(!!agent.tools?.allowCommands)
  const [allowWeb, setAllowWeb] = useState(!!agent.tools?.allowWeb)
  const [fullAccess, setFullAccess] = useState(agent.tools?.access === 'full')
  const [riskAck, setRiskAck] = useState(false)
  const [commandPolicy, setCommandPolicy] = useState<'ask' | 'auto'>(agent.tools?.commandPolicy ?? 'ask')
  const [previewWrites, setPreviewWrites] = useState(!!agent.tools?.previewWrites)
  // 白名单存在主进程 approvals.json（不在 agent config 里）：渲染层只能显式提交新规则
  const [rules, setRules] = useState<string[]>([])
  const [ruleDraft, setRuleDraft] = useState('')
  // MCP：server 列表是全局的，这里只做"这个 Agent 能用哪几个"的勾选
  const [mcpList, setMcpList] = useState<McpServer[]>([])
  const [mcpIds, setMcpIds] = useState<string[]>(agent.tools?.mcpServerIds ?? [])
  useEffect(() => {
    void bridge.mcp.list().then(setMcpList)
  }, [])
  useEffect(() => {
    let alive = true
    void bridge.approval.rules(agent.id).then((r) => {
      if (alive) setRules(r)
    })
    return () => {
      alive = false
    }
  }, [agent.id])

  const save = () => {
    if (!enabled) {
      updateAgent(agent.id, { tools: undefined })
      useUi.getState().toast('已关闭文件工具，恢复纯对话', 'ok')
      onClose()
      return
    }
    if (!dir.trim() && !fullAccess) return
    // 完全访问必须勾选风险确认才允许保存
    if (fullAccess && !riskAck) {
      useUi.getState().toast('请先勾选确认"我已知晓完全访问的风险"', 'warn')
      return
    }
    const tools = {
      dir: dir.trim(),
      allowCommands,
      allowWeb,
      ...(fullAccess ? { access: 'full' as const } : {}),
      ...(allowCommands ? { commandPolicy } : {}),
      ...(previewWrites ? { previewWrites: true } : {}),
      ...(mcpIds.length ? { mcpServerIds: mcpIds } : {})
    }
    updateAgent(agent.id, { tools })
    void bridge.approval.setRules(agent.id, rules.map((r) => r.trim()).filter(Boolean))
    useUi.getState().toast(
      fullAccess
        ? `已启用完全访问（文件全盘 + 命令不限目录${allowCommands ? '' : '；命令未授权'}${allowWeb ? '，联网' : ''}）`
        : `已启用工具（沙箱：${tools.dir}${allowCommands ? `，命令${commandPolicy === 'ask' ? '（逐条确认）' : '（授权即放行）'}` : ''}${allowWeb ? '，联网' : ''}）`,
      'ok'
    )
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${agent.name} · 文件/命令工具`}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} disabled={enabled && !dir.trim() && !fullAccess}>保存</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 6 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ marginTop: 3 }} />
          <span style={{ lineHeight: 1.6 }}>
            <b>启用文件工具</b>
            <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
              开启即授权该模型进行文件操作与（可选）命令/联网。未开启时为纯对话（如实无文件能力）。所有调用过程在对话中如实展示并随记录保存。
            </div>
          </span>
        </label>
        {enabled && (
          <>
            {/* 权限两档：沙箱 / 完全访问 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px' }}>
                <input type="radio" name="access-mode" checked={!fullAccess} onChange={() => { setFullAccess(false); setRiskAck(false) }} style={{ marginTop: 3 }} />
                <span style={{ lineHeight: 1.6 }}>
                  <b>沙箱模式</b>（默认，推荐）
                  <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                    文件操作全部限制在下方目录内（路径规范化后越界即拒绝）；命令以该目录为工作目录执行。删除走系统回收站可恢复。
                  </div>
                </span>
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', border: fullAccess ? '1px solid var(--danger)' : '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px', background: fullAccess ? 'rgba(220,38,38,.06)' : 'transparent' }}>
                <input type="radio" name="access-mode" checked={fullAccess} onChange={() => setFullAccess(true)} style={{ marginTop: 3 }} />
                <span style={{ lineHeight: 1.6 }}>
                  <b style={{ color: fullAccess ? 'var(--danger)' : undefined }}>完全访问</b>
                  <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                    文件工具不再限制目录（可读写<b>全盘</b>任意路径）；命令不限工作目录。适用于你充分信任该模型/任务的场景；开启后顶栏持续显示红色"完全访问"标识。
                  </div>
                </span>
              </label>
              {fullAccess && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', padding: '10px 12px', background: 'rgba(220,38,38,.08)' }}>
                  <input type="checkbox" checked={riskAck} onChange={(e) => setRiskAck(e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ lineHeight: 1.6, color: 'var(--danger)', fontSize: 12.5 }}>
                    <b>我已知晓风险：</b>完全访问下模型可读写全盘文件、执行不限目录的命令，可能修改或删除本机任意数据。请仅对可信模型开启，并自行承担后果。
                  </span>
                </label>
              )}
            </div>
            <div className="form-row">
              <label>{fullAccess ? '工作目录（命令默认 cwd，可留空）' : '沙箱目录（产物根）'}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder={fullAccess ? '例如 D:\\工作区（留空则不固定 cwd）' : '例如 D:\\AgentHub\\产物\\该Agent名'}
                  style={{ flex: 1 }}
                />
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const p = await bridge.tools.pickDir()
                    if (p) setDir(p)
                  }}
                >
                  选择…
                </Button>
              </div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ lineHeight: 1.6 }}>
                <b>允许执行命令</b>（默认关）
                <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                  开启后模型可执行 shell 命令（{fullAccess ? '完全访问下不限制工作目录' : '工作目录固定为上方目录'}，超时 60 秒、输出有上限）。用于构建/测试产物；每条命令与输出都会在对话中展示。风险高于文件读写，请谨慎开启。
                </div>
              </span>
            </label>
            {allowCommands && (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px' }}
                data-testid="command-approval-block"
              >
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>命令审批</div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="radio" name="command-policy" checked={commandPolicy === 'ask'} onChange={() => setCommandPolicy('ask')} style={{ marginTop: 3 }} />
                  <span style={{ lineHeight: 1.6, fontSize: 12.5 }}>
                    <b>逐条确认</b>（默认）
                    <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                      不在下方白名单里的命令会弹窗问你：本次允许 / 始终允许（写进白名单）/ 拒绝。180 秒没人确认按拒绝收场，不会替你放行。
                    </div>
                  </span>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="radio" name="command-policy" checked={commandPolicy === 'auto'} onChange={() => setCommandPolicy('auto')} style={{ marginTop: 3 }} />
                  <span style={{ lineHeight: 1.6, fontSize: 12.5 }}>
                    授权即放行（旧行为）
                    <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                      勾了"允许执行命令"就不再逐条确认。无人值守跑长工作流时用；审批历史仍会记录每次工具调用。
                    </div>
                  </span>
                </label>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  白名单规则：整段相等才放行，以 <code>*</code> 结尾才是前缀放行（如 <code>npm run *</code>）。
                  命令里的 <code>&amp;&amp;</code>、<code>|</code> 会拆开逐段核对，一段没过就整条问。
                  危险形态（rm -rf、del /s、format、curl | sh、git push --force 等）<b>白名单覆盖不了</b>，永远要确认。
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {rules.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>（还没有规则，第一条命令就会弹确认）</div>}
                  {rules.map((r, i) => (
                    <div key={`${r}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>{r}</code>
                      <Button variant="ghost" onClick={() => setRules(rules.filter((_, n) => n !== i))}>删除</Button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={ruleDraft}
                    onChange={(e) => setRuleDraft(e.target.value)}
                    placeholder="新增一条规则，例如 npm run build"
                    style={{ flex: 1 }}
                    data-testid="command-rule-input"
                  />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const v = ruleDraft.trim().toLowerCase()
                      if (!v) return
                      if (!rules.includes(v)) setRules([...rules, v])
                      setRuleDraft('')
                    }}
                  >
                    添加
                  </Button>
                </div>
              </div>
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={previewWrites} onChange={(e) => setPreviewWrites(e.target.checked)} style={{ marginTop: 3 }} data-testid="preview-writes" />
              <span style={{ lineHeight: 1.6 }}>
                <b>覆盖已有文件前先看 diff</b>（默认关）
                <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                  开启后 write_file / replace_in_file 撞到已存在的文件会先弹出行级 diff 让你确认；新建文件不打扰。
                  关掉时改动仍然会进检查点，事后可看 diff、可回滚。
                </div>
              </span>
            </label>
            {mcpList.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px' }} data-testid="mcp-grant-block">
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>MCP 工具（这个 Agent 能用哪几个）</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
                  勾选只是"能不能看到这个 server 的工具"，第一次连它仍会弹窗确认；列表与信任都在「设置 → MCP」。
                </div>
                {mcpList.map((s) => {
                  const on = mcpIds.includes(s.id)
                  return (
                    <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => setMcpIds(on ? mcpIds.filter((x) => x !== s.id) : [...mcpIds, s.id])}
                      />
                      <span>{s.name}</span>
                      {s.enabled === false && <span style={{ color: 'var(--warn)', fontSize: 11.5 }}>（在设置里已停用）</span>}
                    </label>
                  )
                })}
              </div>
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={allowWeb} onChange={(e) => setAllowWeb(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ lineHeight: 1.6 }}>
                <b>允许联网</b>（默认关）
                <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                  开启后模型可抓取网页（web_fetch，HTML 自动转文本）与联网搜索（web_search，DuckDuckGo 无需 Key、非官方接口稳定性一般）。仅允许 http/https，响应大小与超时有限制；每次请求在对话中展示。
                </div>
              </span>
            </label>
            <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>
              {fullAccess
                ? '完全访问：文件读写/删除/移动不限目录；命令不限工作目录；删除仍走系统回收站；工具调用轮数上限 16 轮。搜索/查找类工具仍以上方目录为范围（避免全盘扫描）。'
                : '沙箱模式：路径规范化后越出沙箱目录的调用一律拒绝；删除走系统回收站可恢复；工具调用轮数有上限（16 轮）。'}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
/** CLI Agent 工作目录弹窗（方案1 边界）：CLI 进程 cwd，其文件读写与命令执行都发生在此目录内 */
function WorkDirModal({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const updateAgent = useAgents((s) => s.updateAgent)
  const [dir, setDir] = useState(agent.cliConfig?.workDir ?? '')

  const save = () => {
    const v = dir.trim()
    updateAgent(agent.id, {
      cliConfig: { ...agent.cliConfig!, workDir: v || undefined }
    })
    useUi.getState().toast(v ? `工作目录已设置：${v}（CLI 的文件操作将发生在此目录内）` : '已恢复默认（文档目录下的 AgentHub-workspaces，首次使用时自动创建）', 'ok')
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${agent.name} · 工作目录`}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save}>保存</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 6 }}>
        <div className="form-row">
          <label>工作目录（CLI 进程 cwd）</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="留空使用应用默认目录"
              style={{ flex: 1 }}
            />
            <Button
              variant="secondary"
              onClick={async () => {
                const p = await bridge.tools.pickDir()
                if (p) setDir(p)
              }}
            >
              选择…
            </Button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>
          CLI 执行时以其为工作目录：<b>文件读写、命令执行都发生在此目录内</b>（如 claude/codex 产出的代码文件会写到这里）。
          留空则跟随应用进程目录。注意：这是 CLI 自身能力的边界约定，AgentHub 不额外拦截其操作；目录不存在时执行会如实报错。
          配置按 Agent 分别保存，重启后保留。
        </div>
      </div>
    </Modal>
  )
}

/** 模型管理弹窗：全部 Agent 类型统一入口——切换模型、思考强度（支持的 harness 才显示）、上下文窗口 */
function ModelManageModal({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const updateAgent = useAgents((s) => s.updateAgent)
  const [models, setModels] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState(agent.cliConfig?.model ?? '')
  const thinkingSupported =
    (agent.kind === 'model' && !!agent.modelConfig && (/^(o1|o3|gpt-5)/i.test(agent.modelConfig.modelId) || /ark/i.test(agent.modelConfig.baseUrl)))
    || (agent.kind === 'cli' && (agent.cliConfig?.cli === 'codex' || agent.cliConfig?.cli === 'claude'))
  const thinking: ThinkingLevel | undefined = agent.kind === 'model' ? agent.modelConfig?.thinkingLevel : agent.cliConfig?.thinkingLevel
  const ctxWindow = agent.kind === 'model' ? agent.modelConfig?.contextWindow : agent.cliConfig?.contextWindow
  const [ctxText, setCtxText] = useState(ctxWindow ? String(Math.round(ctxWindow / 1024)) : '')

  useEffect(() => {
    if (agent.kind === 'model' && agent.modelConfig) {
      void bridge.models.list(agent.modelConfig).then((r) => {
        if (r.ok && r.models) setModels(r.models)
        else setErr(r.message ?? '获取模型列表失败')
      })
    }
  }, [agent])

  const patch = (p: Partial<Pick<AgentConfig, 'model'>> & { modelConfig?: AgentConfig['modelConfig']; cliConfig?: AgentConfig['cliConfig'] }) => {
    updateAgent(agent.id, p)
  }

  const THINK_LEVELS: { v: ThinkingLevel; label: string }[] = [
    { v: 'off', label: '关闭（默认）' },
    { v: 'low', label: '低' },
    { v: 'medium', label: '中' },
    { v: 'high', label: '高' }
  ]

  return (
    <Modal
      open
      onClose={onClose}
      title={`${agent.name} · 模型管理`}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>完成</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 6 }}>
        {agent.isDemo && (
          <div style={{ fontSize: 12.5, color: 'var(--warn)', lineHeight: 1.6 }}>
            演示 Agent 使用脚本化回复，不涉及真实模型，无模型参数可调。
          </div>
        )}

        {/* 模型切换（自定义模型走真实 /models 列表；CLI 走可枚举清单+手填） */}
        {agent.kind === 'model' && agent.modelConfig && (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.6 }}>
              列表来自该连接的真实 /models 接口；切换后<b>沿用当前对话上下文</b>。
            </div>
            {err && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 6 }}>{err}</div>}
            {!models && !err && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>正在获取模型列表…</div>}
            {models && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                {models.map((m) => {
                  const cur = m === agent.modelConfig!.modelId
                  return (
                    <button
                      key={m}
                      disabled={cur}
                      className="btn"
                      style={{
                        justifyContent: 'flex-start', height: 30, fontSize: 12.5,
                        ...(cur ? { border: '1px solid var(--brand-yellow)', color: 'var(--text-2)', background: 'var(--surface-2)', cursor: 'default' } : { border: '1px solid var(--border)', background: 'var(--surface)' })
                      }}
                      onClick={() => { patch({ model: m, modelConfig: { ...agent.modelConfig!, modelId: m } }); useUi.getState().toast(`已切换模型：${m}（后续请求生效）`, 'ok') }}
                    >
                      {m} {cur && '· 当前'}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {agent.kind === 'cli' && agent.cliConfig && (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.6 }}>
              作为 --model 参数传给 CLI；留空使用 CLI 自身配置的默认模型。
            </div>
            <CliModelOptions cli={agent.cliConfig.cli} current={manual} onPick={setManual} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="留空使用 CLI 默认模型" style={{ flex: 1 }} />
              <Button variant="primary" onClick={() => {
                const v = manual.trim()
                patch({ model: v || '默认（CLI 自身配置）', cliConfig: { ...agent.cliConfig!, model: v || undefined } })
                useUi.getState().toast(v ? `已切换模型参数：${v}` : '已恢复为 CLI 默认模型', 'ok')
              }}>保存模型</Button>
            </div>
          </div>
        )}

        {/* 思考强度：仅官方支持的 harness 显示 */}
        {!agent.isDemo && (
          <div>
            <label style={{ fontSize: 12.5, fontWeight: 600 }}>思考强度</label>
            {thinkingSupported ? (
              <>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  {THINK_LEVELS.map((t) => (
                    <button
                      key={t.v}
                      className={`btn ${thinking === t.v ? 'btn-primary' : ''}`}
                      style={{ flex: 1, height: 28, fontSize: 12 }}
                      onClick={() => {
                        if (agent.kind === 'model' && agent.modelConfig) patch({ modelConfig: { ...agent.modelConfig, thinkingLevel: t.v } })
                        else if (agent.kind === 'cli' && agent.cliConfig) patch({ cliConfig: { ...agent.cliConfig, thinkingLevel: t.v } })
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 5, lineHeight: 1.5 }}>
                  {agent.kind === 'cli' && agent.cliConfig?.cli === 'codex'
                    ? '透传为 codex 的 model_reasoning_effort 配置项。'
                    : agent.kind === 'cli' && agent.cliConfig?.cli === 'claude'
                      ? '透传为 Claude Code 的 MAX_THINKING_TOKENS 思考预算。'
                      : '透传为接口的 reasoning_effort 参数（该模型官方支持）。'}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
                当前接入不提供思考强度参数（不显示假选项）。如需思考能力，可换用支持该参数的模型或 CLI。
              </div>
            )}
          </div>
        )}

        {/* 上下文窗口：用于上方上下文用量条的分母 */}
        {!agent.isDemo && (
          <div className="form-row">
            <label>上下文窗口（K tokens，用于用量显示）</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={ctxText}
                onChange={(e) => setCtxText(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={`默认 ${Math.round(contextWindowOf(agent.modelConfig?.modelId ?? agent.model) / 1024)}`}
                style={{ flex: 1 }}
              />
              <Button variant="primary" onClick={() => {
                const k = Number(ctxText)
                const v = Number.isFinite(k) && k > 0 ? k * 1024 : undefined
                if (agent.kind === 'model' && agent.modelConfig) patch({ modelConfig: { ...agent.modelConfig, contextWindow: v } })
                else if (agent.kind === 'cli' && agent.cliConfig) patch({ cliConfig: { ...agent.cliConfig, contextWindow: v } })
                useUi.getState().toast(v ? `上下文窗口已设为 ${Math.round(v / 1024)}K` : '已恢复按模型自动推断', 'ok')
              }}>保存</Button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
              留空按内置对照表自动推断（如 deepseek 64K、claude 200K）。仅影响用量条显示，不改变接口实际能力。
            </div>
          </div>
        )}

        {/* 常驻提示词：该执行者每次被调用都自动带上的长期要求 */}
        {!agent.isDemo && (
          <div className="form-row">
            <label>常驻提示词（每次调用自动注入）</label>
            <textarea
              defaultValue={agent.systemPrompt ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v === (agent.systemPrompt ?? '').trim()) return
                updateAgent(agent.id, { systemPrompt: v || undefined })
                useUi.getState().toast(v ? '常驻提示词已保存（工作站对话与工作流角色都会注入）' : '已清空常驻提示词', 'ok')
              }}
              placeholder="例如：始终用中文回答；改代码前先跑测试；不要输出解释性前言。"
              rows={4}
              style={{ width: '100%', fontSize: 12.5, lineHeight: 1.6, fontFamily: 'inherit' }}
            />
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
              失焦即保存。工作流里它排在角色协议之后，不会覆盖输出格式与能力边界；与 Skill 的区别是"我对这个执行者的长期要求"，不是可复用的方法包。
            </div>
          </div>
        )}

        {/* 用量与费用说明 */}
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          每条回复下方显示该轮 token 用量（入/出）与估算费用；输入框上方显示上下文用量条。
          费用按官方单价折算（如 DeepSeek：输入 ¥1~4/百万、输出 ¥8~16/百万），无公开单价的模型只显示 token。
          {agent.kind === 'model' && agent.modelConfig && /deepseek/i.test(agent.modelConfig.baseUrl) && '余额来自 DeepSeek 官方 /user/balance 接口（顶栏显示）。'}
        </div>
      </div>
    </Modal>
  )
}

/** Skill 选择面板：引用后随下一条消息注入对话（可多选） */
function SkillPicker({ anchorRef, picked, onToggle, onManage, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  picked: Skill[]
  onToggle: (sk: Skill) => void
  onManage: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  useEffect(() => {
    // 只列已启用的：设置页里关掉开关的 Skill 不出现在引用列表，也不会被注入
    void bridge.skills.list().then((l) => setSkills(l.filter((s) => s.enabled !== false))).catch(() => setSkills([]))
  }, [])

  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    setPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - 320)), bottom: window.innerHeight - r.top + 8 })
  }, [anchorRef])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [anchorRef, onClose])

  if (!pos) return null
  return (
    <div ref={ref} className="ses-panel skill-picker" style={pos} role="menu" aria-label="Skill 列表">
      <div className="ses-head">
        <span>引用 Skill（{picked.length}）</span>
        <button className="ses-new" onClick={onManage}>管理…</button>
      </div>
      <div className="ses-list">
        {skills === null && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-3)' }}>加载中…</div>}
        {skills?.length === 0 && (
          <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
            还没有 Skill。Skill 是可复用的提示包（Markdown），引用后随消息注入对话。<br />点右上角"管理…"创建。
          </div>
        )}
        {skills?.map((sk) => {
          const on = picked.some((x) => x.id === sk.id)
          return (
            <div key={sk.id} className={`ses-item ${on ? 'active' : ''}`} onClick={() => onToggle(sk)}>
              <div className="ses-meta">
                <div className="ses-title">{sk.name}</div>
                <div className="ses-sub">{sk.desc || `${sk.content.length} 字`}</div>
              </div>
              <span style={{ fontSize: 11.5, color: on ? 'var(--brand-yellow)' : 'var(--text-3)' }}>{on ? '已引用' : '引用'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

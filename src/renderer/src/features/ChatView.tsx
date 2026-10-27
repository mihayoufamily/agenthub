// 工作台聊天视图：消息流、跟随滚动、代码块复制、流式光标、交接入口、模型管理、用量显示
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, AgentConfig, AgentSession, ToolCall, Attachment, Skill, ThinkingLevel, McpServer, LedgerUsageRow, FileChange } from '@shared/types'
import { useSessions, sessionsKeyOf } from '../stores/sessions'
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
import { FadeTail } from '../components/FadeTail'
import { UsagePanel, rollup } from '../components/UsagePanel'
import { DonutRings } from '../components/DonutRings'
import { CheckpointBar } from '../components/CheckpointBar'
import { FilePreviewPanel } from '../components/FilePreviewPanel'
import { usePreview } from '../stores/preview'
import { aggregateSessionChanges } from '@shared/timeline'
import { digestThinking } from '../lib/thinking'
import { useSmoothText } from '../lib/smoothText'
import { fmtTime, fmtSize, fmtTokens, cls } from '../lib/utils'
import { contextWindowOf, estimateTokens, estimateCost, fmtCost, visionOf } from '@shared/pricing'
// 模型回复图片：分段解析与地址判定在 shared（渲染层与主进程 image:fetch 通道同一份口径）
import { parseMessageSegments, isRemoteImageSrc } from '@shared/message-images'
// 工具卡里回显 Hook 命令走与设置页**同一个**显示口径（修复波 A · 项 6）：
// 命令里可能带 token，而这张卡同样会被截图/分享——spec A5 关心的正是这一点。
import { redactCommandForDisplay } from '@shared/approvals'

/** 稳定空数组：避免 selector 每次返回新引用导致多余渲染 */
const EMPTY_MSGS: ChatMessage[] = []

/** 长会话渐进披露窗口：默认只挂载最后 150 条消息。
 *  这是渐进披露、不是虚拟滚动——不引第三方虚拟滚动库（本仓渲染层零依赖）：
 *  超长会话往上点"显示更早"仍会挂载更多节点，但默认路径（贴底看最新）恒定 150 条，
 *  流式 delta 期间列表挂载成本不再随总条数线性涨；真虚拟滚动等真实需求出现再上。 */
const RENDER_WINDOW = 150

export function ChatView({ onHandoff }: { onHandoff: () => void }) {
  const agents = useAgents((s) => s.agents)
  const selectedId = useAgents((s) => s.selectedId)
  const colorOf = useAgents((s) => s.colorOf)
  // 直接订阅数据（而非 draftOf/messagesOf 函数引用）：否则 sessions 变化不触发重渲染，
  // 受控输入会被 React 重置回旧渲染值、发送按钮状态不更新（曾导致输入消失/演示 Agent 无输出）
  // 多会话：订阅会话数组与活跃 id，在组件内派生活跃会话（messages/draft 引用稳定）
  const sessionList = useSessions((s) => (selectedId ? s.sessions[sessionsKeyOf(selectedId)] : undefined))
  const activeSesId = useSessions((s) => (selectedId ? s.activeOf[sessionsKeyOf(selectedId)] : undefined))
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
  // 渐进披露：当前可见的消息条数（只增不减，累计到 messages.length 后按钮消失）
  const [visibleCount, setVisibleCount] = useState(RENDER_WINDOW)
  const [mgmtOpen, setMgmtOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  // 未创建账号（右上角提示）：账号是手机端登录与云端同步的身份载体——
  // 只有"机主"空档案时引导创建；设置关回来时重查（可能刚在里面建了账号）
  const settingsOpen = useUi((s) => s.settingsOpen)
  const openSettings = useUi((s) => s.openSettings)
  const [noAccount, setNoAccount] = useState(false)
  useEffect(() => {
    if (settingsOpen) return
    void bridge.auth.state().then((s) => setNoAccount(!s.hasAccounts)).catch(() => setNoAccount(false))
  }, [settingsOpen])
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

  // 文件预览面板（右侧，随会话 UI 态；切 Agent 时面板自身重置内容）
  // agent 可能未就绪（列表还没加载）：用 agent?.id 兜底，面板在 agent 确定后才渲染
  const previewOpen = usePreview((st) => st.open && st.agentId === (agent?.id ?? null))
  const togglePreview = () => {
    const p = usePreview.getState()
    if (!agent) return
    if (p.open && p.agentId === agent.id) p.close()
    else p.openPreview(agent.id)
  }
  // 终端视图数据：本会话的命令执行记录（随工具事件实时更新；面板里新→旧展示）
  const cmdRuns = useMemo(() => messages
    .flatMap((m) => (m.toolCalls ?? [])
      .filter((tc) => tc.tool === 'run_command' && tc.status !== 'running')
      .map((tc) => ({
        cmd: String(tc.args.command ?? tc.args.cmd ?? Object.values(tc.args)[0] ?? ''),
        out: tc.result ?? '',
        err: tc.status === 'error'
      })))
    .slice(-50), [messages])

  // 切换 Agent 或会话时恢复到底部
  useEffect(() => {
    scrollToBottom()
    setNearBottom(true)
    setNewCount(0)
    // 渐进披露窗口跟着重置：切到新会话默认也只看最新 150 条，贴底语义不变
    setVisibleCount(RENDER_WINDOW)
    // 整个消息列表被换掉，条数差不是"新增"，计数基线要跟着重置
    prevCount.current = messages.length
  }, [selectedId, activeSesId])

  // 新内容到达：底部附近跟随；否则计数提示
  const lastLen = messages.length
  const lastMsgLen = messages.length ? messages[messages.length - 1].text.length : 0
  // "N 条新内容"只按**消息条数**的增量计：原先 lastMsgLen 一变（最后一条消息的每个流式文本
  // 增量）也会走 +1 分支，不在底部时一次回复能把计数顶到几十
  const prevCount = useRef(messages.length)
  useEffect(() => {
    const added = lastLen - prevCount.current
    prevCount.current = lastLen
    if (nearBottom) {
      scrollToBottom()
      return
    }
    if (added > 0) setNewCount((c) => c + added)
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
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
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
          {((agent.kind === 'model' && agent.tools) || agent.kind === 'cli') && (
            <button
              className={`model-chip ${previewOpen ? 'open' : ''}`}
              onClick={togglePreview}
              title="文件预览：工作区文件树 + 标签页，工具写盘自动刷新"
              data-testid="preview-toggle"
            >
              <Icon name="folder" size={11} /> 预览{previewOpen ? '' : ''}
            </button>
          )}
        </div>
        </div>
        {/* 兼容模式徽章不在这里挂：它单挂在 Shell（工作站/工作流两种模式共用一个挂载点），见 Shell.tsx */}
        <div className="spacer" />
        {noAccount && (
          <button
            className="auth-hint"
            onClick={() => openSettings('account')}
            title="账号用于手机端登录与多设备云端同步——创建后可在侧栏一键切换"
          >
            未创建账号 · 点击设置
          </button>
        )}
        <Button variant="ghost" onClick={() => void exportSession(agent.id)} title="导出当前 Agent 的聊天记录为 Markdown">
          <Icon name="download" size={14} /> 导出会话
        </Button>
        <Button variant="ghost" onClick={onHandoff} title="把当前对话上下文交接给另一个 Agent">
          <Icon name="handoff" size={14} /> 交给其他 Agent
        </Button>
      </div>

      {/* 顶栏横跨全宽；聊天列与预览面板在同一行、同一顶边（对齐的根治） */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="wb-main">

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
          {/* 渐进披露：只挂载最后 visibleCount 条（消息列表 map 只作用于这个切片）。
              切片取尾部保证贴底语义不变——新消息仍追加在视口内，滚动跟随逻辑照旧 */}
          {messages.length > visibleCount && (
            <button
              className="jump-bottom"
              style={{ position: 'static', transform: 'none', left: 'auto', bottom: 'auto', display: 'block', width: 'fit-content', margin: '0 auto 12px' }}
              onClick={() => setVisibleCount((c) => Math.min(c + RENDER_WINDOW, messages.length))}
              title="渐进披露：每次多挂载 150 条更早的消息（往上翻会挂载更多节点，非虚拟滚动）"
            >
              <Icon name="up" size={13} />
              显示更早的 {Math.min(RENDER_WINDOW, messages.length - visibleCount)} 条（共 {messages.length} 条）
            </button>
          )}
          {messages.slice(-visibleCount).map((m) => (
            <MessageRow key={m.id} msg={m} agentName={agent.name} agentColor={colorOf(agent.id)} allowRemoteImages={!!agent.tools?.allowWeb} agentId={agent.id} />
          ))}
        </div>
      </div>

      {!nearBottom && (
        <button className="jump-bottom" onClick={() => { scrollToBottom(true); setNewCount(0) }}>
          <Icon name="down" size={13} />
          {newCount > 0 ? `${newCount} 条新内容 · 回到底部` : '回到底部'}
        </button>
      )}

      {/* 会话级改动聚合：把全会话各消息的检查点登记合并成一条（数据在各 msg.checkpoint 的 change 里，
          这里只聚合渲染；CLI 改动由检查点的目录对照兜底，见 CheckpointBar 口径） */}
      <SessionChangesBar messages={messages} />

      <div className="wb-composer-wrap">
        <DelegateBar agent={agent} />
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
          fileRefAgentId={agent.id}
        />
      </div>
    </div>
    {previewOpen && <FilePreviewPanel agent={agent} cmds={cmdRuns} onClose={() => usePreview.getState().close()} />}
    </div>
    </div>
  )
}

/** 工作站子代理委派栏（仅工作站模式；工作流引擎不接入——用户拍板）：独立上下文执行，结果回注当前对话 */
function DelegateBar({ agent }: { agent: AgentConfig }) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  // 注意：选择器必须返回稳定引用（zustand v5 返回新数组会无限重渲染），先选全量再 useMemo 过滤
  const agents = useAgents((s) => s.agents)
  const others = useMemo(() => agents.filter((a) => a.id !== agent.id && a.kind === 'model' && a.modelConfig), [agents, agent.id])
  if (agent.isDemo) return null
  const doDelegate = async () => {
    if (!target || !task.trim()) return
    setBusy(true)
    try {
      await useSessions.getState().delegate(agent.id, target, task)
      setTask('')
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ marginBottom: 6 }}>
      <button className="model-chip" onClick={() => setOpen((v) => !v)} data-testid="delegate-toggle" style={{ height: 24, fontSize: 11.5 }}>
        <Icon name="swap" size={11} /> 委派子代理
      </button>
      {open && (
        <div className="delegate-pop" data-testid="delegate-pop">
          <select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="delegate-agent">
            <option value="">选择子代理（其他已配置的模型 Agent）…</option>
            {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder="子任务描述：在子代理的独立上下文里执行，完成后结果回注当前对话"
            data-testid="delegate-task"
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="fp-act" onClick={() => setOpen(false)}>取消</button>
            <button className="fp-act primary" disabled={busy || !target || !task.trim()} onClick={() => void doDelegate()} data-testid="delegate-go">
              {busy ? '子代理执行中…' : '委派'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 会话级文件改动聚合条：合并当前会话所有消息的检查点登记，常驻可折叠（数据已齐，纯渲染层聚合） */
function SessionChangesBar({ messages }: { messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false)
  const changes = useMemo(() => {
    const items: { rel: string; path: string; kind: FileChange['kind'] }[] = []
    for (const m of messages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.change) items.push({ rel: tc.change.rel, path: tc.change.path, kind: tc.change.kind })
      }
    }
    return items
  }, [messages])
  if (!changes.length) return null
  const { counts, items } = aggregateSessionChanges(changes)
  const total = changes.length
  return (
    <div
      style={{ margin: '0 24px 8px', padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 12, lineHeight: 1.5, background: 'var(--surface-2)' }}
      data-testid="session-changes-bar"
    >
      <button onClick={() => setOpen((o) => !o)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center', width: '100%' }}>
        <Icon name="folder" size={12} />
        <b>本会话共改动 {total} 次</b>
        <span style={{ color: 'var(--text-3)', flex: 1 }}>
          新建 {counts.created} · 修改 {counts.modified} · 删除 {counts.deleted} · 移动 {counts.moved}（逐条 diff 在各回复的改动条里）
        </span>
        <span style={{ color: 'var(--text-3)' }}>{open ? '收起 ▴' : '展开 ▾'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 4, maxHeight: 180, overflow: 'auto' }} data-testid="session-changes-list">
          {items.map((it, i) => (
            <div key={`${it.kind}-${it.rel}-${i}`} style={{ display: 'flex', gap: 6, fontSize: 11.5, color: 'var(--text-2)', padding: '1px 0' }}>
              <span style={{ color: it.kind === 'deleted' ? 'var(--danger)' : it.kind === 'created' ? 'var(--ok)' : 'var(--text-3)', minWidth: 34 }}>{TOOL_KIND_TEXT[it.kind] ?? it.kind}</span>
              <span style={{ wordBreak: 'break-all' }}>{it.rel}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
const TOOL_KIND_TEXT: Record<string, string> = { created: '新建', modified: '修改', deleted: '删除', moved: '移动' }

/** 对话栏底部条：模型选择 + 上下文用量 + 本会话消耗费用（用户要求这些信息离输入框最近） */
/**
 * 对话栏底部的迷你占比环（按接入方分色）。
 * 没有可见调用时退回原来的柱状图标——空环会被读成"比例为 0"，那是另一种误导。
 * `data-mini-rows` 是给真机断言用的：否则"有数据但环没画"和"本来就没数据"两种情况
 * 在 DOM 上长得一模一样，断言就成了永真式（评审实测：整个 Task 5 回退后套件仍 91/0）。
 */
function DonutMini({ rows }: { rows: LedgerUsageRow[] }) {
  if (!rows.length) return <Icon name="chart" size={15} />
  return (
    <span data-mini-ring="1" data-mini-rows={rows.length} style={{ display: 'inline-flex', verticalAlign: 'middle', lineHeight: 0 }}>
      <DonutRings rows={rows} mode="mini" size={15} />
    </span>
  )
}

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
  // 底部那个迷你环的数据源：与用量页同一份 rollup（按本 Agent 过滤账本），不另算一套口径
  const [ledgerRows, setLedgerRows] = useState<LedgerUsageRow[]>([])
  useEffect(() => {
    let alive = true
    void bridge.ledger
      .list(100000)
      .then((all) => {
        if (!alive) return
        // 过滤谓词必须与 UsagePanel 完全一致（同一个按钮点开的就是那个面板）：一边收留无 agentId
        // 的账本行、一边不收，环的 tooltip 与弹窗合计就会对不上数。
        setLedgerRows(rollup((all ?? []).filter((e) => e.agentId === agentId)))
      })
      .catch(() => {
        /* 账本读不到就退回柱状图标：底部条不该因为统计挂了而报错 */
      })
    return () => {
      alive = false
    }
  }, [agentId, messages.length])
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
      {/* 用量快捷入口：位置与点击行为不变，图标换成本 Agent 的 token 占比单环（决策记录 A13 接受相对用量页缩水） */}
      <button className="icon-btn usage-open" title="用量统计（本 Agent 的调用与费用）" aria-label="用量统计" onClick={() => setUsageOpen(true)}>
        <DonutMini rows={ledgerRows} />
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

/** memo：流式期间 store 每个 delta 都会重渲染 ChatView，整张消息列表跟着重跑。
 *  props 全是稳定值（msg 引用 store 只在该条变化时替换，agentName/agentColor 是字符串，
 *  allowRemoteImages 是布尔，无内联回调），内容没变的行可整行跳过重绘。 */
const MessageRow = React.memo(function MessageRow({ msg, agentName, agentColor, allowRemoteImages, agentId }: { msg: ChatMessage; agentName: string; agentColor: string; allowRemoteImages: boolean; agentId: string }) {
  // 流式柔和输出：只对"正在流式的助手消息"开启打字机层（完整原文已在 store 里，这里只管显示节奏）；
  // "减少动态效果"用户直接看原文——动效偏好优先于手感。
  // revealEdge 在排空期（流已结束、积压还在播）也保持开启——CodeBuddy 一整块到达的场景，
  // 动画窗口全在排空期，这是用户能"看见"堆叠的唯一窗口
  const reducedMotion = useSettings((s) => s.prefs?.reducedMotion === true)
  const smoothOn = msg.role === 'assistant' && msg.streaming === true && !reducedMotion
  const shownText = useSmoothText(msg.text, smoothOn)
  const revealEdge = smoothOn || (msg.role === 'assistant' && !reducedMotion && shownText.length < msg.text.length)
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
        {msg.role === 'assistant' && msg.segments && msg.segments.length > 0 ? (
          /* zcode 式时间线：思考/工具/正文按真实到达顺序穿插渲染 */
          msg.segments.map((seg, si) => {
            if (seg.kind === 'reasoning') {
              return <ReasoningBlock key={`r${si}`} text={seg.text} streaming={msg.streaming && si === msg.segments!.length - 1} />
            }
            if (seg.kind === 'tool') {
              const tc = msg.toolCalls?.find((c) => c.id === seg.tcId)
              if (!tc) return null
              return <ToolCallCard key={tc.id} tc={tc} agentId={agentId} />
            }
            const isLastText = !msg.segments!.slice(si + 1).some((s) => s.kind === 'text')
            const segShown = isLastText ? shownText.slice(shownText.lastIndexOf(seg.text) >= 0 ? shownText.lastIndexOf(seg.text) : 0) : seg.text
            return (
              <div key={`t${si}`} className={cls('bubble word-break')}>
                {msg.streaming && isLastText && !shownText ? (
                  <span className="thinking-wait"><span className="spin-dot" />思考中…</span>
                ) : (
                  <>
                    <MessageBody text={isLastText ? segShown : seg.text} revealEdge={isLastText && revealEdge} allowRemoteImages={allowRemoteImages} />
                    {msg.streaming && isLastText && <span className="caret" />}
                  </>
                )}
                {msg.error && isLastText && <div className="err">⚠ {msg.error}</div>}
                {msg.demo && !msg.streaming && isLastText && (
                  <div style={{ marginTop: 6 }}>
                    <span className="demo-badge">演示数据 · 非真实模型输出</span>
                  </div>
                )}
              </div>
            )
          })
        ) : (
          /* 旧消息（无 segments）：回退三段式 */
          <>
            {msg.toolCalls && msg.toolCalls.length > 0 && msg.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} tc={tc} agentId={agentId} />
            ))}
            {msg.reasoning && msg.reasoning.trim() && <ReasoningBlock text={msg.reasoning} streaming={msg.streaming && !msg.text} />}
            {(msg.text || !msg.toolCalls?.length) && (
              <div className={cls('bubble word-break')}>
                {/* 首字未到（思考/网络等待）时显示"思考中"转圈而不是空气泡；正文到达后走柔和逐字揭示 */}
                {msg.streaming && !shownText ? (
                  <span className="thinking-wait"><span className="spin-dot" />思考中…</span>
                ) : (
                  <>
                    <MessageBody text={shownText} revealEdge={revealEdge} allowRemoteImages={allowRemoteImages} />
                    {msg.streaming && <span className="caret" />}
                  </>
                )}
                {msg.error && <div className="err">⚠ {msg.error}</div>}
                {msg.demo && !msg.streaming && (
                  <div style={{ marginTop: 6 }}>
                    <span className="demo-badge">演示数据 · 非真实模型输出</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {msg.checkpoint && !msg.streaming && <CheckpointBar id={msg.checkpoint} title="这次回复改动的文件" />}
        <div className="msg-time">
          {fmtTime(msg.ts)}
          {msg.model && ` · ${msg.model}`}
          {msg.usage?.tokens ? ` · ${fmtTokens(msg.usage.tokens)} tk${msg.usage.prompt != null ? `（入 ${fmtTokens(msg.usage.prompt)}/出 ${fmtTokens(msg.usage.completion ?? 0)}）` : ''}${msg.cost != null ? ` · ${fmtCost(msg.cost)}` : ''}` : ''}
          {msg.attachments && msg.attachments.length > 0 && ` · 附件 ${msg.attachments.length} 个${msg.attachments[0].size ? `（${fmtSize(msg.attachments[0].size)}）` : ''}`}
          {msg.role === 'assistant' && (msg.segments?.some((s) => s.kind === 'text') ? msg.text : (msg.text || msg.segments)) ? (
            <CopyButton getText={() => {
              const parts: string[] = []
              if (msg.segments?.length) {
                for (const seg of msg.segments) {
                  if (seg.kind === 'reasoning') parts.push(`【思考】\n${seg.text}`)
                  else if (seg.kind === 'tool') {
                    const tc = msg.toolCalls?.find((c) => c.id === seg.tcId)
                    if (tc) parts.push(`【工具 ${tc.tool}】${tc.status === 'error' ? '（失败）' : ''}\n${tc.result ?? ''}`)
                  } else parts.push(seg.text)
                }
              } else {
                if (msg.reasoning) parts.push(`【思考】\n${msg.reasoning}`)
                for (const tc of msg.toolCalls ?? []) parts.push(`【工具 ${tc.tool}】${tc.status === 'error' ? '（失败）' : ''}\n${tc.result ?? ''}`)
                parts.push(msg.text)
              }
              return parts.join('\n\n')
            }} label="复制" />
          ) : null}
        </div>
      </div>
    </div>
  )
})

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

/** ---------- 模型回复图片（ModelImage） ----------
 *  data: 来源直接 <img>（已是内嵌数据，无网络行为）；remote 走主进程 image:fetch 代理
 *  （SSRF 守卫与上限在通道侧，见 ipc.ts 的注释）。渲染层再做一层结果缓存（url → 结果）：
 *  同一张图渲染多次不重复走通道；失败结果也缓存住，避免每帧重试把通道打成重试风暴。
 *  allowRemoteImages=false（该 Agent 未开联网）时远程图渲染为占位块，原链接可复制——
 *  把关在渲染层是如实取舍：通道侧没有可信 agentId（渲染层传什么就是什么），
 *  与其在主进程做一道"假授权校验"，不如把边界写明。 */
type RemoteImageState = { state: 'loading' } | { state: 'ok'; dataUrl: string } | { state: 'fail'; message: string }
const remoteImageCache = new Map<string, RemoteImageState>()
const remoteImagePending = new Map<string, Promise<RemoteImageState>>()

function loadRemoteImage(src: string): Promise<RemoteImageState> {
  const pending = remoteImagePending.get(src)
  if (pending) return pending
  const p = bridge.images
    .fetch(src)
    .then((r): RemoteImageState => {
      const st: RemoteImageState = r.ok && r.dataUrl ? { state: 'ok', dataUrl: r.dataUrl } : { state: 'fail', message: r.message ?? '下载失败' }
      remoteImageCache.set(src, st)
      return st
    })
    .catch((e): RemoteImageState => {
      const st: RemoteImageState = { state: 'fail', message: (e as Error)?.message ?? '下载失败' }
      remoteImageCache.set(src, st)
      return st
    })
  remoteImagePending.set(src, p.finally(() => { remoteImagePending.delete(src) }))
  return remoteImagePending.get(src)!
}

/** 图片占位块：alt + 一行原因 + 原链接可复制（不给"图片坏了"这种没有出路的死块） */
function ImagePlaceholder({ alt, note, src }: { alt?: string; note: string; src: string }) {
  return (
    <div style={{ margin: '6px 0', padding: '8px 10px', borderRadius: 'var(--r-sm)', border: '1px dashed var(--border)', fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ color: 'var(--text-2)' }}>{alt || '（模型给出的图片）'}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', color: 'var(--text-3)' }}>
        <span>{note}</span>
        <button className="link-btn" onClick={() => void navigator.clipboard.writeText(src)}>复制链接</button>
      </div>
    </div>
  )
}

const MODEL_IMG_STYLE: React.CSSProperties = { maxWidth: '100%', borderRadius: 8, margin: '6px 0', display: 'block' }

export function ModelImage({ src, alt, allowRemoteImages }: { src: string; alt?: string; allowRemoteImages?: boolean }) {
  const remote = isRemoteImageSrc(src)
  const [state, setState] = useState<RemoteImageState>(() => remoteImageCache.get(src) ?? { state: 'loading' })
  useEffect(() => {
    if (!remote || !allowRemoteImages) return
    const cur = remoteImageCache.get(src)
    if (cur) { setState(cur); return }
    setState({ state: 'loading' })
    let alive = true
    void loadRemoteImage(src).then((st) => { if (alive) setState(st) })
    return () => { alive = false }
  }, [src, remote, allowRemoteImages])
  if (!remote) {
    // data: 图：内嵌数据直接渲染（isValidImageSrc 已在解析层保证非 remote 即 data:image/）
    return <img src={src} alt={alt ?? ''} style={MODEL_IMG_STYLE} loading="lazy" />
  }
  if (!allowRemoteImages) {
    return <ImagePlaceholder alt={alt} note="远程图片未加载（该 Agent 未开启联网）" src={src} />
  }
  if (state.state === 'loading') {
    return <div style={{ margin: '6px 0', fontSize: 12, color: 'var(--text-3)' }}>图片加载中…</div>
  }
  if (state.state === 'fail') {
    return <ImagePlaceholder alt={alt} note={state.message} src={src} />
  }
  return (
    <img
      src={state.dataUrl}
      alt={alt ?? ''}
      style={{ ...MODEL_IMG_STYLE, cursor: 'pointer' }}
      loading="lazy"
      title="点击在浏览器中打开原图"
      onClick={() => void bridge.app.openExternal(src)}
    />
  )
}

/** 文本 + ```代码块``` + ![图片]() 渲染（代码块带复制按钮，不横向撑破）；
 *  分段交给 shared 的 parseMessageSegments（与旧 split(/```/g) 结构同构：奇数段代码、
 *  偶数段文本，文本里再解析图片；围栏内的图片语法不解析）。
 *  revealEdge：流式揭示边缘的逐字淡入，落在**最后一个 text 段**上——与解析器对齐后，
 *  回复可能以图片收尾（最后一段是 image），那时边缘退到它前面最后一个文本段即可；
 *  图片本身不参与打字机节奏（一次性渲染，data URL 逐字揭示只会看到半个 base64 串）。 */
export function MessageBody({ text, revealEdge, allowRemoteImages }: { text: string; revealEdge?: boolean; allowRemoteImages?: boolean }) {
  const segs = parseMessageSegments(text)
  const lastTextSeg = revealEdge ? segs.reduce((acc, s, i) => (s.kind === 'text' ? i : acc), -1) : -1
  return (
    <>
      {segs.map((seg, i) => {
        if (seg.kind === 'text') {
          return i === lastTextSeg
            ? <FadeTail key={i} text={seg.content} enabled={revealEdge} />
            : <React.Fragment key={i}>{seg.content}</React.Fragment>
        }
        if (seg.kind === 'image') {
          return <ModelImage key={i} src={seg.src ?? ''} alt={seg.alt} allowRemoteImages={allowRemoteImages} />
        }
        // content 已在解析层剥过语言行：复制与显示用同一份文本（无语言块则是多一个空行的旧账已清）
        return (
          <div key={i} className="codeblock" style={{ margin: '8px 0' }}>
            <button
              className="copy"
              onClick={() => void navigator.clipboard.writeText(seg.content)}
            >
              复制
            </button>
            {seg.content}
          </div>
        )
      })}
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
        {streaming && <span className="spin-dot" />}
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
function ToolCallCard({ tc, agentId }: { tc: ToolCall; agentId: string }) {
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
          {tc.status === 'running' ? '执行中…' : tc.status === 'error' ? '失败' : '完成'}{tc.durMs != null ? ` · ${tc.durMs < 1000 ? `${tc.durMs}ms` : `${(tc.durMs / 1000).toFixed(1)}s`}` : ''}
        </span>
      </button>
      {/* AI 写盘产物：一键唤起右侧预览面板定位该文件（绝对路径走 artifact:readPreview 守卫通道） */}
      {tc.writtenPath && tc.status === 'done' && (
        <button
          className="tool-preview-btn"
          onClick={() => usePreview.getState().openPreview(agentId, { abs: tc.writtenPath })}
          title="在右侧预览面板中打开该文件"
          data-testid="tool-preview"
        >
          <Icon name="folder" size={11} /> 预览文件
        </button>
      )}
      {open && tc.hooks?.length && (
        <div className="tool-diff" data-tool-hooks>
          {tc.hooks.map((h, i) => (
            <div key={`${h.id}-${i}`}>
              <b style={{ color: h.blocked ? 'var(--danger)' : 'var(--text-3)' }}>
                Hook {h.id} · 退出码 {h.exit ?? 'null'}{h.timedOut ? ' · 超时' : ''}{h.blocked ? ' · 已否决本次调用' : ''}
              </b>
              {/* 脱敏后回显（与设置页 Hook 分区同一口径）：命令原文可能带 token，这张卡会被截图/分享 */}
              <div>{redactCommandForDisplay(h.command)}</div>
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
  // 工具清单（折叠区）：懒加载——展开或命令/联网/进阶开关变化时，向主进程要一份与发给模型同一份的清单
  const [listOpen, setListOpen] = useState(false)
  const [toolList, setToolList] = useState<{ name: string; desc: string }[] | null>(null)
  // 进阶工具白名单（zip/剪贴板/资源管理器定位）：默认全关，逐个勾选
  const [adv, setAdv] = useState<string[]>(agent.tools?.advanced ?? [])
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
  useEffect(() => {
    if (!listOpen) return
    let alive = true
    void bridge.tools.defs({ allowCommands, allowWeb, advanced: adv }).then((r) => {
      if (alive) setToolList(r)
    })
    return () => {
      alive = false
    }
  }, [listOpen, allowCommands, allowWeb, adv])

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
      ...(mcpIds.length ? { mcpServerIds: mcpIds } : {}),
      ...(adv.length ? { advanced: adv } : {})
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
            {/* 老 Agent 补推荐配置：新 Agent 默认带联网，这个还没开——一键补上（只补联网，不动其他项） */}
            {!allowWeb && (
              <div
                style={{ display: 'flex', gap: 8, alignItems: 'center', border: '1px dashed var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 10px', fontSize: 12.5 }}
                data-testid="recommend-tools-row"
              >
                <span style={{ flex: 1, color: 'var(--text-3)', lineHeight: 1.5 }}>
                  推荐配置：新 Agent 默认开启联网（web_fetch / web_search），这个 Agent 还没开——查资料是基础能力。
                </span>
                <Button variant="secondary" style={{ height: 26 }} onClick={() => setAllowWeb(true)}>应用推荐配置</Button>
              </div>
            )}
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
            {/* 进阶工具（默认全关）：逐个勾选启用；清单实时反映在下方折叠区 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px' }} data-testid="advanced-tools-block">
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>进阶工具（默认关，逐个开启）</div>
              {([
                ['zip_pack', '打包 zip', '把沙箱内文件/目录打成一个 zip（写类：计划态会被拦）'],
                ['zip_unpack', '解压 zip', '把沙箱内 zip 解到目录（zip-slip 防护；覆盖的同名文件进检查点，写类）'],
                ['clipboard_read', '读剪贴板', '模型能读到你刚复制的文本——隐私面，仅在确有需要时开'],
                ['clipboard_write', '写剪贴板', '模型可把文本写进系统剪贴板（交付代码/命令时方便你直接粘贴）'],
                ['show_in_folder', '资源管理器定位', '在资源管理器中打开并选中沙箱内某文件']
              ] as const).map(([id, label, note]) => (
                <label key={id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={adv.includes(id)}
                    onChange={(e) => setAdv(e.target.checked ? [...adv, id] : adv.filter((x) => x !== id))}
                    data-testid={`advanced-tool-${id}`}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ lineHeight: 1.6 }}>
                    <b>{label}</b> <code style={{ fontSize: 11 }}>{id}</code>
                    <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{note}</div>
                  </span>
                </label>
              ))}
            </div>
            {/* 工具清单折叠区：内容来自 tools:defs（主进程同一份 toolDefs），展开才拉取 */}
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 12px' }} data-testid="tool-list-block">
              <button
                type="button"
                className="btn btn-ghost"
                style={{ height: 26, fontSize: 12, width: '100%', justifyContent: 'flex-start', border: 'none' }}
                aria-expanded={listOpen}
                data-testid="tool-list-toggle"
                onClick={() => setListOpen(!listOpen)}
              >
                {listOpen ? '▾' : '▸'} 工具清单{toolList ? `（${toolList.length} 个）` : ''}——这个 Agent 将获得哪些工具
              </button>
              {listOpen && (
                <div style={{ marginTop: 6 }}>
                  {!toolList && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>加载中…</div>}
                  {toolList?.map((t) => (
                    <div key={t.name} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12, lineHeight: 1.5 }}>
                      <code style={{ minWidth: 110, wordBreak: 'break-all' }}>{t.name}</code>
                      <span style={{ color: 'var(--text-3)', flex: 1 }}>{t.desc}</span>
                    </div>
                  ))}
                  {mcpIds.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
                      另有已勾选 MCP 的工具在对话时并入（{mcpIds.map((id) => mcpList.find((s) => s.id === id)?.name ?? id).join('、')}）。
                    </div>
                  )}
                </div>
              )}
            </div>
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

        {/* 常驻提示词：侧栏 ⋯ 的 Agent 管理卡片是唯一编辑入口，这里只读——
            同一字段两处可写必然漂移（spec 批次 D）。 */}
        {!agent.isDemo && (
          <div className="form-row">
            <label>常驻提示词（每次调用自动注入）</label>
            <div className="ro-block word-break" data-prompt-readonly="1">
              {agent.systemPrompt?.trim() || '（未设置）'}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
              这里只读。在侧栏点该 Agent 的 ⋯ 可编辑常驻提示词与 Skill 绑定——同一个字段两处可写必然漂移。
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

// 工作台聊天视图：消息流、跟随滚动、代码块复制、流式光标、交接入口、模型切换
import React, { useEffect, useRef, useState } from 'react'
import type { ChatMessage, AgentConfig, ToolCall } from '@shared/types'
import { useSessions } from '../stores/sessions'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { bridge } from '../lib/ipc'
import { Avatar, StatusDot, statusText, CopyButton, Button } from '../components/primitives'
import { Composer } from '../components/Composer'
import { Modal } from '../components/Modal'
import { Icon } from '../components/Icons'
import { fmtTime, fmtSize, cls } from '../lib/utils'

/** 稳定空数组：避免 selector 每次返回新引用导致多余渲染 */
const EMPTY_MSGS: ChatMessage[] = []

export function ChatView({ onHandoff }: { onHandoff: () => void }) {
  const agents = useAgents((s) => s.agents)
  const selectedId = useAgents((s) => s.selectedId)
  const colorOf = useAgents((s) => s.colorOf)
  // 直接订阅数据（而非 draftOf/messagesOf 函数引用）：否则 sessions 变化不触发重渲染，
  // 受控输入会被 React 重置回旧渲染值、发送按钮状态不更新（曾导致输入消失/演示 Agent 无输出）
  const messages = useSessions((s) => (selectedId ? s.sessions[selectedId]?.messages ?? EMPTY_MSGS : EMPTY_MSGS))
  const draft = useSessions((s) => (selectedId ? s.sessions[selectedId]?.draft ?? '' : ''))
  const setDraft = useSessions((s) => s.setDraft)
  const sendMessage = useSessions((s) => s.sendMessage)
  const exportSession = useSessions((s) => s.exportSession)
  const ensure = useSessions((s) => s.ensure)
  const homeDraft = useUi((s) => s.homeDraft)
  const setHomeDraft = useUi((s) => s.setHomeDraft)
  const enterToSend = useSettings((s) => s.prefs?.enterToSend ?? true)

  const agent = agents.find((a) => a.id === selectedId)

  useEffect(() => {
    if (selectedId) void ensure(selectedId)
  }, [selectedId, ensure])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const [switchOpen, setSwitchOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // 切换 Agent 时恢复到底部（滚动位置随会话保留由消息内容决定，简化处理）
  useEffect(() => {
    scrollToBottom()
    setNearBottom(true)
    setNewCount(0)
  }, [selectedId])

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
    void sendMessage(agent.id, draft.trim(), [])
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
          <div className="sub" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <StatusDot status={agent.status} /> {statusText(agent.status)} ·{' '}
          {canSwitchModel ? (
            <button
              className="model-chip"
              onClick={() => setSwitchOpen(true)}
              title={agent.kind === 'model' ? '切换此 Agent 使用的模型（列表来自真实接口）' : '修改传给 CLI 的模型参数（留空用 CLI 默认）'}
            >
              {agent.model} <Icon name="swap" size={11} />
            </button>
          ) : (
            agent.model
          )}
          {agent.kind === 'model' && agent.modelConfig && (
            <button
              className="model-chip"
              onClick={() => setToolsOpen(true)}
              title="文件/命令工具授权（沙箱目录、命令执行开关）"
            >
              <Icon name="file" size={11} /> 工具{agent.tools ? '·已启用' : ''}
            </button>
          )}
        </div>
        </div>
        <div className="spacer" />
        <Button variant="ghost" onClick={() => void exportSession(agent.id)} title="导出当前 Agent 的聊天记录为 Markdown">
          <Icon name="download" size={14} /> 导出会话
        </Button>
        <Button variant="ghost" onClick={onHandoff} title="把当前对话上下文交接给另一个 Agent">
          <Icon name="handoff" size={14} /> 交给其他 Agent
        </Button>
      </div>

      {switchOpen && <ModelSwitchModal agent={agent} onClose={() => setSwitchOpen(false)} />}
      {toolsOpen && <ToolsGrantModal agent={agent} onClose={() => setToolsOpen(false)} />}

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
          {messages.length === 0 && (
            <div className="empty-state" style={{ padding: '8vh 20px' }}>
              <div className="title">和 {agent.name} 开始对话</div>
              <div className="desc">
                {agent.isDemo
                  ? '当前为演示模式：回复为脚本化内容，用于体验界面与交互。'
                  : '输入消息开始。发送内容将通过已连接的接口真实送达。'}
              </div>
            </div>
          )}
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
        <Composer
          value={draft}
          onChange={(v) => setDraft(agent.id, v)}
          onSend={doSend}
          enterToSend={enterToSend}
          placeholder={`给 ${agent.name} 发送消息…`}
        />
      </div>
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
        <div className="msg-time">
          {fmtTime(msg.ts)}
          {msg.model && ` · ${msg.model}`}
          {msg.attachments && msg.attachments.length > 0 && ` · 附件 ${msg.attachments.length} 个${msg.attachments[0].size ? `（${fmtSize(msg.attachments[0].size)}）` : ''}`}
        </div>
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

/** 工具调用卡片：真实执行的文件读写/命令记录（状态、参数、结果可展开） */
function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false)
  const TOOL_TEXT: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    list_dir: '列出目录',
    delete_file: '删除（回收站）',
    move: '移动/重命名',
    run_command: '执行命令'
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

  const save = () => {
    const tools = enabled && dir.trim() ? { dir: dir.trim(), allowCommands } : undefined
    updateAgent(agent.id, { tools })
    useUi.getState().toast(
      tools ? `已启用文件工具（沙箱目录：${tools.dir}${tools.allowCommands ? '，允许执行命令' : ''}）` : '已关闭文件工具，恢复纯对话',
      'ok'
    )
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${agent.name} · 文件/命令工具`}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} disabled={enabled && !dir.trim()}>保存</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 6 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ marginTop: 3 }} />
          <span style={{ lineHeight: 1.6 }}>
            <b>启用文件工具</b>
            <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
              开启即授权该模型在沙箱目录内：读/写/列出/删除（回收站）/移动文件。未开启时为纯对话（如实无文件能力）。所有调用过程在对话中如实展示并随记录保存。
            </div>
          </span>
        </label>
        {enabled && (
          <>
            <div className="form-row">
              <label>沙箱目录（产物根）</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="例如 D:\AgentHub\产物\该Agent名"
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
                  开启后模型可在沙箱目录内执行 shell 命令（工作目录固定为沙箱根，超时 60 秒、输出有上限）。用于构建/测试产物；每条命令与输出都会在对话中展示。风险高于文件读写，请谨慎开启。
                </div>
              </span>
            </label>
            <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>
              安全边界：路径规范化后越出沙箱目录的调用一律拒绝；删除走系统回收站可恢复；工具调用轮数有上限（16 轮）。
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
/** 模型切换弹窗：模型 Agent 列表来自真实 /models 接口；CLI Agent 手动指定模型参数 */
function ModelSwitchModal({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const updateAgent = useAgents((s) => s.updateAgent)
  const [models, setModels] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState(agent.cliConfig?.model ?? '')

  useEffect(() => {
    if (agent.kind === 'model' && agent.modelConfig) {
      void bridge.models.list(agent.modelConfig).then((r) => {
        if (r.ok && r.models) setModels(r.models)
        else setErr(r.message ?? '获取模型列表失败')
      })
    }
  }, [agent])

  if (agent.kind === 'cli' && agent.cliConfig) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`修改 ${agent.name} 的模型参数`}
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                const v = manual.trim()
                updateAgent(agent.id, {
                  model: v || '默认（CLI 自身配置）',
                  cliConfig: { ...agent.cliConfig!, model: v || undefined }
                })
                useUi.getState().toast(v ? `已切换模型参数：${v}（后续请求生效）` : '已恢复为 CLI 默认模型', 'ok')
                onClose()
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <div style={{ paddingBottom: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.6 }}>
            该值作为 --model 参数传给 CLI；留空则使用 CLI 自身配置的默认模型。无法在此列出 CLI 支持的模型清单（各 CLI 无统一查询接口），请参考其官方文档填写。
          </div>
          <div className="form-row">
            <label>模型参数（可选）</label>
            <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="留空使用 CLI 默认模型" />
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} title={`切换 ${agent.name} 的模型`} width={460}>
      <div style={{ paddingBottom: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.6 }}>
          列表来自该连接的真实 /models 接口。切换后<b>沿用当前对话上下文</b>，后续请求实际使用新模型；若新模型上下文长度不足，会由接口如实报错。配置按 Agent 分别保存，重启后保留。
        </div>
        {err && <div style={{ color: 'var(--danger)', fontSize: 12.5, lineHeight: 1.5 }}>{err}</div>}
        {!models && !err && (
          <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-3)' }}>正在获取模型列表…</div>
        )}
        {models && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
            {models.map((m) => {
              const cur = m === agent.modelConfig?.modelId
              return (
                <button
                  key={m}
                  disabled={cur}
                  className="btn"
                  style={{
                    justifyContent: 'flex-start', height: 32, fontSize: 12.5,
                    ...(cur
                      ? { border: '1px solid var(--brand-yellow)', color: 'var(--text-2)', background: 'var(--surface-2)', cursor: 'default' }
                      : { border: '1px solid var(--border)', background: 'var(--surface)' })
                  }}
                  onClick={() => {
                    updateAgent(agent.id, {
                      model: m,
                      modelConfig: { ...agent.modelConfig!, modelId: m }
                    })
                    useUi.getState().toast(`已切换模型：${m}（后续请求生效）`, 'ok')
                    onClose()
                  }}
                >
                  {m} {cur && '· 当前'}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}

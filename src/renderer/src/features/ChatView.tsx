// 工作台聊天视图：消息流、跟随滚动、代码块复制、流式光标、交接入口
import React, { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { useSessions } from '../stores/sessions'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { Avatar, StatusDot, statusText, CopyButton, Button } from '../components/primitives'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icons'
import { fmtTime, fmtSize, cls } from '../lib/utils'

export function ChatView({ onHandoff }: { onHandoff: () => void }) {
  const agents = useAgents((s) => s.agents)
  const selectedId = useAgents((s) => s.selectedId)
  const colorOf = useAgents((s) => s.colorOf)
  const messagesOf = useSessions((s) => s.messagesOf)
  const draftOf = useSessions((s) => s.draftOf)
  const setDraft = useSessions((s) => s.setDraft)
  const sendMessage = useSessions((s) => s.sendMessage)
  const ensure = useSessions((s) => s.ensure)
  const homeDraft = useUi((s) => s.homeDraft)
  const setHomeDraft = useUi((s) => s.setHomeDraft)
  const enterToSend = useSettings((s) => s.prefs?.enterToSend ?? true)

  const agent = agents.find((a) => a.id === selectedId)
  const messages = selectedId ? messagesOf(selectedId) : []

  useEffect(() => {
    if (selectedId) void ensure(selectedId)
  }, [selectedId, ensure])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)

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

  const doSend = () => {
    const text = draftOf(agent.id)
    if (!text.trim()) return
    void sendMessage(agent.id, text.trim(), [])
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
            <StatusDot status={agent.status} /> {statusText(agent.status)} · {agent.model}
          </div>
        </div>
        <div className="spacer" />
        <Button variant="ghost" onClick={onHandoff} title="把当前对话上下文交接给另一个 Agent">
          <Icon name="handoff" size={14} /> 交给其他 Agent
        </Button>
      </div>

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
          value={draftOf(agent.id)}
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
        <div className="msg-time">
          {fmtTime(msg.ts)}
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

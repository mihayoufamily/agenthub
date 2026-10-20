// 品牌首页：Logo 上半屏 + "今天要构建什么" + 输入区 + 右上角模式选择
// 规则：先写需求后选模式允许；直接发送未选模式时先弹模式选择；选模式不自动提交需求
import React, { useState } from 'react'
import type { WorkMode } from '@shared/types'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { Logo } from '../components/Logo'
import { Composer } from '../components/Composer'
import { Modal } from '../components/Modal'
import { Button } from '../components/primitives'
import { enterMode } from './ModeSwitch'

export function BrandHome() {
  const draft = useUi((s) => s.homeDraft)
  const setDraft = useUi((s) => s.setHomeDraft)
  const attachments = useUi((s) => s.homeAttachments)
  const setAttachments = useUi((s) => s.setHomeAttachments)
  const pendingMode = useUi((s) => s.pendingMode)
  const setPendingMode = useUi((s) => s.setPendingMode)
  const enterToSend = useSettings((s) => s.prefs?.enterToSend ?? true)
  const [showModePrompt, setShowModePrompt] = useState(false)

  const MODES: { key: WorkMode; title: string; desc: string }[] = [
    { key: 'workbench', title: '工作台模式', desc: '在同一个界面自由切换 Agent，每个 Agent 保留自己的会话与草稿。' },
    { key: 'workflow', title: '工作流模式', desc: '规划、执行、审核三个角色协作完成任务，支持返工与人工确认。' }
  ]

  const doSend = () => {
    if (!draft.trim()) return
    if (!pendingMode) {
      setShowModePrompt(true) // 先弹简洁模式选择，不自动提交
      return
    }
    // 已选模式：携带草稿进入对应模式（由用户在目标页明确发送/启动）
    enterMode(pendingMode)
  }

  const chooseMode = (m: WorkMode) => {
    setPendingMode(m)
    setShowModePrompt(false)
    enterMode(m)
  }

  return (
    <div className="brand-home">
      <div className="mode-pill" role="radiogroup" aria-label="工作模式选择">
        <button
          className={pendingMode === 'workbench' ? 'active' : ''}
          onClick={() => setPendingMode('workbench')}
          aria-checked={pendingMode === 'workbench'}
          role="radio"
        >
          工作台
        </button>
        <button
          className={pendingMode === 'workflow' ? 'active' : ''}
          onClick={() => setPendingMode('workflow')}
          aria-checked={pendingMode === 'workflow'}
          role="radio"
        >
          工作流
        </button>
      </div>

      <div className="home-logo-wrap">
        <div className="home-logo">
          <Logo />
        </div>
        <div className="word">agenthub</div>
      </div>

      <div className="home-ask">今天要构建什么</div>

      <div className="home-composer-wrap">
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={doSend}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          enterToSend={enterToSend}
          autoFocusOnMount
        />
      </div>

      <Modal
        open={showModePrompt}
        onClose={() => setShowModePrompt(false)}
        title="请选择工作模式"
        width={420}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 12px' }}>
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => chooseMode(m.key)}
              style={{
                textAlign: 'left',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--r-md)',
                background: 'var(--surface)',
                padding: '14px 16px',
                cursor: 'pointer'
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>{m.title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>{m.desc}</div>
            </button>
          ))}
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>选择后你的草稿与附件会一起带过去，进入后再确认发送。</div>
        </div>
      </Modal>
    </div>
  )
}

/** 模式选择入口需要用到的 Agent 就绪检查提示（无可用 Agent 时引导） */
export function NoAgentsHint({ onOpenAdd }: { onOpenAdd: () => void }) {
  return (
    <Button variant="primary" onClick={onOpenAdd}>
      添加 Agent
    </Button>
  )
}

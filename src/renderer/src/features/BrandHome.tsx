// 品牌首页：Logo 上半屏 + "今天要构建什么" + 输入区 + 输入卡下方的模式入口（悬浮/聚焦出说明卡片）
// 规则：先写需求后选模式允许；直接发送未选模式时先弹模式选择；选模式不自动提交需求；
//       第一次点入口 = 选中，再点同一个已选中的入口 = 直接进入该模式；
//       说明卡片关闭不切模式、不提交输入，草稿与附件保持不变
import React, { useEffect, useState } from 'react'
import type { WorkMode } from '@shared/types'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { Logo } from '../components/Logo'
import { Composer } from '../components/Composer'
import { Modal } from '../components/Modal'
import { Button } from '../components/primitives'
import { Icon } from '../components/Icons'
import { enterMode } from './ModeSwitch'

/** 模式说明文案（文档三.1 建议文案）
 *  `why` 承担 spec C1 的"为什么要先选"这句话，每张卡只说自己那台的前置条件：
 *  上一轮两张卡都塞了"工作站要 A、工作流要 B"的双份事实，卡片因此在应用最小高度（640）下被裁 21px。
 *  压短 + 合并那行 note 之后语义一条没丢（Ruling T1-e；真机断言守着 960×640 完整可见）。 */
const MODE_INFO: Record<WorkMode, { title: string; pill: string; desc: string; enter: string; why: string }> = {
  workbench: {
    title: '工作站模式',
    pill: '工作站',
    desc: '在一个界面中自由切换不同 Agent。每个 Agent 保留自己的会话和工作状态，适合由你直接安排任务、查看结果和决定下一步。',
    enter: '进入工作站模式',
    // spec C1：介绍文案要负责说清"为什么要先选"
    why: '先选是为了少返工：工作站要先有可用 Agent。'
  },
  workflow: {
    title: '工作流模式',
    pill: '工作流',
    desc: '让规划、执行、审核三个角色协作完成任务。系统按流程交接任务、检查结果并在必要时返工，支持自动审核与人工确认。',
    enter: '进入工作流模式',
    // spec C1：介绍文案要负责说清"为什么要先选"
    why: '先选是为了少返工：工作流要三角色可用。'
  }
}

export function BrandHome() {
  const draft = useUi((s) => s.homeDraft)
  const setDraft = useUi((s) => s.setHomeDraft)
  const attachments = useUi((s) => s.homeAttachments)
  const setAttachments = useUi((s) => s.setHomeAttachments)
  const pendingMode = useUi((s) => s.pendingMode)
  const setPendingMode = useUi((s) => s.setPendingMode)
  const enterToSend = useSettings((s) => s.prefs?.enterToSend ?? true)
  const [showModePrompt, setShowModePrompt] = useState(false)
  /** 说明卡片：点击入口打开；null = 关闭 */
  const [infoKey, setInfoKey] = useState<WorkMode | null>(null)

  // Escape 关闭说明卡片（不切换模式、不影响草稿）
  useEffect(() => {
    if (!infoKey) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInfoKey(null)
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.mode-pill') && !t.closest('.mode-info')) setInfoKey(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [infoKey])

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

      {/* C1：模式选择在输入卡下方（原先钉在视口右上角，离"要做的决定"最远） */}
      <div className="mode-pill-wrap">
        {/* onBlur 是冒泡的 focusout：Tab 从 pill 移进说明卡按钮时焦点仍在本组内，
            不能关卡（否则卡先卸载、焦点落空）。只在新焦点真的离开 pill+卡整体时才收起 */}
        <div className="mode-pill" role="radiogroup" aria-label="工作模式选择" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInfoKey(null) }}>
          {(['workbench', 'workflow'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={pendingMode === m}
              data-mode={m}
              className={pendingMode === m ? 'active' : ''}
              // 悬浮或键盘聚焦都展开介绍：只做 hover 的话，触屏与键盘用户永远拿不到解释
              onMouseEnter={() => setInfoKey(m)}
              onFocus={() => setInfoKey(m)}
              onClick={() => {
                if (pendingMode === m) {
                  // 第二次点同一个已选中的入口 = 用户已经看过了，直接进
                  setInfoKey(null)
                  enterMode(m)
                  return
                }
                setPendingMode(m)
                setInfoKey(m)
              }}
            >
              {MODE_INFO[m].pill}
            </button>
          ))}
        </div>

        {/* 模式说明卡片：互斥不叠加；关闭不切模式、不提交输入 */}
        {infoKey && (
          <div className="mode-info card-enter">
            <div className="mi-title">{MODE_INFO[infoKey].title}</div>
            <div className="mi-desc">{MODE_INFO[infoKey].desc}</div>
            {/* 一行 note 装两件事：spec C1 要的"为什么要先选" + "关闭不会切模式"的保证。
               上一轮这两句各占一个 .mi-note（两行文案再加一个 10px gap），在应用自己的最小高度
               960×640 下把卡片顶出视口 21px（变异自证实测：改回长文案，新断言 bottom=661/vh=640 红）。
               合并只省掉那一行和那个 gap，两句话一条没删。 */}
            <div className="mi-note">
              {MODE_INFO[infoKey].why}关闭说明不会切换模式，草稿与附件保持不变。
            </div>
            <div className="mi-actions">
              <Button
                variant="primary"
                onClick={() => {
                  const m = infoKey
                  setInfoKey(null)
                  enterMode(m)
                }}
              >
                <Icon name="chevron" size={13} /> {MODE_INFO[infoKey].enter}
              </Button>
              <Button variant="ghost" onClick={() => setInfoKey(null)}>关闭</Button>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={showModePrompt}
        onClose={() => setShowModePrompt(false)}
        title="请选择工作模式"
        width={420}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 12px' }}>
          {(['workbench', 'workflow'] as const).map((m) => (
            <button
              key={m}
              onClick={() => chooseMode(m)}
              style={{
                textAlign: 'left',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--r-md)',
                background: 'var(--surface)',
                padding: '14px 16px',
                cursor: 'pointer'
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>{MODE_INFO[m].title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>{MODE_INFO[m].desc}</div>
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

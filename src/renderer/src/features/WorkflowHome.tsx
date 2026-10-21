// 工作流首页：标题 + 中央大输入框 + 配置条（悬停 200ms 打开可选浮层 / 点击固定）+ 开始
import React, { useEffect, useRef, useState } from 'react'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icons'
import { ConfigPanel } from './ConfigPanel'
import { RolePicker, type RoleKey } from './RolePicker'
import { cls } from '../lib/utils'

export function WorkflowHome() {
  const draft = useWorkflow((s) => s.draft)
  const setDraft = useWorkflow((s) => s.setDraft)
  const config = useWorkflow((s) => s.config)
  const start = useWorkflow((s) => s.start)
  const isDemoRun = useWorkflow((s) => s.isDemoRun)
  const savedTasks = useWorkflow((s) => s.savedTasks)
  const saveCurrentTask = useWorkflow((s) => s.saveCurrentTask)
  const deleteSavedTask = useWorkflow((s) => s.deleteSavedTask)
  const applySavedTask = useWorkflow((s) => s.applySavedTask)
  const enterToSend = useSettings((s) => s.prefs?.enterToSend ?? true)
  const agents = useAgents((s) => s.agents)

  /** 快捷卡片的角色名（按保存的 agentId 反查；Agent 已删除时如实显示） */
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? '（已移除）'

  const [popKey, setPopKey] = useState<RoleKey | null>(null)
  const [pinned, setPinned] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [panelOpen, setPanelOpen] = useState(false)

  const closePop = () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setPopKey(null)
    setPinned(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePop()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // 点击浮层与配置入口外部时关闭；不进入输入框等无关区域误关面板（点击即意图明确）
      if (!t.closest('.cfg-pop') && !t.closest('.cfg-chip')) closePop()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [])

  const hoverOpen = (k: RoleKey) => {
    if (pinned) return // 固定打开时悬停不抢占，需点击切换
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (openTimer.current) clearTimeout(openTimer.current)
    if (popKey === k) return
    openTimer.current = setTimeout(() => setPopKey(k), 200)
  }
  const hoverClose = () => {
    if (pinned) return // 固定面板不因鼠标离开关闭
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setPopKey(null), 250)
  }
  const popEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }

  const roleInfo = (k: RoleKey) => {
    const r = config[k]
    const a = agents.find((x) => x.id === r.agentId)
    return { name: a?.name ?? '未配置', model: r.modelOverride ?? a?.model ?? '—', connected: a?.status === 'available' || a?.isDemo === true }
  }

  const onBegin = () => {
    if (!draft.trim()) {
      useUi.getState().toast('请先描述任务目标', 'warn')
      return
    }
    void start()
  }

  const demo = isDemoRun() && !!config.planner.agentId

  return (
    <div className="screen workflow">
        {/* 顶部入口：模式切换 + 设置（工作流界面常驻可达） */}
        <div style={{ position: 'absolute', top: 16, right: 20, display: 'flex', gap: 6, zIndex: 20 }}>
          <button className="icon-btn" title="切换模式（工作站 / 工作流）" aria-label="切换模式"
            onClick={() => useUi.getState().setSwitchHud('__switch_ask')}>
            <Icon name="swap" size={16} />
          </button>
          <button className="icon-btn" title="设置" aria-label="设置"
            onClick={() => useUi.getState().openSettings()}>
            <Icon name="settings" size={16} />
          </button>
        </div>

        {/* 左上角：保存的快捷任务卡片（最多 3 个，点击恢复目标与三角色配置） */}
        {savedTasks.length > 0 && (
          <div className="wf-saved">
            {savedTasks.map((t) => (
              <div key={t.id} className="wf-saved-card" title={`${t.goal}\n（点击恢复目标与配置后发起）`} onClick={() => applySavedTask(t.id)}>
                <div className="wf-saved-goal">{t.goal.length > 42 ? t.goal.slice(0, 42) + '…' : t.goal}</div>
                <div className="wf-saved-meta">
                  {agentName(t.plannerAgentId)} → {agentName(t.executorAgentId)} · {t.reviewMode === 'human' ? '人工' : '自动'}审核
                </div>
                <button
                  className="wf-saved-rm"
                  title="删除该快捷任务"
                  aria-label="删除快捷任务"
                  onClick={(e) => { e.stopPropagation(); deleteSavedTask(t.id) }}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="wf-home">
        <div className="wf-title">工作流模式</div>
        <div className="wf-desc">规划、执行与审核协作完成任务。</div>

        <div className="wf-composer-wrap">
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={onBegin}
            enterToSend={enterToSend}
            placeholder="描述要完成的任务、约束与期望产物…"
            autoFocusOnMount
          />
          <div className="wf-supplement-tip" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>Enter 开始（可在设置中改为 Ctrl+Enter）</span>
            <button
              className="cfg-chip"
              style={{ height: 24, fontSize: 11.5 }}
              title="保存当前目标 + 三角色配置 + 审核方式为快捷任务（左上角卡片，最多 3 个）"
              onClick={saveCurrentTask}
            >
              <Icon name="check" size={11} /> 保存任务{savedTasks.length > 0 ? `（${savedTasks.length}/3）` : ''}
            </button>
          </div>
        </div>

        {/* 配置条：悬停 200ms 打开可选浮层；点击固定（Escape / 外部点击关闭）；互斥不叠加 */}
        <div className="wf-configbar">
          {(['planner', 'executor', 'reviewer'] as const).map((k) => {
            const info = roleInfo(k)
            return (
              <div
                key={k}
                style={{ position: 'relative' }}
                onMouseEnter={() => hoverOpen(k)}
                onMouseLeave={hoverClose}
              >
                <button
                  className={cls('cfg-chip', popKey === k && 'open')}
                  onClick={() => {
                    if (popKey === k && pinned) closePop()
                    else {
                      if (openTimer.current) clearTimeout(openTimer.current)
                      if (closeTimer.current) clearTimeout(closeTimer.current)
                      setPopKey(k)
                      setPinned(true)
                    }
                  }}
                >
                  <span className={`role-tag ${k}`}>
                    {k === 'planner' ? '规划' : k === 'executor' ? '执行' : '审核'}
                  </span>
                  <b>{info.name}</b>
                  <span>{info.model}</span>
                </button>
                {popKey === k && (
                  <RolePicker role={k} onEnter={popEnter} onLeave={hoverClose} />
                )}
              </div>
            )
          })}

          <button
            className="cfg-chip"
            onClick={() => useWorkflow.getState().patchConfig({ reviewMode: config.reviewMode === 'human' ? 'auto' : 'human' })}
            title="审核方式始终可见；运行中修改将在下一检查点生效"
          >
            <Icon name="check" size={13} />
            审核：<b>{config.reviewMode === 'human' ? '人工确认' : '自动审核'}</b>
          </button>

          <button className="cfg-chip" onClick={() => setPanelOpen(true)}>
            <Icon name="settings" size={13} /> 更多设置
          </button>
        </div>

        <button className="btn btn-primary wf-start" style={{ height: 40, minWidth: 120 }} onClick={onBegin}>
          开始任务
        </button>

        {demo && (
          <div style={{ marginTop: 18 }}>
            <span className="demo-badge">当前配置为演示模式 · 无真实 Agent 也能跑通全流程</span>
          </div>
        )}
      </div>

      <ConfigPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </div>
  )
}

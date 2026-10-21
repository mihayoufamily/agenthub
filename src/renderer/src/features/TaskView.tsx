// 工作流任务视图：顶部任务状态条 + 角色卡片流 + 人工确认门 + 交付卡片 + 底部补充输入
import React, { useEffect, useRef, useState } from 'react'
import type { RoleCard as RoleCardType, WorkflowRun, Stage } from '@shared/types'
import { useWorkflow } from '../stores/workflow'
import { useUi } from '../stores/ui'
import { Icon } from '../components/Icons'
import { Button, Badge } from '../components/primitives'
import { Collapse } from '../components/Collapse'
import { Composer } from '../components/Composer'
import { fmtElapsed, cls } from '../lib/utils'

const STAGE_TEXT: Record<Stage, string> = {
  planning: '规划中',
  executing: '执行中',
  reviewing: '审核中',
  delivering: '交付中'
}

/**
 * 三角色同源检测（不阻止、只警示）：审核方与执行方为同一 Agent 时结论无独立性。
 * 取当前轮三个角色的 agentName 比对（名字相同即视为同源，足够覆盖常规配置）。
 */
function sameSourceWarning(run: WorkflowRun): string | null {
  const pick = (role: RoleCardType['role']) =>
    [...run.cards].reverse().find((c) => c.role === role && c.round === run.round)?.agentName
  const ex = pick('executor')
  const rv = pick('reviewer')
  const pl = pick('planner')
  if (ex && rv && ex === rv) {
    return pl === ex
      ? '⚠ 规划、执行、审核三方均为同一 Agent：结论既无分工校验也无独立验收，请谨慎采信'
      : '⚠ 审核方与执行方同源：该结论不具备独立验收效力（可在配置条为审核角色换一个 Agent）'
  }
  return null
}

const STATUS_TEXT: Record<string, string> = {
  preparing: '准备中',
  running: '执行中',
  waiting_review: '等待审核',
  waiting_user: '等待你的确认',
  stopping: '停止中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  rework_limit: '返工达到上限',
  interrupted: '状态未知（应用重启）',
  timeout: '超时已停止',
  token_limit: 'Token 上限已停止'
}

export function TaskView() {
  const run = useWorkflow((s) => s.run)
  const config = useWorkflow((s) => s.config)
  const stop = useWorkflow((s) => s.stop)
  const supplement = useWorkflow((s) => s.supplement)
  const exportRun = useWorkflow((s) => s.exportRun)
  const [detailOpen, setDetailOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const live = run && ['preparing', 'running', 'waiting_review'].includes(run.status)

  // 跟随滚动（底部附近）
  const lastCardCount = run?.cards.length ?? 0
  const lastConclusionLen = run?.cards.length ? run.cards[run.cards.length - 1].conclusion.length : 0
  const nearBottomRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [lastCardCount, lastConclusionLen, run?.status, run?.gate])

  if (!run) return null
  const elapsed = fmtElapsed((run.endedAt ?? now) - run.startedAt)

  return (
    <div className="screen workflow">
      <div className="wf-topbar">
        <div style={{ minWidth: 0 }}>
          <div className="goal txt-ellipsis" title={run.goal}>{run.goal}</div>
          <div className="stage-info">
            {live && <span className="spinner" style={{ width: 11, height: 11 }} />}
            <b>{run.stage ? STAGE_TEXT[run.stage] : (STATUS_TEXT[run.status] ?? '已结束')}</b>
            <span>第 {run.round}/{run.maxRounds} 轮</span>
            <span className="elapsed">{elapsed}</span>
            <Badge tone={run.reviewMode === 'human' ? 'warn' : 'info'}>
              {run.reviewMode === 'human' ? '人工确认' : '自动审核'}
            </Badge>
            {run.demo && <span className="demo-badge">演示模式</span>}
            <Badge tone={STATUS_BADGE[run.status] ?? 'default'}>{STATUS_TEXT[run.status] ?? run.status}</Badge>
          </div>
        </div>
        <div className="spacer" />
        <Button variant="ghost" onClick={() => useUi.getState().setSwitchHud('__switch_ask')} title="切换到工作站或其他模式">
          <Icon name="swap" size={14} /> 切换模式
        </Button>
        <Button variant="ghost" onClick={() => setDetailOpen((d) => !d)}>
          <Icon name="info" size={14} /> 详情
        </Button>
        {live && (
          <Button variant="danger" onClick={() => stop('user')}>
            <Icon name="stop" size={12} /> 停止
          </Button>
        )}
      </div>

      {detailOpen && (
        <div className="wf-detail">
          <div className="row"><span>任务 ID</span><b>{run.id}</b></div>
          <div className="row"><span>审核方式</span><b>{run.reviewMode === 'human' ? '人工确认（交付前）' : '自动审核'}{config.confirmEveryRound ? ' · 每轮确认' : ''}</b></div>
          <div className="row"><span>返工上限</span><b>{run.maxRounds} 轮</b></div>
          <div className="row"><span>开始时间</span><b>{new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}</b></div>
          <div className="row"><span>用量</span><b>{run.usage?.tokens ? `${run.usage.tokens} tokens` : elapsed}</b></div>
          {run.demo && <div style={{ color: 'var(--warn)' }}>本任务为演示数据：卡片内容、工具事件与产物均非真实执行。</div>}
          {(run.notes ?? []).length > 0 && (
            <div>
              <b>记录</b>
              {run.notes!.map((n, i) => (
                <div key={i} style={{ color: 'var(--text-2)', lineHeight: 1.6 }}>· {n}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="wf-stream" ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget
        nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      }}>
        <div className="wf-cards">
          <div className="wf-user-msg">{run.goal}</div>
          {run.cards.map((c) => (
            <CardRenderer key={c.id} card={c} run={run} />
          ))}
          {run.gate && run.status === 'waiting_user' && <GateCard run={run} />}
          {run.status === 'rework_limit' && <ReworkLimitCard run={run} />}
          {run.status === 'token_limit' && (
            <div className="gate-card" style={{ borderColor: 'rgba(180,83,9,.4)', background: 'var(--warn-bg)' }}>
              <div className="gate-title" style={{ color: 'var(--warn)' }}>
                <Icon name="warn" size={16} /> 累计 Token 已达上限，任务自动停止
              </div>
              <div className="gate-review">
                为控制成本已按设置自动停止（可在工作流设置中调整 Token 上限）。已完成的卡片与记录均已保留，可导出或以此为目标开新任务。
              </div>
              <div className="gate-actions">
                <Button variant="secondary" onClick={() => useWorkflow.getState().continueModify()}>以此为目标开新任务</Button>
                <Button variant="ghost" onClick={() => void exportRun()}>导出任务记录</Button>
              </div>
            </div>
          )}
          {run.status === 'interrupted' && (
            <div className="gate-card" style={{ borderColor: 'rgba(37,99,235,.4)', background: 'var(--info-bg)' }}>
              <div className="gate-title" style={{ color: 'var(--info)' }}>
                <Icon name="info" size={16} /> 应用重启导致执行状态未核对
              </div>
              <div className="gate-review">
                已恢复任务记录展示。AgentHub 不会盲目重放可能产生副作用的操作，也不会把未核对的状态当作运行中。
              </div>
              <div className="gate-actions">
                <Button variant="secondary" onClick={() => useWorkflow.getState().continueModify()}>以此为目标开新任务</Button>
                <Button variant="ghost" onClick={() => void exportRun()}>导出任务记录</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="wb-composer-wrap">
        <div style={{ width: 'min(860px, 100%)' }}>
          <TaskComposer />
        </div>
      </div>
    </div>
  )
}

/** 底部补充输入（草稿挂 ui store，独立于工作流执行状态） */
function TaskComposer() {
  const homeDraft = useUi((s) => s.homeDraft)
  const setHomeDraft = useUi((s) => s.setHomeDraft)
  const supplement = useWorkflow((s) => s.supplement)
  return (
    <Composer
      value={homeDraft}
      onChange={setHomeDraft}
      onSend={() => {
        const t = homeDraft.trim()
        if (t) {
          supplement(t)
          setHomeDraft('')
        }
      }}
      placeholder="补充要求…（将在下一轮生效，不修改已执行步骤）"
      enterToSend
      hint={<span>补充要求 · 下一轮生效</span>}
    />
  )
}

const STATUS_BADGE: Record<string, 'ok' | 'info' | 'warn' | 'danger' | 'default'> = {
  completed: 'ok',
  failed: 'danger',
  cancelled: 'default',
  rework_limit: 'warn',
  waiting_user: 'warn',
  interrupted: 'info',
  timeout: 'warn',
  token_limit: 'warn'
}

function CardRenderer({ card, run }: { card: RoleCardType; run: WorkflowRun }) {
  if (card.role === 'delivery') {
    return <DeliveryCard run={run} />
  }
  const roleColor = card.role === 'planner' ? 'var(--role-planner)' : card.role === 'executor' ? 'var(--role-executor)' : 'var(--role-reviewer)'
  return (
    <div className={cls('role-card', 'card-enter', card.status === 'streaming' && 'streaming')}>
      <div className="rc-head">
        <span className="rc-name" style={{ color: roleColor }}>
          <Icon name={card.role === 'planner' ? 'reorder' : card.role === 'executor' ? 'send' : 'check'} size={14} />
          {card.title}
        </span>
        <span className="rc-agent">{card.agentName}</span>
        <span className="rc-round">第 {card.round} 轮</span>
        {card.model !== '—' && <span className="rc-round">{card.model}</span>}
        {card.demo && <span className="demo-badge">演示</span>}
        <span className="rc-time">{new Date(card.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
      </div>
      <div className="rc-body">
        <div className="conclusion">
          {card.conclusion}
          {card.status === 'streaming' && <span className="caret" />}
        </div>
        {card.checklist && card.checklist.length > 0 && (
          <div className="checklist">
            {card.checklist.map((it, i) => (
              <div key={i} className={cls('check-item', it.verdict === 'pass' ? 'pass' : it.verdict === 'issue' ? 'issue' : '')}>
                <span className="mark">
                  <Icon name={it.verdict === 'issue' ? 'close' : 'check'} size={13} />
                </span>
                <span>{it.text}</span>
              </div>
            ))}
          </div>
        )}
        {card.artifacts && card.artifacts.length > 0 && (
          <div className="artifact-row">
            {card.artifacts.map((art) => (
              <span key={art.id} className="artifact-chip">
                <Icon name="file" size={12} />
                {art.name}
                <button
                  disabled={!!art.demo}
                  title={art.demo ? '演示产物未写入磁盘，无法打开' : '打开产物'}
                  onClick={() => void import('../lib/ipc').then(({ bridge }) => bridge.app.openExternal(art.path ?? ''))}
                >
                  打开
                </button>
              </span>
            ))}
          </div>
        )}
        <Collapse
          title="查看过程（阶段摘要 · 工具调用 · 日志）"
          events={card.process}
          streaming={card.status === 'streaming'}
          demo={card.demo}
        />
      </div>
    </div>
  )
}

function GateCard({ run }: { run: WorkflowRun }) {
  const confirmGate = useWorkflow((s) => s.confirmGate)
  const gate = run.gate!
  const [feedback, setFeedback] = useState('')
  return (
    <div className="gate-card card-enter">
      <div className="gate-title">
        <Icon name="warn" size={16} /> 人工确认 · 第 {gate.round} 轮审核结果
      </div>
      <div className="gate-review">
        {gate.passed.length > 0 && <div>✓ 通过 {gate.passed.length} 项</div>}
        {gate.issues.length > 0 && <div style={{ color: 'var(--danger-strong)' }}>✗ 问题 {gate.issues.length} 项：{gate.issues.map((i) => i.text).join('；')}</div>}
        {gate.reworkFeedback && <div style={{ color: 'var(--text-2)', marginTop: 4 }}>{gate.reworkFeedback}</div>}
        {sameSourceWarning(run) && (
          <div style={{ color: '#9a6700', background: 'rgba(180,83,9,0.08)', borderRadius: 8, padding: '6px 10px', marginTop: 6, fontSize: 12.5, lineHeight: 1.6 }}>
            {sameSourceWarning(run)}
          </div>
        )}
        <div style={{ color: 'var(--text-3)', marginTop: 6, fontSize: 12 }}>
          通过即交付；填写意见将进入下一轮返工。需授权的动作（发布/删除/覆盖）不因此获得自动授权。
        </div>
      </div>
      <div className="gate-feedback">
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="返工意见（选填；选择返工时生效）…"
        />
      </div>
      <div className="gate-actions">
        <Button variant="primary" onClick={() => void confirmGate('deliver')}>
          <Icon name="check" size={13} /> 通过并交付
        </Button>
        <Button variant="secondary" onClick={() => void confirmGate('rework', feedback)}>
          填写意见并返工
        </Button>
        <Button variant="ghost" onClick={() => confirmGate('stop')} style={{ color: 'var(--danger)' }}>
          停止任务
        </Button>
      </div>
    </div>
  )
}

function ReworkLimitCard({ run }: { run: WorkflowRun }) {
  const exportRun = useWorkflow((s) => s.exportRun)
  const continueModify = useWorkflow((s) => s.continueModify)
  return (
    <div className="gate-card card-enter" style={{ background: 'var(--warn-bg)' }}>
      <div className="gate-title">
        <Icon name="warn" size={16} /> 已达最大返工轮数（{run.maxRounds}）
      </div>
      <div className="gate-review">
        成果已保留，未完成项：见上方审核卡片。
        {(run.notes ?? []).filter((n) => n.startsWith('已达')).map((n, i) => (
          <div key={i} style={{ marginTop: 4 }}>{n}</div>
        ))}
      </div>
      <div className="gate-actions">
        <Button variant="secondary" onClick={() => void exportRun()}>导出任务记录</Button>
        <Button variant="primary" onClick={continueModify}>以此为目标开新任务</Button>
      </div>
    </div>
  )
}

function DeliveryCard({ run }: { run: WorkflowRun }) {
  const exportRun = useWorkflow((s) => s.exportRun)
  const continueModify = useWorkflow((s) => s.continueModify)
  const newTask = useWorkflow((s) => s.newTask)
  const failed = run.status === 'failed'
  const partial = run.status === 'rework_limit'
  return (
    <div className={cls('delivery-card', 'card-enter', partial && 'partial', failed && 'failed')}>
      <div className="dc-head">
        <span style={{ color: failed || partial ? 'var(--warn)' : 'var(--ok)', display: 'flex' }}>
          <Icon name={failed ? 'warn' : partial ? 'warn' : 'check'} size={17} />
        </span>
        {failed ? '任务失败' : partial ? '部分完成（返工达上限）' : '任务完成 · 交付'}
        <span className="st">
          <Badge tone={failed ? 'danger' : partial ? 'warn' : 'ok'}>
            {run.demo ? '演示数据 · 非真实执行' : STATUS_TEXT[run.status]}
          </Badge>
        </span>
      </div>
      <div className="dc-body">
        <div className="dc-section-title">已完成内容</div>
        <div className="word-break">{run.cards.filter((c) => c.role === 'delivery').slice(-1)[0]?.conclusion}</div>
        <div className="dc-section-title">验收对照</div>
        {sameSourceWarning(run) && (
          <div style={{ color: '#9a6700', background: 'rgba(180,83,9,0.08)', borderRadius: 8, padding: '6px 10px', marginBottom: 8, fontSize: 12.5, lineHeight: 1.6 }}>
            {sameSourceWarning(run)}
          </div>
        )}
        <div className="checklist">
          {(run.cards.filter((c) => c.role === 'reviewer').slice(-1)[0]?.checklist ?? []).map((it, i) => (
            <div key={i} className={cls('check-item', it.verdict === 'pass' ? 'pass' : 'issue')}>
              <span className="mark"><Icon name={it.verdict === 'issue' ? 'close' : 'check'} size={13} /></span>
              <span>{it.text}</span>
            </div>
          ))}
        </div>
        <div className="dc-section-title">产物与操作</div>
        <div className="dc-actions">
          <Button variant="secondary" onClick={() => void exportRun()}>
            <Icon name="file" size={13} /> 导出任务记录
          </Button>
          <Button variant="primary" onClick={continueModify}>继续修改（沿用上下文）</Button>
          <Button variant="ghost" onClick={newTask}>新建任务</Button>
        </div>
        {run.demo && (
          <div style={{ fontSize: 12, color: 'var(--warn)' }}>
            演示模式下产物未写入磁盘，"打开产物"不可用；接入真实 Agent 后此处展示可打开的真实产物。
          </div>
        )}
      </div>
    </div>
  )
}

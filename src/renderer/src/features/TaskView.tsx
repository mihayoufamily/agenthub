// 工作流任务视图：顶部任务状态条 + 角色卡片流 + 人工确认门 + 交付卡片 + 底部补充输入
import React, { useEffect, useRef, useState } from 'react'
import type { RoleCard as RoleCardType, WorkflowRun, Stage } from '@shared/types'
import { useWorkflow } from '../stores/workflow'
import { useUi } from '../stores/ui'
import { Icon } from '../components/Icons'
import { Button, Badge } from '../components/primitives'
import { Collapse } from '../components/Collapse'
import { Composer } from '../components/Composer'
import { OutputDirChip } from '../components/OutputDir'
import { CheckpointBar } from '../components/CheckpointBar'
import { bridge } from '../lib/ipc'
import { matchFileRef } from '@shared/acceptance'
import { hasExitCard, planAuditOf, type PlanCliDelta } from '@shared/engine-transitions'
import { pickUnregistered, unregisteredNote } from '@shared/delivery-dir'
import { STATUS_TEXT } from './WfChips'
import { fmtElapsed, cls, safeName } from '../lib/utils'

/** 打开本机文件（shell.openPath；失败时如实提示，不静默 no-op） */
async function openLocalPath(p: string) {
  const { bridge } = await import('../lib/ipc')
  const r = await bridge.app.openPath(p)
  if (!r.ok) useUi.getState().toast(`无法打开：${r.message ?? p}`, 'warn')
}

const STAGE_TEXT: Record<Stage, string> = {
  planning: '规划中',
  executing: '执行中',
  reviewing: '审核中',
  delivering: '交付中',
  awaiting_plan_approval: '等待批准计划'
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

export function TaskView() {
  const run = useWorkflow((s) => s.run)
  const config = useWorkflow((s) => s.config)
  const stop = useWorkflow((s) => s.stop)
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
        <OutputDirChip />
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
          {run.status === 'interrupted' && (
            <div className="gate-card" style={{ borderColor: 'rgba(180,83,9,.4)', background: 'var(--warn-bg)' }} data-interrupted-card>
              <div className="gate-title" style={{ color: 'var(--warn)' }}>
                <Icon name="warn" size={16} /> 应用重启过，这段执行状态没法核对
              </div>
              <div className="gate-review">
                已产生的卡片与产物都留着。下面这个"继续"是按已有卡片推断该谁接着跑，
                不会重放已经发生过的调用（重放会重复扣额度、重复写文件）；
                也可以只对某个角色点"重跑"，或者以此为目标开新任务。
              </div>
              <div className="gate-actions">
                <Button variant="primary" onClick={() => void useWorkflow.getState().resumeInterrupted()} data-resume>
                  从中断处继续
                </Button>
                <Button variant="secondary" onClick={() => useWorkflow.getState().continueModify()}>以此为目标开新任务</Button>
                <Button variant="ghost" onClick={() => useWorkflow.getState().newTask()}>新建任务</Button>
              </div>
            </div>
          )}
          {(run.status === 'token_limit' || run.status === 'budget_limit' || run.status === 'timeout') && (
            <div className="gate-card" style={{ borderColor: 'rgba(180,83,9,.4)', background: 'var(--warn-bg)' }} data-limit-card={run.status}>
              <div className="gate-title" style={{ color: 'var(--warn)' }}>
                <Icon name="warn" size={16} />
                {run.status === 'budget_limit'
                  ? `折算费用已达预算上限（${config.budgetYuan} 元），任务自动停止`
                  : run.status === 'timeout'
                    ? `任务超时（${config.timeoutMin} 分钟），已自动停止`
                    : '累计 Token 已达上限，任务自动停止'}
              </div>
              <div className="gate-review">
                {run.status === 'budget_limit'
                  ? '预算闸只统计折算得出金额的调用（无公开单价又未自填单价的模型不计入），实际花费可能高于这个数。已完成的卡片与记录均已保留，可导出或以此为目标开新任务。'
                  : run.status === 'timeout'
                    ? '超时视为停止条件：已完成的卡片、记录与产物引用均保留，可导出或以此为目标开新任务。'
                    : '为控制成本已按设置自动停止（可在工作流设置中调整 Token 上限）。已完成的卡片与记录均已保留，可导出或以此为目标开新任务。'}
              </div>
              <div className="gate-actions">
                <Button variant="secondary" onClick={() => useWorkflow.getState().continueModify()}>以此为目标开新任务</Button>
                <Button variant="ghost" onClick={() => useWorkflow.getState().newTask()}>新建任务</Button>
                <Button variant="ghost" onClick={() => void exportRun()}>导出任务记录</Button>
              </div>
            </div>
          )}
          {/* 终态操作卡：已取消/失败——此前这些终态没有任何出口，
              用户被留在死任务界面（补充输入无效、无法新建任务），实测修复。
              超时/Token 上限/预算上限走上面那张 limit 卡，中断走上面带"从中断处继续"的主卡 */}
          {(['cancelled', 'failed'] as const).includes(run.status as 'cancelled' | 'failed') && (
            <div className="gate-card" style={{ borderColor: 'rgba(220,38,38,.4)', background: 'var(--danger-bg, rgba(220,38,38,.06))' }}>
              <div className="gate-title" style={{ color: 'var(--danger)' }}>
                <Icon name="warn" size={16} />{run.status === 'cancelled' ? '任务已停止' : '任务失败'}
              </div>
              <div className="gate-review">
                {run.status === 'cancelled'
                  ? '任务已被手动停止。已产生的卡片与记录均已保留，不会盲目重放可能产生副作用的操作。'
                  : '执行过程中出现错误（原因见下方记录/提示）。已产生的卡片与记录均已保留。'}
                {run.notes && run.notes.length > 0 && (
                  <div style={{ marginTop: 6, color: 'var(--text-2)', lineHeight: 1.6 }}>
                    {run.notes.map((n, i) => <div key={i}>· {n}</div>)}
                  </div>
                )}
              </div>
              <div className="gate-actions">
                <Button variant="primary" onClick={() => useWorkflow.getState().newTask()}>新建任务</Button>
                <Button variant="secondary" onClick={() => useWorkflow.getState().continueModify()}>以此为目标开新任务</Button>
                <Button variant="ghost" onClick={() => void exportRun()}>导出任务记录</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 终态与中断不展示补充输入——补充要求只在执行中有效，终态保留输入会让用户误以为
          还能推进任务；出口统一由上方各终态操作卡提供。
          "哪些状态算有出口卡"的口径在 shared/engine-transitions（hasExitCard，七个终态），
          与引擎的终态列表同源；interrupted 不是出口（它是"从中断处继续"的续跑态），单独排除 */}
      {(hasExitCard(run.status) || run.status === 'interrupted') ? null : (
        <div className="wb-composer-wrap">
          <div style={{ width: 'min(860px, 100%)' }}>
            <TaskComposer />
          </div>
        </div>
      )}
    </div>
  )
}

/** 底部补充输入（本地草稿，独立于工作流执行状态）。
 *  不再挂 ui store 的 homeDraft：那是"首页待发送需求"的专用通道，工作流里打了补充草稿
 *  会让工作站的 ChatView 误标"有一条来自首页的需求待发送"。切任务丢草稿是可接受的取舍——
 *  补充要求本来就只对当前任务有意义。 */
function TaskComposer() {
  const [text, setText] = useState('')
  const supplement = useWorkflow((s) => s.supplement)
  return (
    <Composer
      value={text}
      onChange={setText}
      onSend={() => {
        const t = text.trim()
        if (t) {
          supplement(t)
          setText('')
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
  token_limit: 'warn',
  budget_limit: 'warn'
}

/**
 * 验收对照：审核结论 + 每条验收项指向的文件。
 * 文件名是角色自己报的，必须拿真实目录核对过才算数——指到不存在的文件要当场标红，
 * 不能让它把"我写了 a.ts"当成既成事实传给用户。
 */
function AcceptanceList({ run }: { run: WorkflowRun }) {
  const items = run.cards.filter((c) => c.role === 'reviewer').slice(-1)[0]?.checklist ?? []
  const [dirFiles, setDirFiles] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    if (run.demo || !items.some((i) => i.files?.length)) return
    let alive = true
    void bridge.artifacts.ls().then((r) => {
      if (!alive) return
      setDirFiles(r.files.map((f) => f.rel))
      setTruncated(!!r.truncated)
    })
    return () => {
      alive = false
    }
  }, [run.id, run.demo])

  const warn = sameSourceWarning(run)
  if (!items.length) return null

  return (
    <>
      {warn && (
        <div style={{ color: '#9a6700', background: 'rgba(180,83,9,0.08)', borderRadius: 8, padding: '6px 10px', marginBottom: 8, fontSize: 12.5, lineHeight: 1.6 }}>
          {warn}
        </div>
      )}
      <div className="checklist">
        {items.map((it, i) => (
          <div key={i} className={cls('check-item', it.verdict === 'pass' ? 'pass' : 'issue')}>
            <span className="mark"><Icon name={it.verdict === 'issue' ? 'close' : 'check'} size={13} /></span>
            <span>
              {it.text}
              {!!it.files?.length && (
                <span className="check-files">
                  {it.files.map((ref) => {
                    const m = dirFiles ? matchFileRef(ref, dirFiles) : null
                    return (
                      <span
                        key={ref}
                        className={cls('file-ref', m?.found ? 'ok' : 'missing')}
                        title={m?.found ? `目录里核对到：${m.rel}${m.by === 'name' ? '（按文件名匹配，路径可能不精确）' : ''}` : '产物目录里找不到这个文件'}
                      >
                        <Icon name="file" size={10} />
                        {ref}
                        {m?.found && dirFiles && m.rel !== ref && <span className="file-ref-note"> → {m.rel}</span>}
                        {m?.found && !truncated && dirFiles && (
                          <button className="file-ref-open" onClick={() => void openLocalPath(`${run.outputDir ?? ''}/${m.rel}`)}>打开</button>
                        )}
                      </span>
                    )
                  })}
                  {dirFiles === null && <span className="file-ref-note">（未核对）</span>}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      {truncated && <div className="cp-note">产物目录文件过多，对照只取了前 5000 个。</div>}
    </>
  )
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
        {(card.role === 'planner' || card.role === 'executor' || card.role === 'reviewer') && !run.demo && (
          <button
            className="rc-rerun"
            data-rerun={card.role}
            title="只重跑这一个角色：会新增一张卡片，不改写这张，也不动确认门"
            onClick={() => useWorkflow.getState().rerunRole(card.role as 'planner' | 'executor' | 'reviewer')}
          >
            重跑
          </button>
        )}
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
                <span title={art.demo ? '演示产物（未写入磁盘）' : art.by === 'tool' ? '由执行 Agent 写盘' : '由 AgentHub 保存的文本成果'}>{art.name}</span>
                {!art.demo && <span className="artifact-by">{art.by === 'tool' ? '执行方写盘' : 'AgentHub 保存'}</span>}
                <button
                  disabled={!!art.demo || !art.path}
                  title={art.demo ? '演示产物未写入磁盘，无法打开' : '打开产物'}
                  onClick={() => void openLocalPath(art.path ?? '')}
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

/** 确认门按种类分流：'plan' 是计划批准门（批准前不进执行与审核），其余仍是审核后人工确认 */
function GateCard({ run }: { run: WorkflowRun }) {
  if (run.gate?.kind === 'plan') return <PlanGateCard run={run} />
  return <ReviewGateCard run={run} />
}

function ReviewGateCard({ run }: { run: WorkflowRun }) {
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

/**
 * 计划批准门（批次 F）。措辞按 spec 的承诺分区写，一句都不夸大：
 * 模型 Agent 的写类工具是真拦的（执行前与 schema 两处），CLI 角色的写盘由它自己的
 * CLI 执行、AgentHub 拦不到——所以这里绝不出现"一定没改文件"。
 * 正文可选中复制；点「存为产物」之前它不落盘（计划正文自己不该成为交付物）。
 */
/**
 * 计划态期间 CLI 角色写盘的路径差集（planCliDelta 由引擎在计划门挂出时算好存进 run）。
 * 只显示、只复制，不做自动恢复——git 级/任务级回滚是另一批工作，这里绝不能有
 * "一键收回"的按钮假装能收回 AgentHub 根本拦不住的改动。
 */
function PlanCliDeltaCard({ run }: { run: WorkflowRun }) {
  const delta = planAuditOf(run).planCliDelta
  const copy = async (d: PlanCliDelta) => {
    const lines = [
      `计划轮期间产物目录的路径变化（新增 ${d.added.length} 条 / 消失 ${d.removed.length} 条）`,
      '',
      '[新增]',
      ...d.added.map((p) => `- ${p}`),
      '',
      '[消失]',
      ...d.removed.map((p) => `- ${p}`),
      ...(d.truncated ? ['', '（清单触到上限被截断，以上不是全部）'] : [])
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      useUi.getState().toast('路径变化清单已复制到剪贴板', 'ok')
    } catch (e) {
      useUi.getState().toast(`复制失败：${e instanceof Error ? e.message : '剪贴板不可用'}`, 'warn')
    }
  }
  if (!delta) return null
  return (
    <div className="gate-plan-note" data-plan-cli-delta="1" style={{ border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ flex: 1, fontSize: 12.5 }}>
          计划轮期间产物目录的路径变化（CLI 角色的写盘 AgentHub 拦不住，这里如实列出）
        </b>
        <button className="link-btn" data-plan-cli-delta-copy="1" onClick={() => void copy(delta)}>复制</button>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 12.5, lineHeight: 1.6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--ok)' }}>新增 {delta.added.length}{delta.truncated ? '（截断）' : ''}</div>
          <div style={{ maxHeight: 160, overflowY: 'auto', wordBreak: 'break-all' }}>
            {delta.added.map((p, i) => <div key={i} title={p}>{p}</div>)}
            {delta.added.length === 0 && <div style={{ color: 'var(--text-3)' }}>（无）</div>}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--warn)' }}>消失 {delta.removed.length}{delta.truncated ? '（截断）' : ''}</div>
          <div style={{ maxHeight: 160, overflowY: 'auto', wordBreak: 'break-all' }}>
            {delta.removed.map((p) => <div key={p} title={p}>{p}</div>)}
            {delta.removed.length === 0 && <div style={{ color: 'var(--text-3)' }}>（无）</div>}
          </div>
        </div>
      </div>
      {delta.added.length === 0 && delta.removed.length === 0 && (
        <div style={{ color: 'var(--text-3)', marginTop: 4, fontSize: 12 }}>
          两条清单都是空的：这只说明产物目录里没看到路径变化，不等于 CLI 角色没改过任何文件（原地改内容这里看不出来）。
        </div>
      )}
      <div style={{ color: 'var(--text-3)', marginTop: 6, fontSize: 12 }}>
        需要收回这些改动请手动处理或使用任务级回滚；AgentHub 不在这里自动执行恢复。
      </div>
    </div>
  )
}

function PlanGateCard({ run }: { run: WorkflowRun }) {
  const confirmGate = useWorkflow((s) => s.confirmGate)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const text = run.planText ?? ''
  const savePlan = async () => {
    const name = `计划-${safeName(run.goal)}.md`
    const r = await bridge.artifacts.write(name, `# 计划：${run.goal}\n\n${text}\n`, run.id)
    if (r.ok && r.path) {
      setSavedPath(r.path)
      useUi.getState().toast(`计划已存为产物：${r.path}`, 'ok')
    } else {
      useUi.getState().toast(`未能存为产物：${r.message ?? '未知原因'}`, 'error')
    }
  }
  const copyPlan = async () => {
    try {
      await navigator.clipboard.writeText(text)
      useUi.getState().toast('计划正文已复制到剪贴板', 'ok')
    } catch (e) {
      // 剪贴板权限没放行时如实说，并给出可行的另一条路（正文本就可选中，还有"存为产物"）
      useUi.getState().toast(`复制失败：${e instanceof Error ? e.message : '剪贴板不可用'}；正文可框选，或点「存为产物」`, 'warn')
    }
  }
  return (
    <div className="gate-card card-enter gate-plan" data-plan-gate="1">
      <div className="gate-title">
        <Icon name="warn" size={16} /> 计划待批准 · 批准前不执行
      </div>
      <div className="gate-plan-note">
        这一轮是<b>计划态</b>：只读地看，产出的是一份计划，批准后才进执行与审核。
        模型 Agent 的写类工具（写文件 / 替换 / 删除 / 移动 / 执行命令）本轮已被关闭，
        该 Agent 绑定的 MCP 工具本轮整组不接（判断不了某个 server 会不会写盘，执行权在我们手里就先关掉），
        你配置的 <b>Hook 本轮也不执行</b>——Hook 是自己会写盘的命令，代价是它的否决与审计这一轮也不生效。
        CLI 角色的写盘与命令由它自己的 CLI 执行，AgentHub 拦不到，只能事后列出改动——所以这里不说"一定没改文件"。
      </div>
      <pre className="gate-plan-text gate-review" data-plan-text="1">
        {text || '（规划角色没有返回正文）'}
      </pre>
      {/* CLI 角色的写盘 AgentHub 拦不到，只能在计划轮结束后把目录差集如实列出。
          注意判据的边界：看到的只有这个产物目录，所以"没有新文件"绝不写成"没改文件"。 */}
      <div className="gate-plan-note" data-cli-changes="1">
        {(() => {
          const changes = run.gate?.cliChanges ?? []
          const where = run.outputDir || '产物目录'
          if (changes.length === 0) {
            return `计划轮结束后：${where} 里没有新文件、也没有文件消失。这只说明这一处没变——CLI 角色在它自己的目录里做了什么，AgentHub 看不到。`
          }
          return `计划轮结束后，${where} 里的对照结果：${changes.slice(0, 8).join('；')}${changes.length > 8 ? `；另有 ${changes.length - 8} 条` : ''}。CLI 角色的写盘与命令由它自己的 CLI 执行，AgentHub 拦不到，只能事后列给你看。`
        })()}
      </div>
      {/* 计划态期间的路径差集（新增/消失两列 + 复制）。计划批准后这个门卡整体不再渲染，
          这块自然消失；老记录没有 planCliDelta 字段，也不渲染（不迁移、不猜） */}
      <PlanCliDeltaCard run={run} />
      <div className="gate-feedback">
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="对这一版计划的意见（选填；点「按意见重出计划」时生效）…"
        />
      </div>
      <div className="gate-actions">
        <Button variant="primary" disabled={!text.trim()} onClick={() => void confirmGate('deliver')}>
          <Icon name="check" size={13} /> 批准并继续
        </Button>
        <Button variant="secondary" onClick={() => void confirmGate('rework', feedback)} title="会再跑一轮规划，照实消耗一次真实调用">
          按意见重出计划（再消耗一次调用）
        </Button>
        <Button variant="secondary" onClick={() => void copyPlan()}>复制正文</Button>
        <Button variant="secondary" disabled={!text.trim()} onClick={() => void savePlan()}>
          {savedPath ? '已存为产物' : '存为产物'}
        </Button>
        <Button variant="ghost" onClick={() => confirmGate('stop')} style={{ color: 'var(--danger)' }}>
          停止任务
        </Button>
      </div>
      {!text.trim() && <div className="gate-plan-note">这一版计划是空的：没有可批准的东西，请填意见重出一版。</div>}
      {savedPath && <div className="gate-plan-note">已写入：{savedPath}</div>}
    </div>
  )
}

function ReworkLimitCard({ run }: { run: WorkflowRun }) {
  const exportRun = useWorkflow((s) => s.exportRun)
  const continueModify = useWorkflow((s) => s.continueModify)
  const newTask = useWorkflow((s) => s.newTask)
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
        <Button variant="ghost" onClick={newTask}>新建任务</Button>
        <Button variant="primary" onClick={continueModify}>以此为目标开新任务</Button>
      </div>
    </div>
  )
}

/**
 * 交付目录里"本任务没登记的文件"：列出来让你看见，不登记、也不替你删。
 * 来源是真实目录清单（主进程给），不是角色自述；量的是这个任务自己的产物目录，不是"当前配置的那个"。
 */
function UnregisteredNote({ dir, registeredPaths }: { dir: string; registeredPaths: string[] }) {
  const [note, setNote] = useState<string | null>(null)
  const key = dir + '|' + registeredPaths.join(',')
  useEffect(() => {
    let alive = true
    setNote(null)
    void bridge.artifacts
      .ls(dir)
      .then((r) => {
        if (!alive || !r.ok) return
        const extra = pickUnregistered(r.files.map((f) => f.rel), registeredPaths, r.dir || dir)
        setNote(extra.length ? unregisteredNote(extra, !!r.truncated) : null)
      })
      .catch(() => {
        /* 读不到目录就不出提示：宁可少说一句，不编一条"有垃圾" */
      })
    return () => {
      alive = false
    }
  }, [key])
  if (!note) return null
  return (
    <div style={{ fontSize: 12, color: 'var(--warn)', background: 'rgba(154,103,0,.07)', borderRadius: 8, padding: '6px 10px', marginBottom: 10, lineHeight: 1.6 }}>
      {note}
    </div>
  )
}

function DeliveryCard({ run }: { run: WorkflowRun }) {
  const exportRun = useWorkflow((s) => s.exportRun)
  const continueModify = useWorkflow((s) => s.continueModify)
  const newTask = useWorkflow((s) => s.newTask)
  const failed = run.status === 'failed'
  const partial = run.status === 'rework_limit'
  // 交付时汇总本次真实文件产物（同路径只列一次）
  const files = Array.from(
    new Map(
      run.cards
        .filter((c) => c.role === 'executor' && !c.demo)
        .flatMap((c) => (c.artifacts ?? []).filter((a) => a.kind === 'file' && !a.demo && a.path))
        .map((a) => [a.path as string, a])
    ).values()
  )
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
        <AcceptanceList run={run} />
        <div className="dc-section-title">产物与操作</div>
        {files.length > 0 && (
          <div className="artifact-row" style={{ marginBottom: 10 }}>
            {files.map((art) => (
              <span key={art.id} className="artifact-chip">
                <Icon name="file" size={12} />
                <span title={art.path}>{art.name}</span>
                <span className="artifact-by">{art.by === 'tool' ? '执行方写盘' : 'AgentHub 保存'}</span>
                <button onClick={() => void openLocalPath(art.path ?? '')}>打开</button>
              </span>
            ))}
          </div>
        )}
        {run.outputDir && !run.demo && (
          <UnregisteredNote dir={run.outputDir} registeredPaths={files.map((a) => a.path as string)} />
        )}
        {run.outputDir && !run.demo && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.6 }}>
            产物目录：
            <span className="word-break" title={run.outputDir}>{run.outputDir}</span>
            {' '}
            <button className="link-btn" onClick={() => void openLocalPath(run.outputDir ?? '')}>打开文件夹</button>
          </div>
        )}
        {!run.demo && <CheckpointBar id={run.id} title="本次任务改动的文件" />}
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

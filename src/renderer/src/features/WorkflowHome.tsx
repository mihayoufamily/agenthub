// 工作流首页：标题 + 中央大输入框 + 配置条（悬停 200ms 打开可选浮层 / 点击固定）+ 开始 + 任务队列
import React, { useEffect, useRef, useState } from 'react'
import { useWorkflow, runBusy } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icons'
import { Switch } from '../components/primitives'
import { ConfigPanel } from './ConfigPanel'
import { RolePicker, type RoleKey } from './RolePicker'
import { OutputDirChip } from '../components/OutputDir'
import { PresetChip, STATUS_TEXT } from './WfChips'
import { MAX_QUEUE } from '@shared/engine-transitions'
import type { WorkflowTemplate } from '@shared/types'
import { bridge } from '../lib/ipc'
import { cls } from '../lib/utils'

/**
 * 剧本目标模板的占位符替换（纯函数，导出供逻辑层测试）：
 * `{{日期}}` → 当天 YYYY-MM-DD、`{{时间}}` → HH:mm（都按本地时区）。
 * 未知占位符原样保留（不猜、不吞）：替换错了用户在输入框里看得见、可以自己改，
 * 静默吞掉一个 `{{项目名}}` 反而把"这条还没填"的事实藏了起来。
 */
export function expandTemplatePlaceholders(text: string, now: Date = new Date()): string {
  if (!text) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return text.replace(/\{\{\s*日期\s*\}\}/g, date).replace(/\{\{\s*时间\s*\}\}/g, time)
}

export function WorkflowHome() {
  const draft = useWorkflow((s) => s.draft)
  const setDraft = useWorkflow((s) => s.setDraft)
  const config = useWorkflow((s) => s.config)
  const start = useWorkflow((s) => s.start)
  const isDemoRun = useWorkflow((s) => s.isDemoRun)
  const planNextTask = useWorkflow((s) => s.planNextTask)
  const setPlanNextTask = useWorkflow((s) => s.setPlanNextTask)
  const tasks = useWorkflow((s) => s.tasks)
  const openTask = useWorkflow((s) => s.openTask)
  const removeTask = useWorkflow((s) => s.removeTask)
  const run = useWorkflow((s) => s.run)
  const queue = useWorkflow((s) => s.queue)
  const queueCurrent = useWorkflow((s) => s.queueCurrent)
  const removeQueued = useWorkflow((s) => s.removeQueued)
  const enterToSend = useSettings((s) => s.prefs?.enterToSend ?? true)
  const agents = useAgents((s) => s.agents)

  const [popKey, setPopKey] = useState<RoleKey | null>(null)
  const [pinned, setPinned] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composerWrapRef = useRef<HTMLDivElement | null>(null)

  // 剧本清单：挂载时拉一次（在设置页新建后回到首页会因重挂载重新拉到）
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  useEffect(() => {
    let alive = true
    bridge.templates.get().then((list) => {
      if (alive && Array.isArray(list)) setTemplates(list)
    }).catch(() => { /* 拉不到不挡任务输入，剧本块按不存在渲染 */ })
    return () => { alive = false }
  }, [])

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

  // 排入队列：忙时"开始"旁的替代动作。目标为空的检查 queueCurrent 里也有一道，
  // 这里先拦是不让空目标打出一条没有信息量的 toast 路径
  const onQueue = () => {
    if (!draft.trim()) {
      useUi.getState().toast('请先描述任务目标', 'warn')
      return
    }
    queueCurrent()
  }

  // 引擎只有一个执行循环：跑着的时候"开始"会被占用位挡下，这时排队是唯一的提交通道
  const busy = runBusy(run)

  // ---- 剧本动作 ----
  const focusComposer = () => composerWrapRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  /** 用剧本开任务：填草稿（替换占位符）→ 套预设 → 置单次档 → 聚焦输入框。绝不自动开始——要花钱的按钮必须人来按 */
  const applyTemplate = (t: WorkflowTemplate) => {
    setDraft(expandTemplatePlaceholders(t.goalTemplate))
    const wf = useWorkflow.getState()
    if (t.presetId) wf.applyPreset(t.presetId) // 预设被删时 applyPreset 自己 toast 说明
    if (t.planFirst) wf.setPlanNextTask(true)
    focusComposer()
    useUi.getState().toast(
      t.presetId ? `已载入剧本「${t.name}」（预设已套用）：确认或补充后点「开始任务」` : `已载入剧本「${t.name}」：确认或补充后点「开始任务」`,
      'ok'
    )
  }
  /** 仅载入：只填草稿，预设与计划档都不动 */
  const loadTemplateOnly = (t: WorkflowTemplate) => {
    setDraft(expandTemplatePlaceholders(t.goalTemplate))
    focusComposer()
    useUi.getState().toast(`已载入剧本「${t.name}」的目标模板（预设与计划档未动）`, 'info')
  }
  const removeTemplate = async (id: string) => {
    const next = templates.filter((x) => x.id !== id)
    const r = await bridge.templates.set(next).catch(() => null)
    if (!r) {
      useUi.getState().toast('删除失败：主进程无响应', 'error')
      return
    }
    setTemplates(r.list)
    if (r.rejected.length) useUi.getState().toast(`有 ${r.rejected.length} 条剧本未通过校验：${r.rejected[0].message}`, 'warn')
  }

  const demo = isDemoRun() && !!config.planner.agentId

  return (
    <div className="screen workflow">
        {/* 切换模式与设置统一在左侧栏（与工作站同一处），这里不再放右上角入口 */}
        <div className="wf-home">
        <div className="wf-title">工作流模式</div>
        <div className="wf-desc">规划、执行与审核协作完成任务。</div>

        <div className="wf-composer-wrap" ref={composerWrapRef}>
          {/* 输入框内右下角的提示在此场景下照实改写：Composer 默认写"Enter 发送"，但这里
              onSend 触发的是"开始任务"（整段工作流，不是发一条消息）——传 hint 覆盖默认措辞，
              并覆盖 enterToSend=false 时的 Ctrl+Enter 分支；原先框外左下那行"Enter 开始…"
              与框内提示信息重复、又和居中布局打架，删除（2026-10-25 UI 审查） */}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={onBegin}
            enterToSend={enterToSend}
            placeholder="描述要完成的任务、约束与期望产物…"
            autoFocusOnMount
            hint={enterToSend ? <span>Enter 开始 · Shift+Enter 换行</span> : <span>Ctrl+Enter 开始</span>}
          />
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

          <PresetChip />
          <OutputDirChip />

          <button className="cfg-chip" onClick={() => setPanelOpen(true)}>
            <Icon name="settings" size={13} /> 更多设置
          </button>
        </div>

        {/* 开始动作列：开始任务居中，排入队列在其正下方（忙时才出现）——
            原先三件挤同一行，排队按钮出现时会把"开始"挤偏，现在竖排互不影响 */}
        <div className="wf-start-actions">
          <button className="btn btn-primary wf-start" style={{ height: 40, minWidth: 120 }} onClick={onBegin}>
            开始任务
          </button>
          {/* 忙时"开始"会被单执行循环挡下，排队是唯一的提交通道；样式与相邻按钮一致 */}
          {busy && (
            <button
              className="btn btn-secondary"
              style={{ height: 40, minWidth: 120 }}
              onClick={onQueue}
              title="当前任务正在执行；排入队列后它会在当前任务到达终态（完成/失败/停止等）后自动开始，将消耗一次真实调用"
            >
              排入队列
            </button>
          )}
        </div>
        {/* 单次开关：勾一次即清，放在开始按钮下方（它是"开始"的修饰项，不该排在它前面）。
            不动「工作流设置」里那个全局档——"这一次先出计划"改的应该是这一次，不是以后每一次。
            上膛状态必须可见（勾了却看不出任何变化，用户无法确认它会不会生效）：
            开着时提示文字换成语义明确的"下一次开始会怎样"，并换强调色 */}
        <div className="wf-start-row">
          <Switch
            label="本任务先出计划"
            on={planNextTask}
            onChange={setPlanNextTask}
          />
          <span className={cls('wf-start-hint', planNextTask && 'wf-start-hint-on')}>
            {planNextTask
              ? '已开启：下一次「开始任务」会先出计划、停在批准门等你确认，才开始执行；开始后本开关自动关闭'
              : '只影响这一次提交'}
          </span>
        </div>

        {demo && (
          <div style={{ marginTop: 18 }}>
            <span className="demo-badge">当前配置为演示模式 · 无真实 Agent 也能跑通全流程</span>
          </div>
        )}

        {/* 剧本区：在任务队列/历史之上（它产出的是"下一次任务怎么起"）。无剧本时整块不显示，
            不留一个空标题占位。三个动作的差别要说清：开任务=填草稿+套预设+置计划档（仍不自动开始），
            仅载入=只填草稿 */}
        {templates.length > 0 && (
          <div className="wf-history wf-templates">
            <div className="wf-history-head">
              <b>剧本（{templates.length}）</b>
              <span>一键载入目标模板与预设；「开始任务」仍由你按下</span>
            </div>
            {templates.map((t) => (
              <div key={t.id} className="wf-history-row wf-tpl-row">
                <div className="wf-tpl-info" title={t.goalTemplate} style={{ cursor: 'default' }}>
                  <span className="wf-tpl-name">
                    {t.name}
                    {t.planFirst && <em className="wf-tpl-flag">先出计划</em>}
                  </span>
                  <em>{t.goalTemplate.length > 40 ? t.goalTemplate.slice(0, 40) + '…' : t.goalTemplate}</em>
                </div>
                <div className="wf-tpl-acts">
                  <button className="wf-tpl-btn primary" onClick={() => applyTemplate(t)}>
                    用这个剧本开任务
                  </button>
                  <button className="wf-tpl-btn" onClick={() => loadTemplateOnly(t)}>
                    仅载入
                  </button>
                  <button className="wf-preset-rm" title="删除剧本" aria-label="删除剧本" onClick={() => void removeTemplate(t.id)}>
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 任务队列条：条数 + 各条目标前 30 字 + 逐条删除。
            边界（与 store 注释同一口径）：队列只存在内存里，重启即清空；
            不保存图片附件；计划态开关在入队那一刻定格 */}
        {queue.length > 0 && (
          <div className="wf-history" data-queue-bar="1">
            <div className="wf-history-head">
              <b>任务队列（{queue.length}/{MAX_QUEUE}）</b>
              <span>当前任务到达终态后自动开始下一条；队列不持久化，重启即清空</span>
            </div>
            {queue.map((q, i) => (
              <div key={`${q.queuedAt}-${i}`} className="wf-history-row">
                <div className="wf-history-main" title={q.goal} style={{ cursor: 'default' }}>
                  <span className="txt-ellipsis">{q.goal.length > 30 ? q.goal.slice(0, 30) + '…' : q.goal}</span>
                  <em>排队中 · 当前任务结束后自动开始（将消耗一次真实调用）{q.planNextTask ? ' · 先出计划' : ''}</em>
                </div>
                <button className="wf-preset-rm" title="移出队列" aria-label="移出队列" onClick={() => removeQueued(i)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 历史区：侧栏只放最近 6 条，这里给全量（点开=回看/继续） */}
        {tasks.length > 0 && (
          <div className="wf-history">
            <div className="wf-history-head">
              <b>工作流任务（{tasks.length}）</b>
              <span>不限个数；进度随退出保留，点开可回看卡片、产物与确认门</span>
            </div>
            {tasks.map((r) => {
              const st = r.gate ? '待你确认' : STATUS_TEXT[r.status] ?? r.status
              return (
                <div key={r.id} className="wf-history-row">
                  <button className="wf-history-main" onClick={() => openTask(r.id)} title={r.goal}>
                    <span className={cls('wf-task-dot', runBusy(r) ? 'busy' : r.gate ? 'gate' : r.status === 'completed' ? 'done' : 'idle')} />
                    <span className="txt-ellipsis">{r.goal}</span>
                    <em>{st} · 第 {r.round}/{r.maxRounds} 轮{r.demo ? ' · 演示' : ''}</em>
                  </button>
                  <button className="wf-preset-rm" title="删除该任务（连同落盘记录）" aria-label="删除任务" onClick={() => void removeTask(r.id)}>
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ConfigPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </div>
  )
}

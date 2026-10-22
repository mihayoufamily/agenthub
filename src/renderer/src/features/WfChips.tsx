// 工作流入口组件：预设（角色 + 模型方案一键套用）与侧栏工作流任务列表（不限个数、历史可回看）
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkflow, runBusy } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { Icon } from '../components/Icons'
import { cls } from '../lib/utils'
import type { WorkflowRun } from '@shared/types'

/** 任务状态中文（TaskView 与侧栏列表共用；定义在这里避免两个模块互相引用） */
export const STATUS_TEXT: Record<string, string> = {
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

/** 待确认 > 执行中 > 已结束；同级按开始时间倒序 */
function rank(r: WorkflowRun): number {
  if (r.gate) return 0
  return runBusy(r) ? 1 : 2
}

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])
  return ref
}

export function PresetChip() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const presets = useWorkflow((s) => s.presets)
  const applyPreset = useWorkflow((s) => s.applyPreset)
  const deletePreset = useWorkflow((s) => s.deletePreset)
  const savePreset = useWorkflow((s) => s.savePreset)
  const agents = useAgents((s) => s.agents)
  const ref = useOutsideClose(() => setOpen(false))
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? '已删除的 Agent'

  return (
    <div className="wf-chip-anchor" ref={ref}>
      <button className={cls('cfg-chip', open && 'open')} title="预设：提前配好的三角色 + 模型方案，点一下套用" onClick={() => setOpen((v) => !v)}>
        <Icon name="check" size={13} /> 预设{presets.length > 0 ? `（${presets.length}）` : ''}
      </button>
      {open && (
        <div className="wf-chip-pop" role="menu">
          <div className="wf-pop-title">套用预设（只换角色与模型，不动目标、产物目录与审核方式）</div>
          {presets.length === 0 && <div className="wf-pop-empty">还没有预设。配好三角色后在下面起名保存，例如「重推理」「快产出」。</div>}
          {presets.map((p) => (
            <div key={p.id} className="wf-preset-row">
              <button
                className="wf-preset-main"
                onClick={() => {
                  applyPreset(p.id)
                  setOpen(false)
                }}
              >
                <b>{p.name}</b>
                <span>{nameOf(p.planner.agentId)} → {nameOf(p.executor.agentId)} → {nameOf(p.reviewer.agentId)}</span>
              </button>
              <button className="wf-preset-rm" title="删除该预设" aria-label="删除预设" onClick={() => deletePreset(p.id)}>
                ×
              </button>
            </div>
          ))}
          <div className="wf-pop-save">
            <input
              className="cp-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="把当前三角色存为预设…"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (savePreset(name)) setName('')
              }}
            />
            <button
              className="btn btn-secondary"
              style={{ height: 28, fontSize: 12 }}
              onClick={() => {
                if (savePreset(name)) setName('')
              }}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 侧栏工作流列表：不限个数，进行中/待确认排前，其余为可回看的历史。
 * 只放最近 6 条，更多去工作流首页的历史区看（侧栏不是任务管理器）。
 */
export function WfTaskList({ collapsed }: { collapsed: boolean }) {
  const tasks = useWorkflow((s) => s.tasks)
  const openRun = useWorkflow((s) => s.run)
  const openTask = useWorkflow((s) => s.openTask)
  const newTask = useWorkflow((s) => s.newTask)
  const removeTask = useWorkflow((s) => s.removeTask)
  const rows = useMemo(
    () => [...tasks].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt).slice(0, 6),
    [tasks]
  )
  const live = openRun && runBusy(openRun) ? openRun : null

  return (
    <div className="wf-tasks">
      <div className="wf-tasks-head">
        <span>工作流</span>
        <button className="wf-tasks-new" title="新建工作流（当前任务不会丢，回到列表里可再点开）" aria-label="新建工作流" onClick={() => newTask()}>
          <Icon name="plus" size={12} />
        </button>
      </div>

      {/* 常驻进度：离开工作流界面也看得到它还在跑 */}
      {live && (
        <div className={cls('wf-live', collapsed && 'mini')} title={`${live.goal}\n第 ${live.round}/${live.maxRounds} 轮 · ${STATUS_TEXT[live.status] ?? live.status}`}>
          <span className="spinner" />
          {!collapsed && <span className="txt-ellipsis">第 {live.round}/{live.maxRounds} 轮 · {STATUS_TEXT[live.status] ?? live.status}</span>}
        </div>
      )}

      {rows.map((r) => {
        const busy = runBusy(r)
        const cur = openRun?.id === r.id
        const st = r.gate ? '待你确认' : STATUS_TEXT[r.status] ?? r.status
        return (
          <div key={r.id} className={cls('wf-task', cur && 'cur')}>
            <button
              className="wf-task-main"
              onClick={() => openTask(r.id)}
              title={`${r.goal}\n状态：${st} · 第 ${r.round}/${r.maxRounds} 轮${r.demo ? ' · 演示数据' : ''}`}
            >
              <span className={cls('wf-task-dot', busy ? 'busy' : r.gate ? 'gate' : r.status === 'completed' ? 'done' : 'idle')} />
              {!collapsed && (
                <span className="wf-task-txt">
                  <span className="txt-ellipsis">{r.goal}</span>
                  <em>{st}{r.demo ? ' · 演示' : ''}</em>
                </span>
              )}
            </button>
            {!collapsed && (
              <button
                className="wf-task-rm"
                title="删除该任务（连同落盘记录）"
                aria-label="删除任务"
                onClick={() => void removeTask(r.id)}
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        )
      })}
      {rows.length === 0 && !collapsed && <div className="wf-task-empty">还没有工作流任务</div>}
      {tasks.length > rows.length && (
        <button className="wf-task-more" onClick={() => useUi.getState().setScreen('workflow')} title="工作流首页可查看全部历史">
          还有 {tasks.length - rows.length} 条…
        </button>
      )}
    </div>
  )
}

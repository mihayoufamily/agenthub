// 模式切换编排：无任务直接切换；有运行任务弹红色警告（默认焦点安全项）；
// 确认后先停止任务得到明确结果，再播放切换动画
import React, { useEffect, useState } from 'react'
import type { WorkMode } from '@shared/types'
import { useUi } from '../stores/ui'
import type { EntryCause } from '../lib/modeTransition'
import { useSettings } from '../stores/settings'
import { useWorkflow } from '../stores/workflow'
import { Modal } from '../components/Modal'
import { Button } from '../components/primitives'

const ACTIVE = ['preparing', 'running', 'waiting_review']

/** 请求切换模式（带运行中任务红色警告） */
export function requestModeSwitch(target: WorkMode, cause: EntryCause = 'sidebar-switch') {
  const run = useWorkflow.getState().run
  if (run && ACTIVE.includes(run.status)) {
    useUi.getState().setSwitchHud(`__switch_warn:${target}`)
  } else {
    enterMode(target, cause)
  }
}

/** 实际进入目标模式（草稿与历史自然保留） */
export function enterMode(target: WorkMode, cause: EntryCause = 'enter-mode') {
  const ui = useUi.getState()
  const homeDraft = ui.homeDraft
  if (target === 'workflow') {
    const wf = useWorkflow.getState()
    if (homeDraft.trim() && !wf.draft) {
      wf.setDraft(homeDraft) // 首页草稿带入工作流
    }
    ui.setHomeDraft('')
    ui.setHomeAttachments([])
    useSettings.getState().patchPrefs({ lastMode: 'workflow' })
    ui.setScreen('workflow')
  } else {
    // 工作台：首页草稿作为"待处理需求"横幅由 Workbench 呈现（不自动发送）
    useSettings.getState().patchPrefs({ lastMode: 'workbench' })
    useUi.getState().setModeEntryCause(cause) // 只有真切模式才写 cause：重挂载不播
    ui.setScreen('workbench')
  }
}

/** 红色警告弹窗 + 模式选择弹窗（挂在 App 根部） */
export function ModeSwitchWarning() {
  const hud = useUi((s) => s.switchHud)
  const setHud = useUi((s) => s.setSwitchHud)
  const [target, setTarget] = useState<WorkMode>('workbench')
  const [askOpen, setAskOpen] = useState(false)

  useEffect(() => {
    if (hud?.startsWith('__switch_warn:')) {
      setTarget(hud.split(':')[1] as WorkMode)
      setAskOpen(false)
    } else if (hud === '__switch_ask') {
      setAskOpen(true)
    } else {
      setAskOpen(false)
    }
  }, [hud])

  const open = !!hud?.startsWith('__switch_warn:')

  const stopAndSwitch = () => {
    useWorkflow.getState().stop('user')
    // 停止是同步状态置位，结果明确（cancelled）后再切换
    const status = useWorkflow.getState().run?.status
    if (status === 'cancelled' || status === 'failed') {
      setHud(null)
      enterMode(target)
    } else {
      useUi.getState().toast('停止未生效，任务仍在运行，已取消切换', 'error')
      setHud(null)
    }
  }

  if (!open && !askOpen) return null
  return (
    <>
      {askOpen && (
        <Modal open onClose={() => setHud(null)} title="切换到" width={380}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 0 10px' }}>
            <button
              className="btn btn-secondary"
              style={{ justifyContent: 'flex-start', padding: '12px 14px' }}
              onClick={() => { setHud(null); requestModeSwitch('workbench') }}
            >
              工作站模式 — 自由切换 Agent
            </button>
            <button
              className="btn btn-secondary"
              style={{ justifyContent: 'flex-start', padding: '12px 14px' }}
              onClick={() => { setHud(null); requestModeSwitch('workflow') }}
            >
              工作流模式 — 规划、执行、审核协作
            </button>
          </div>
        </Modal>
      )}
      {open && (
    <Modal
      open={open}
      onClose={() => setHud(null)}
      critical
      warning
      hideClose
      width={460}
      title="切换模式将停止当前任务"
      footer={
        <>
          {/* 安全项为默认焦点：Modal 会聚焦第一个可聚焦元素 */}
          <Button variant="primary" onClick={() => setHud(null)}>
            继续当前任务
          </Button>
          <Button variant="danger" onClick={stopAndSwitch}>
            停止任务并切换
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--text)', padding: '2px 0 10px' }}>
        <span style={{ color: 'var(--danger-strong)', fontWeight: 700 }}>
          当前任务正在执行。切换模式将停止当前任务。
        </span>
        <br />
        已保存的记录和产物会保留，未完成步骤将中断。
      </div>
    </Modal>
      )}
    </>
  )
}

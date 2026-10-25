// 工作站主界面：共享外壳（左侧栏）+ 聊天区 + 模式进入动画 + Shift+滚轮节流切换 + 空状态引导
import React, { useEffect, useState } from 'react'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { ChatView } from './ChatView'
import { Shell } from './Shell'
import { shouldPlayEntry, ENTRY_TOTAL_MS } from '../lib/modeTransition'
import { LogoMark } from '../components/Logo'
import { EmptyState, Button } from '../components/primitives'
import { Icon } from '../components/Icons'

const SHIFT_WHEEL_THROTTLE = 320

export function Workbench() {
  const agents = useAgents((s) => s.agents)
  const selectedId = useAgents((s) => s.selectedId)
  const select = useAgents((s) => s.select)
  const shiftWheelOn = useSettings((s) => s.prefs?.shiftWheelSwitch ?? true)
  const openSettings = useUi((s) => s.openSettings)

  // 无选中时默认选第一个（顺序由用户管理，不因选中自动置顶）
  useEffect(() => {
    if (!useAgents.getState().selectedId && agents.length > 0) {
      select(agents[0].id)
    }
  }, [agents, select])

  // Shift+滚轮：节流 + 边界停止 + 当前项提示；不干预普通滚动
  useEffect(() => {
    if (!shiftWheelOn) return
    let last = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return
      if ((e.target as HTMLElement).closest('.modal-overlay')) return
      const list = useAgents.getState().agents
      if (list.length < 2) return
      e.preventDefault()
      const now = Date.now()
      if (now - last < SHIFT_WHEEL_THROTTLE) return
      last = now
      const cur = useAgents.getState().selectedId
      const idx = list.findIndex((a) => a.id === cur)
      const dir = e.deltaY > 0 ? 1 : -1
      const next = idx + dir
      if (next < 0 || next >= list.length) return // 边界停止，不循环
      select(list[next].id)
      useAgents.getState().clearUnread(list[next].id)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [shiftWheelOn, select])

  const showEmpty = agents.length === 0
  const entryCause = useUi((st) => st.modeEntryCause)
  // 进站动画（C2）：播不播在**挂载那一刻**定格，并当场把 cause 消费掉。
  // 为什么不等播完再清位：cause 的职责是"防止下一次重挂载重播"（见 modeTransition.ts），
  // 不是"控制大字层何时消失"。原先把清位挂在 780ms 的 DOM 定时器上，而窗口被遮挡/后台时
  // Chromium 会把 DOM 定时器钳到秒级对齐（2026-10-25 真机实测：同一构建清位在 875~1300ms+ 间漂），
  // 位迟迟不清，这段时间里的切会话/切任务重挂载就会拿着旧 cause 再播一遍——真机套件的
  // "纯重挂载不再播"回归正是这个窗口被量到的。挂载即消费后，重播在状态层不可能发生；
  // 大字层的收场降级为纯观感问题，改由本地快照 + 定时器承担，收场晚一点不影响语义。
  const [entryShot] = useState(() => shouldPlayEntry(entryCause))
  const setEntryCause = useUi((st) => st.setModeEntryCause)
  useEffect(() => {
    if (!entryShot) return
    setEntryCause(null)
  }, [entryShot, setEntryCause])
  // 尊重"减少动态效果"：判定式与 Splash 一致（reducedMotion 或 animations===false 两个条件或运算）。
  // 不能只靠 tokens.css 那条全局压时长——那等于把合规性寄托在"大字层的基础样式恰好是透明的"上，
  // 谁哪天给它加一个可见的底样式，开关就静默失效。
  const prefs = useSettings((s) => s.prefs)
  const playing = entryShot && !(prefs?.reducedMotion || prefs?.animations === false)
  const [entryVisible, setEntryVisible] = useState(playing)
  useEffect(() => {
    // 依赖 entryVisible 而不是 playing：动画中途改"减少动态效果"会让 playing 翻转，
    // 挂在它身上定时器会被 cleanup 清掉且不再重排，大字层就永远不退场了
    if (!entryVisible) return
    const t = setTimeout(() => setEntryVisible(false), ENTRY_TOTAL_MS)
    return () => clearTimeout(t)
  }, [entryVisible])

  return (
    <Shell>
      {/* 模式进入大字：短暂停留后收束（CSS 动画自动完成） */}
      {entryVisible && <div className="wb-mode-title" data-entry="1">工作站模式</div>}

      {showEmpty ? (
        <div className="wb-main">
          <div className="wb-topbar">
            <LogoMark size={22} />
            <div>
              <div className="title">工作站模式</div>
              <div className="sub">在同一个应用中自由切换 Agent</div>
            </div>
            {/* 兼容模式徽章不在这里挂：它单挂在 Shell（两种模式共用），见 Shell.tsx */}
          </div>
          <EmptyState
            title="还没有可用 Agent"
            desc="添加演示 Agent 可立即体验全部界面与交互；添加自定义模型可进行真实对话；扫描本机只发现候选、不会读取任何软件的配置或密钥。"
            action={
              <div style={{ display: 'flex', gap: 10 }}>
                <Button variant="primary" onClick={() => useUi.getState().setAgentModal('add')}>
                  <Icon name="plus" size={14} /> 添加 Agent
                </Button>
                <Button variant="ghost" onClick={() => openSettings()}>设置</Button>
              </div>
            }
          />
        </div>
      ) : (
        selectedId && <ChatView onHandoff={() => useUi.getState().setAgentModal('handoff')} />
      )}
    </Shell>
  )
}

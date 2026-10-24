// 工作站主界面：共享外壳（左侧栏）+ 聊天区 + 模式进入动画 + Shift+滚轮节流切换 + 空状态引导
import React, { useEffect } from 'react'
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
  const setSwitchHud = useUi((s) => s.setSwitchHud)
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
  }, [shiftWheelOn, select, setSwitchHud])

  const showEmpty = agents.length === 0
  const entryCause = useUi((st) => st.modeEntryCause)
  const setEntryCause = useUi((st) => st.setModeEntryCause)
  // 尊重"减少动态效果"：判定式与 Splash 一致（reducedMotion 或 animations===false 两个条件或运算）。
  // 不能只靠 tokens.css 那条全局压时长——那等于把合规性寄托在"大字层的基础样式恰好是透明的"上，
  // 谁哪天给它加一个可见的底样式，开关就静默失效。
  const prefs = useSettings((s) => s.prefs)
  const playing = shouldPlayEntry(entryCause) && !(prefs?.reducedMotion || prefs?.animations === false)
  useEffect(() => {
    if (!playing) return
    // 播完清空 cause：下一次纯重挂载（切任务/切会话/重启恢复）就不会再播
    const t = setTimeout(() => setEntryCause(null), ENTRY_TOTAL_MS)
    return () => clearTimeout(t)
  }, [playing, setEntryCause])

  return (
    <Shell>
      {/* 模式进入大字：短暂停留后收束（CSS 动画自动完成） */}
      {playing && <div className="wb-mode-title" data-entry="1">工作站模式</div>}

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

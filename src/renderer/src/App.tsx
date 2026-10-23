// 应用根：启动编排（配置加载 -> Agent 初始化/演示种子 -> 恢复上次工作区）、屏幕路由、全局弹窗
import React, { useEffect, useState } from 'react'
import { useUi } from './stores/ui'
import { useSettings } from './stores/settings'
import { useAgents } from './stores/agents'
import { useWorkflow, runBusy } from './stores/workflow'
import { HOTKEY_DEFAULTS, type HotkeyAction } from '@shared/types'
import { matchKeyBinding, validateKeyBinding } from './lib/utils'
import { bridge } from './lib/ipc'
import { configurePriceOverrides } from '@shared/overrides'
import { installDebugHooks } from './lib/debug'
import { Splash } from './features/Splash'
import { BrandHome } from './features/BrandHome'
import { Workbench } from './features/Workbench'
import { Shell } from './features/Shell'
import { WorkflowHome } from './features/WorkflowHome'
import { TaskView } from './features/TaskView'
import { ModeSwitchWarning, requestModeSwitch } from './features/ModeSwitch'
import { SettingsPage } from './features/SettingsPage'
import { Toasts } from './components/Toasts'
import { ApprovalModal } from './components/ApprovalModal'
import { watchApprovals } from './stores/approvals'
import { Button, Spinner } from './components/primitives'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ position: 'absolute', inset: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text)', padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>界面出现错误</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', maxWidth: 420, lineHeight: 1.6 }}>{String(this.state.error?.message ?? this.state.error)}</div>
          <Button variant="primary" onClick={() => window.location.reload()}>重新加载界面</Button>
        </div>
      )
    }
    return this.props.children
  }
}

/** 新版本提示横幅（非模态：顶部居中，不阻塞任何操作，可忽略） */
function UpdateBanner() {
  const b = useUi((s) => s.updateBanner)
  if (!b) return null
  return (
    <div className="update-banner">
      <span className="ub-text">发现新版本 {b.version}</span>
      <button className="ub-btn" onClick={() => void bridge.app.openExternal(b.url)}>前往下载</button>
      <button className="ub-dismiss" aria-label="忽略更新提示" title="忽略" onClick={() => useUi.getState().setUpdateBanner(null)}>✕</button>
    </div>
  )
}

export function App() {
  const screen = useUi((s) => s.screen)
  const run = useWorkflow((s) => s.run)
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)

  // 全局快捷键（键位可在设置改）：切模式 / 开设置 / 停任务 / 新建工作流
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const kb = useSettings.getState().prefs?.keybindings ?? {}
      const hit = (a: HotkeyAction) => matchKeyBinding(kb[a] ?? HOTKEY_DEFAULTS[a], e)
      const ui = useUi.getState()
      const wf = useWorkflow.getState()
      if (hit('modeSwitch')) {
        if (ui.settingsOpen || (ui.screen !== 'workbench' && ui.screen !== 'workflow')) return
        e.preventDefault()
        requestModeSwitch(ui.screen === 'workbench' ? 'workflow' : 'workbench')
        return
      }
      if (hit('openSettings')) {
        e.preventDefault()
        if (ui.settingsOpen) ui.closeSettings()
        else ui.openSettings()
        return
      }
      if (hit('stopTask')) {
        if (!runBusy(wf.run)) return // 没在跑就不吞掉这个键
        e.preventDefault()
        wf.stop('user')
        return
      }
      if (hit('newWorkflow')) {
        if (ui.settingsOpen) return
        e.preventDefault()
        ui.setScreen('workflow')
        wf.newTask()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 把"有没有任务在跑"报给主进程：关闭窗口的确认由它决定（主进程不自己猜引擎状态）
  useEffect(() => {
    let last = false
    const push = () => {
      const b = runBusy(useWorkflow.getState().run)
      if (b === last) return
      last = b
      void bridge.app.setBusy(b)
    }
    push()
    return useWorkflow.subscribe(push)
  }, [])

  // 命令审批：事件与待裁决队列都挂在这一层（两种模式与设置页都要能弹出来）
  useEffect(() => watchApprovals(), [])

  useEffect(() => {
    installDebugHooks()
    void (async () => {
      try {
        await useSettings.getState().init()
        const cfg = await bridge.config.get()
        // 单价口径要在任何金额计算之前就位（费用估算、用量表、预算闸共用同一份）
        configurePriceOverrides(cfg.priceOverrides ?? [])
        const store = useAgents.getState()
        store.init(cfg.agents)
        // 首次运行无 Agent：种入演示 Agent（不连接任何真实服务），并把工作流三角色默认绑定
        let agents = useAgents.getState().agents
        if (agents.length === 0) {
          const a1 = store.addDemoAgent()
          const a2 = store.addDemoAgent()
          store.updateAgent(a1.id, { name: '演示 · 助手' })
          store.updateAgent(a2.id, { name: '演示 · 顾问' })
          agents = useAgents.getState().agents
        }
        const wd = cfg.workflowDefaults
        const byId = (id: string) => agents.find((a) => a.id === id)
        // 工作流默认配置可能引用已删除的 Agent（历史配置残留）：失效时回退到现有 Agent，不静默留空
        const pick = (savedId: string | undefined, fb: string | undefined) =>
          (savedId && byId(savedId) ? savedId : fb) || ''
        const mk = (savedId: string | undefined, fb: string | undefined, override: string | undefined, skillIds?: string[]) => {
          const id = pick(savedId, fb)
          const a = byId(id)
          // 角色仍指向原 Agent 才沿用它的模型覆盖；回退到别的 Agent 时那是另一个连接的模型名
          const ov = override && savedId && id === savedId ? override : undefined
          const sk = savedId && id === savedId ? skillIds : undefined
          return { agentId: id, agentName: a?.name ?? '未配置', model: ov ?? a?.model ?? '—', ...(ov ? { modelOverride: ov } : {}), ...(sk?.length ? { skillIds: sk } : {}) }
        }
        useWorkflow.getState().patchConfig({
          planner: mk(wd?.plannerAgentId, agents[0]?.id, wd?.plannerModel, wd?.plannerSkillIds),
          executor: mk(wd?.executorAgentId, agents[1 % Math.max(agents.length, 1)]?.id ?? agents[0]?.id, wd?.executorModel, wd?.executorSkillIds),
          reviewer: mk(wd?.reviewerAgentId, agents[agents.length - 1]?.id, wd?.reviewerModel, wd?.reviewerSkillIds),
          reviewMode: wd?.reviewMode ?? 'human',
          maxRounds: wd?.maxRounds ?? 3,
          timeoutMin: wd?.timeoutMin ?? 30,
          confirmEveryRound: wd?.confirmEveryRound ?? false,
          maxTokens: wd?.maxTokens ?? 0,
          budgetYuan: wd?.budgetYuan ?? 0,
          outputDir: wd?.outputDir ?? ''
        })
        // 预设（角色 + 模型方案）；工作流任务列表与进度由 restore() 从 runs/ 落盘记录恢复
        useWorkflow.getState().loadPresets(cfg.presets ?? [])
        void useWorkflow.getState().restore()
        // 历史遗留的非法键位（例如把切模式设成 Ctrl+C，会把复制一起吞掉且毫无提示）：启动即剔除并说明
        const kb = cfg.prefs?.keybindings
        if (kb) {
          const bad = (Object.keys(kb) as HotkeyAction[]).filter((a) => !validateKeyBinding(kb[a] ?? '').ok)
          if (bad.length) {
            const clean = { ...kb }
            for (const a of bad) delete clean[a]
            useSettings.getState().patchPrefs({ keybindings: clean })
            useUi.getState().toast(`已剔除 ${bad.length} 个占用编辑必需键的快捷键（${bad.join('、')}），已恢复默认键位`, 'warn')
          }
        }
        setReady(true)
        // 更新检查：启动后静默检查（3 天节流，失败不打扰）；发现新版本显示顶部横幅
        bridge.update.check(false).then((r) => {
          if (r.hasUpdate && r.latest && r.releaseUrl) {
            useUi.getState().setUpdateBanner({ version: r.latest, url: r.releaseUrl })
          }
        }).catch(() => { /* 静默 */ })
      } catch (e) {
        setFatal(`启动失败：${(e as Error).message}`)
      }
    })()
  }, [])

  const onRestore = () => {
    // 规格：点击"开始"固定进入品牌首页（"今天要构建什么"），工作模式由用户自选；
    // 工作流任务与进度在启动时已从落盘记录恢复（执行中的标"状态未知"），不自动重放
    useUi.getState().setScreen('brand')
  }

  if (fatal) {
    return (
      <div style={{ position: 'absolute', inset: 0, background: '#0b0b0c', color: '#f7f2e8', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>AgentHub 启动失败</div>
        <div style={{ fontSize: 12.5, opacity: 0.7, maxWidth: 460, lineHeight: 1.6 }}>{fatal}</div>
        <Button variant="primary" onClick={() => window.location.reload()}>重试</Button>
      </div>
    )
  }

  if (!ready) {
    return (
      <div style={{ position: 'absolute', inset: 0, background: '#0b0b0c', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#f7f2e8' }}>
        <Spinner />
        <span style={{ fontSize: 13 }}>正在加载…</span>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      {screen === 'splash' && <Splash onRestore={onRestore} />}
      {screen === 'brand' && <BrandHome />}
      {screen === 'workbench' && <Workbench />}
      {screen === 'workflow' && <Shell>{run ? <TaskView /> : <WorkflowHome />}</Shell>}
      <UpdateBanner />
      <SettingsPage />
      <ModeSwitchWarning />
      <ApprovalModal />
      <Toasts />
    </ErrorBoundary>
  )
}

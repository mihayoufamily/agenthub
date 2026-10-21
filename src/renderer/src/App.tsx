// 应用根：启动编排（配置加载 -> Agent 初始化/演示种子 -> 恢复上次工作区）、屏幕路由、全局弹窗
import React, { useEffect, useState } from 'react'
import { useUi } from './stores/ui'
import { useSettings } from './stores/settings'
import { useAgents } from './stores/agents'
import { useWorkflow } from './stores/workflow'
import { bridge } from './lib/ipc'
import { installDebugHooks } from './lib/debug'
import { Splash } from './features/Splash'
import { BrandHome } from './features/BrandHome'
import { Workbench } from './features/Workbench'
import { WorkflowHome } from './features/WorkflowHome'
import { TaskView } from './features/TaskView'
import { ModeSwitchWarning } from './features/ModeSwitch'
import { SettingsPage } from './features/SettingsPage'
import { Toasts } from './components/Toasts'
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

export function App() {
  const screen = useUi((s) => s.screen)
  const run = useWorkflow((s) => s.run)
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)

  useEffect(() => {
    installDebugHooks()
    void (async () => {
      try {
        await useSettings.getState().init()
        const cfg = await bridge.config.get()
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
        const mk = (id: string) => {
          const a = byId(id)
          return { agentId: id, agentName: a?.name ?? '未配置', model: a?.model ?? '—' }
        }
        useWorkflow.getState().patchConfig({
          planner: mk(pick(wd?.plannerAgentId, agents[0]?.id)),
          executor: mk(pick(wd?.executorAgentId, agents[1 % Math.max(agents.length, 1)]?.id ?? agents[0]?.id)),
          reviewer: mk(pick(wd?.reviewerAgentId, agents[agents.length - 1]?.id)),
          reviewMode: wd?.reviewMode ?? 'human',
          maxRounds: wd?.maxRounds ?? 3,
          timeoutMin: wd?.timeoutMin ?? 30,
          confirmEveryRound: wd?.confirmEveryRound ?? false,
          maxTokens: wd?.maxTokens ?? 0
        })
        setReady(true)
      } catch (e) {
        setFatal(`启动失败：${(e as Error).message}`)
      }
    })()
  }, [])

  const onRestore = () => {
    // 规格：点击"开始"固定进入品牌首页（"今天要构建什么"），工作模式由用户自选；
    // 后台仍恢复运行中任务状态（标记"状态未知"），进入工作流时可见，不盲目重放
    void useWorkflow.getState().restore()
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
      {screen === 'workflow' && (run ? <TaskView /> : <WorkflowHome />)}
      <SettingsPage />
      <ModeSwitchWarning />
      <Toasts />
    </ErrorBoundary>
  )
}

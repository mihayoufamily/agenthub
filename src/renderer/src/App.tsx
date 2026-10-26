// 应用根：启动编排（配置加载 -> Agent 初始化/演示种子 -> 恢复上次工作区）、屏幕路由、全局弹窗
import React, { useEffect, useState } from 'react'
import { useUi } from './stores/ui'
import { useSettings } from './stores/settings'
import { useAgents } from './stores/agents'
import { useWorkflow, runBusy } from './stores/workflow'
import { useSessions, setSessionUser } from './stores/sessions'
import { useNotifications } from './stores/notifications'
import { HOTKEY_DEFAULTS, type HotkeyAction } from '@shared/types'
import { matchKeyBinding, validateKeyBinding } from './lib/utils'
import { bridge } from './lib/ipc'
import { configurePriceOverrides } from '@shared/overrides'
import { installDebugHooks, isVerifyRuntime } from './lib/debug'
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
import { Modal } from './components/Modal'
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

/** 便携包下载的进行中/完成状态（App 本地 state：只有横幅与确认弹窗消费，不进 ui store） */
interface DlProgress {
  got: number
  total: number
  pct: number
}
interface DlDone {
  path: string
  sha256: string
  verified: boolean
  hashNote?: string
  /** 暂存结果：true 表示包已解包就绪、横幅进「应用更新」态；false/缺省看 stagedNote */
  staged?: boolean
  stagedVersion?: string
  /** 未暂存的原因（哈希没比对上 / 版本不比当前新 / 解包失败） */
  stagedNote?: string
}

/** 已暂存待应用的更新（update:stagedStatus 返回 / done 事件带出；与 preload 的 StagedUpdate 同形） */
interface StagedUpdate {
  version: string
  sha256: string
  stagedAt: number
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '未知大小'
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 新版本提示横幅（非模态：顶部居中，不阻塞任何操作，可忽略）。
 *  下载状态由 App 订阅 update:event 维护，这里按事实渲染四种形态：空闲 / 下载中 / 已就绪待应用 / 已完成。
 *  「应用更新」只换便携版的明文 resources/app（不动 AgentHub.exe 与 Electron 运行时），且只由这个
 *  按钮触发——绝不自动换入；NSIS 安装版（asar）不走一键换入。 */
function UpdateBanner({ dl, dlDone, staged, onAskDownload, onApply, onDismiss }: {
  dl: DlProgress | null
  dlDone: DlDone | null
  staged: StagedUpdate | null
  onAskDownload: () => void
  onApply: () => void
  onDismiss: () => void
}) {
  const b = useUi((s) => s.updateBanner)
  // 已暂存待应用的更新即使横幅本体被忽略过也要亮出来：staged.json 是"新包已经在本机"的事实，
  // 藏着它用户就找不到「应用更新」入口了
  if (!b && !staged) return null
  return (
    <div className="update-banner">
      {dl ? (
        <>
          <span className="ub-text">
            正在下载便携包 {fmtBytes(dl.got)} / {dl.total > 0 ? fmtBytes(dl.total) : '未知大小'}（只下载校验，不自动安装）
          </span>
          <div style={{ width: 120, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(2, dl.pct)}%`, height: '100%', background: '#7ad48a' }} />
          </div>
        </>
      ) : staged ? (
        <>
          <span className="ub-text" title={staged.sha256 ? `SHA-256 ${staged.sha256}` : '已暂存待应用'}>
            新版本 {staged.version} 已下载就绪（只换 resources/app，重启生效）
          </span>
          <button className="ub-btn" onClick={onApply}>应用更新（重启生效）</button>
        </>
      ) : dlDone ? (
        <>
          <span className="ub-text" title={dlDone.sha256}>
            便携包已下载 · SHA-256 {dlDone.verified ? '与发布说明一致' : dlDone.hashNote ? '发布说明里没找到哈希，仅显示计算值' : '与发布说明不一致，请勿使用'}
            {' '}（{dlDone.sha256.slice(0, 12)}…）
            {dlDone.stagedNote ? ` · ${dlDone.stagedNote}` : ''}
          </span>
          <button className="ub-btn" onClick={() => void bridge.update.openDownloadDir()}>打开所在文件夹</button>
        </>
      ) : (
        <>
          <span className="ub-text">发现新版本 {b?.version}</span>
          <button className="ub-btn" onClick={() => { if (b) void bridge.app.openExternal(b.url) }}>前往下载</button>
          <button className="ub-btn" onClick={onAskDownload}>下载便携包</button>
        </>
      )}
      <button className="ub-dismiss" aria-label="忽略更新提示" title="忽略" onClick={onDismiss}>✕</button>
    </div>
  )
}

export function App() {
  const screen = useUi((s) => s.screen)
  const run = useWorkflow((s) => s.run)
  const appInfo = useSettings((s) => s.appInfo)
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  // 便携包下载：确认弹窗 / 进度 / 完成结果（横幅按这几种状态渲染，事件来自主进程 update:event）
  const [askDl, setAskDl] = useState(false)
  const [dlAsset, setDlAsset] = useState<{ name: string; size: number } | null>(null)
  const [dl, setDl] = useState<DlProgress | null>(null)
  const [dlDone, setDlDone] = useState<DlDone | null>(null)
  // 已暂存待应用的更新（staged.json）：本次会话下载就绪或上次会话留下的事实
  const [staged, setStaged] = useState<StagedUpdate | null>(null)

  // 更新下载事件订阅：挂载时订阅、卸载时清理（onUpdateEvent 返回退订函数）
  useEffect(() => {
    return bridge.update.onUpdateEvent((ev) => {
      if (ev.type === 'progress') {
        setDl({ got: ev.got, total: ev.total, pct: ev.pct })
        return
      }
      if (ev.type === 'done') {
        setDl(null)
        setDlDone(ev)
        // 暂存成功：横幅直接进「应用更新」态（stagedAt 界面不展示，用当下时间补齐形状即可）
        if (ev.staged && ev.stagedVersion) {
          setStaged({ version: ev.stagedVersion, sha256: ev.sha256, stagedAt: Date.now() })
        } else {
          setStaged(null)
        }
        return
      }
      setDl(null)
      useUi.getState().toast(`更新包下载失败：${ev.message}`, 'error')
    })
  }, [])

  // 挂载时查一次暂存状态：上次会话下载并暂存过、还没应用的，横幅直接亮「应用更新」按钮
  useEffect(() => {
    bridge.update.stagedStatus().then((s) => {
      if (s) setStaged(s)
    }).catch(() => { /* 查询失败按无暂存处理，不打扰 */ })
  }, [])

  // 定时任务触发（main 每 30 秒 tick 判定到点后经 scheduler:fire 推来）：与 update:event 同一
  // 订阅先例——挂载订阅、卸载退订。这里只转发给 startScheduled（忙闲判定/排队/起链都在那边），
  // App 不感知调度细节；无论当前在哪个屏幕都能接到（工作流后台触发不要求用户停在首页）
  useEffect(() => {
    return bridge.schedule.onFire((schedule) => {
      // 通知中心留痕：系统通知可能因窗口聚焦被跳过，这里的记录是"确定存在"的
      useNotifications.getState().push({
        kind: 'schedule',
        title: `定时任务已触发：${schedule.name}`,
        body: schedule.goal.slice(0, 50)
      })
      useWorkflow.getState().startScheduled(schedule)
    })
  }, [])

  // 手机端写操作转发（main 已过 token 与 agentId 校验，这里只做业务侧裁决）：
  // 发消息走 sessions 的既有发送路径（与桌面输入框同一条链，技能注入/演示隔离/错误处理全复用）；
  // 审批只认 runId 与当前运行一致的请求——手机上看到的是几秒前的快照，run 对不上就拒，绝不误批别的任务
  useEffect(() => {
    const offSend = bridge.mobile.onSendMessage(({ agentId, text, uid }) => {
      const agent = useAgents.getState().agents.find((a) => a.id === agentId)
      useNotifications.getState().push({
        kind: 'task',
        title: `手机侧消息已送入：${agent?.name ?? agentId}`,
        body: text.slice(0, 50)
      })
      useUi.getState().toast(`手机侧消息已送入 ${agent?.name ?? 'Agent'}`)
      // uid=发送者的会话作用域：消息与流式回包写进发送者自己的会话（多用户隔离）
      void useSessions.getState().sendMessage(agentId, text, [], undefined, uid)
    })
    const offGate = bridge.mobile.onGateDecision(({ runId, action, feedback }) => {
      const cur = useWorkflow.getState().run
      if (!cur || cur.id !== runId) {
        useUi.getState().toast('手机侧审批被拒绝：该任务不在当前等待状态（可能已结束或已更新）', 'error')
        return
      }
      useNotifications.getState().push({
        kind: 'task',
        title: `手机侧审批：${action === 'deliver' ? '通过' : action === 'rework' ? '返工' : '停止'}`,
        body: (cur.goal ?? '').slice(0, 50)
      })
      void useWorkflow.getState().confirmGate(action, feedback)
    })
    // 手机端会话操作（新建/切换/删除/重命名）：uid=操作者作用域，与桌面侧栏同一条 store 链
    const offSess = bridge.mobile.onSessionOp(({ op, agentId, sessionId, title, uid }) => {
      const s = useSessions.getState()
      if (op === 'new') s.newSession(agentId, uid)
      else if (op === 'switch' && sessionId) s.switchSession(agentId, sessionId, uid)
      else if (op === 'delete' && sessionId) s.deleteSession(agentId, sessionId, uid)
      else if (op === 'rename' && sessionId && title) s.renameSession(agentId, sessionId, title, uid)
    })
    // 手机端新建自定义模型 Agent：走 addCustomModelAgent（先真测连接再存凭据，与桌面同一校验）
    const offAgent = bridge.mobile.onAgentCreate(async ({ name, provider, baseUrl, modelId, apiKey }) => {
      const r = await useAgents.getState().addCustomModelAgent(
        { ...(name ? { name } : {}), provider, baseUrl, modelId } as never,
        apiKey
      )
      if (r.ok && r.agent) {
        useAgents.getState().select(r.agent.id)
        useUi.getState().toast(`手机侧已创建 Agent：${r.agent.name}`)
      } else {
        useUi.getState().toast(`手机侧创建 Agent 失败：${r.message}`, 'error')
      }
    })
    // 手机端工作流操作：发起（setDraft+start，与桌面输入同链）/ 停止
    const offRun = bridge.mobile.onRunOp(({ op, goal }) => {
      const wf = useWorkflow.getState()
      if (op === 'start' && goal) {
        wf.setDraft(goal)
        void wf.start()
        useUi.getState().toast('手机侧已发起任务')
      } else if (op === 'stop') {
        wf.stop('user')
        useUi.getState().toast('手机侧已请求停止任务')
      }
    })
    return () => { offSend(); offGate(); offSess(); offAgent(); offRun() }
  }, [])

  const askDownload = () => {
    // 确认弹窗要显示文件大小：先现取一次发布信息（大小可能随发布更新，不能信上次横幅里的旧值）；
    // 取不到也照常弹，如实显示"未知大小"，真正下载时主进程还会再取一次
    setDlAsset(null)
    setAskDl(true)
    bridge.update.check(true).then((r) => {
      if (r.asset) setDlAsset(r.asset)
    }).catch(() => { /* 弹窗已按未知大小显示，不为此打断用户 */ })
  }

  const startDownload = () => {
    setAskDl(false)
    setDlDone(null)
    setDl({ got: 0, total: dlAsset?.size ?? 0, pct: 0 })
    void bridge.update.download().then((r) => {
      // 被拒（已有下载在跑等）：把乐观置上的进度态撤掉，如实提示
      if (!r.ok) {
        setDl(null)
        useUi.getState().toast(r.message ?? '下载未能开始', 'error')
      }
    })
  }

  const applyUpdate = () => {
    void bridge.update.apply().then((r) => {
      if (r.ok && r.relaunch) {
        // 主进程延迟 1.5s 自行 relaunch（给这条提示留显示时间），这里不重复触发重启
        useUi.getState().toast('更新完成，即将重启生效', 'ok')
      } else if (r.pending) {
        // 文件被占用没能热交换：主进程已写待启动标记、下次启动自动补做——如实告知，不粉饰成已更新
        useUi.getState().toast(r.message ?? '文件被占用，将在下次启动时自动应用', 'warn')
      } else {
        useUi.getState().toast(r.message ?? '应用更新失败', 'error')
      }
    })
  }

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
        requestModeSwitch(ui.screen === 'workbench' ? 'workflow' : 'workbench', 'hotkey')
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
    // __ahub_debug（验证钩子）只在验证态安装：主进程把 --ahub-verify 折进页面 URL 的 ahub-verify=1
    // （生产 loadFile 与开发 loadURL 两条路径一致，见 index.ts 的 isVerifyLaunch），渲染层读这个
    // 参数而不是 app.isPackaged——被测的部署构建本来就是 packaged，isPackaged 区分不了发布版与
    // 验证跑。发布版用户拿不到这组钩子：它们能直接驱动界面与 store，不该留在生产窗口里。
    if (isVerifyRuntime()) installDebugHooks()
    void (async () => {
      try {
        // 无锁屏（2026-10-26 二批）：账号=数据档案，启动直接进应用；
        // 会话/Agent/工作流配置跟随当前档案（侧栏可无密码切换）
        const authSt = await bridge.auth.state()
        setSessionUser(authSt.active?.id ?? 'local')
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
          // 计划态开关跟着默认值回来（patchConfig 已落盘这里必须读，否则重启就静默关掉）
          planFirst: wd?.planFirst ?? false,
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
        // 更新检查：启动后静默检查（3 天节流，失败不打扰）；发现新版本显示顶部横幅。
        // 顺手记下便携包资产信息（确认弹窗的大小显示有初值，点击下载时还会再取一次）
        bridge.update.check(false).then((r) => {
          if (r.asset) setDlAsset(r.asset)
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
      <UpdateBanner
        dl={dl}
        dlDone={dlDone}
        staged={staged}
        onAskDownload={askDownload}
        onApply={applyUpdate}
        onDismiss={() => {
          // 关横幅时连同下载/暂存状态一起清：否则下次横幅再出现会闪回上一轮的"已下载"结论
          // （暂存事实本身还在 staged.json 里，下次启动会再亮出来）
          useUi.getState().setUpdateBanner(null)
          setDl(null)
          setDlDone(null)
          setStaged(null)
        }}
      />
      <Modal
        open={askDl}
        onClose={() => setAskDl(false)}
        title="下载便携更新包"
        width={430}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAskDl(false)}>取消</Button>
            <Button variant="primary" onClick={startDownload}>开始下载</Button>
          </>
        }
      >
        <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--text)' }}>
          <div>文件：{dlAsset?.name ?? 'AgentHub 便携包（win-x64 .zip）'}</div>
          <div>大小：{dlAsset ? fmtBytes(dlAsset.size) : '未知（未取到发布信息）'}</div>
          <div className="word-break">
            保存位置：{appInfo?.userDataPath ? `${appInfo.userDataPath}\\updates` : '应用数据目录下的 updates 文件夹'}
          </div>
          <div style={{ marginTop: 6, color: 'var(--text-2)' }}>
            只下载到本地并校验 SHA-256，不会自动安装或替换程序——安装请自行解压替换。
          </div>
        </div>
      </Modal>
      <SettingsPage />
      <ModeSwitchWarning />
      <ApprovalModal />
      <Toasts />
    </ErrorBoundary>
  )
}

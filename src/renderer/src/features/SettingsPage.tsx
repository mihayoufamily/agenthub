// 设置页：六分区（外观 / Agent 与模型 / 工作流 / 快捷键 / 数据 / 关于）
import React, { useState } from 'react'
import { useSettings } from '../stores/settings'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useWorkflow } from '../stores/workflow'
import { Icon } from '../components/Icons'
import { Switch, Button, Badge, statusText, Spinner } from '../components/primitives'
import { bridge } from '../lib/ipc'
import { fmtTime } from '../lib/utils'

type Section = 'appearance' | 'agents' | 'workflow' | 'shortcuts' | 'data' | 'about'

const NAV: { key: Section; label: string; icon: string }[] = [
  { key: 'appearance', label: '外观', icon: 'info' },
  { key: 'agents', label: 'Agent 与模型', icon: 'file' },
  { key: 'workflow', label: '工作流', icon: 'reorder' },
  { key: 'shortcuts', label: '快捷键', icon: 'send' },
  { key: 'data', label: '数据', icon: 'folder' },
  { key: 'about', label: '关于', icon: 'info' }
]

export function SettingsPage() {
  const open = useUi((s) => s.settingsOpen)
  const close = useUi((s) => s.closeSettings)
  const [section, setSection] = useState<Section>('appearance')

  if (!open) return null
  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="settings-win" role="dialog" aria-label="设置">
        <div className="settings-nav">
          {NAV.map((n) => (
            <button key={n.key} className={`nav-item ${section === n.key ? 'active' : ''}`} onClick={() => setSection(n.key)}>
              <Icon name={n.icon} size={14} /> {n.label}
            </button>
          ))}
        </div>
        <div className="settings-main">
          <div className="settings-head">
            {NAV.find((n) => n.key === section)?.label}
            <button className="icon-btn" onClick={close} title="关闭" aria-label="关闭设置">
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="settings-body">
            {section === 'appearance' && <AppearanceSection />}
            {section === 'agents' && <AgentsSection />}
            {section === 'workflow' && <WorkflowSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'data' && <DataSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, desc, children }: { label: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div className="lbl">{label}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="ctrl">{children}</div>
    </div>
  )
}

/* ---- 外观 ---- */
function AppearanceSection() {
  const prefs = useSettings((s) => s.prefs)
  const patch = useSettings((s) => s.patchPrefs)
  if (!prefs) return <Spinner />
  return (
    <div className="set-group">
      <Row label="主题" desc="浅色 / 深色 / 跟随系统">
        <div className="seg">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button key={t} className={prefs.theme === t ? 'active' : ''} onClick={() => patch({ theme: t })}>
              {t === 'light' ? '浅色' : t === 'dark' ? '深色' : '跟随系统'}
            </button>
          ))}
        </div>
      </Row>
      <Row label="界面动画" desc="关闭后所有过渡压至瞬时">
        <Switch label="动画" on={prefs.animations} onChange={(v) => patch({ animations: v })} />
      </Row>
      <Row label="减少动态效果" desc="同时尊重系统级偏好">
        <Switch label="减少动态" on={prefs.reducedMotion} onChange={(v) => patch({ reducedMotion: v })} />
      </Row>
      <Row label="启动动画" desc="每次启动均播放完整开屏与欢迎动画（Esc 可跳过过渡）" />
      <Row label="字体大小" desc={`当前 ${prefs.fontSize}px`}>
        <input
          type="range"
          min={12}
          max={18}
          step={1}
          value={prefs.fontSize}
          onChange={(e) => patch({ fontSize: Number(e.target.value) })}
        />
      </Row>
      <Row label="侧栏折叠" desc="工作站左侧栏保持折叠状态">
        <Switch label="侧栏" on={prefs.sidebarCollapsed} onChange={(v) => patch({ sidebarCollapsed: v })} />
      </Row>
    </div>
  )
}

/* ---- Agent 与模型 ---- */
function AgentsSection() {
  const agents = useAgents((s) => s.agents)
  const removeAgent = useAgents((s) => s.removeAgent)
  const scanning = useAgents((s) => s.scanning)
  const scan = useAgents((s) => s.scan)
  const colorOf = useAgents((s) => s.colorOf)
  return (
    <div className="set-group">
      <div className="group-title" style={{ display: 'flex', alignItems: 'center' }}>
        已连接 Agent
        <span style={{ marginLeft: 'auto' }}>
          <Button variant="secondary" style={{ height: 28 }} loading={scanning} onClick={() => void scan()}>
            <Icon name="scan" size={13} /> 重新扫描
          </Button>
        </span>
      </div>
      {agents.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '6px 0 12px' }}>尚无 Agent。到工作站 → 添加 Agent 中添加。</div>}
      {agents.map((a) => (
        <div key={a.id} className="agent-manage-row">
          <span className="avatar" style={{ background: colorOf(a.id), width: 26, height: 26, fontSize: 12 }}>
            {a.name.charAt(0).toUpperCase()}
          </span>
          <div className="info">
            <div className="nm">{a.name} {a.isDemo && <Badge tone="warn">演示</Badge>}</div>
            <div className="md">{a.model} · {statusText(a.status)}{a.modelConfig ? ` · ${a.modelConfig.baseUrl}` : ''}</div>
          </div>
          {a.modelConfig && (
            <Button
              variant="ghost"
              style={{ height: 26 }}
              title="删除加密存储的 API Key（会话仍在，需重新填写后才能对话）"
              onClick={async () => {
                await bridge.credentials.delete(a.modelConfig!.keyId)
                useAgents.getState().updateAgent(a.id, { status: 'disconnected' })
                useAgents.getState().updateAgent(a.id, { modelConfig: { ...a.modelConfig!, hasKey: false } })
                useUi.getState().toast('已删除该 Agent 的 API Key', 'ok')
              }}
            >
              删除 Key
            </Button>
          )}
          <Button variant="ghost" style={{ height: 26, color: 'var(--danger)' }} onClick={() => void removeAgent(a.id, { deleteHistory: false })}>
            移除连接
          </Button>
        </div>
      ))}
      <div className="desc" style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
        API Key 使用系统安全凭据存储加密；不写入 Git 仓库、普通日志或导出文件。发现 ≠ 接入：CLI 候选在完成连接验证前不能执行任务。
      </div>
    </div>
  )
}

/* ---- 工作流 ---- */
function WorkflowSection() {
  const config = useWorkflow((s) => s.config)
  const patch = useWorkflow((s) => s.patchConfig)
  return (
    <div className="set-group">
      <Row label="默认审核方式" desc="新任务沿用的审核方式">
        <div className="seg">
          <button className={config.reviewMode === 'auto' ? 'active' : ''} onClick={() => patch({ reviewMode: 'auto' })}>自动审核</button>
          <button className={config.reviewMode === 'human' ? 'active' : ''} onClick={() => patch({ reviewMode: 'human' })}>人工确认</button>
        </div>
      </Row>
      <Row label="每轮审核后人工确认" desc="关闭时仅在最终交付前确认">
        <Switch label="每轮确认" on={config.confirmEveryRound} onChange={(v) => patch({ confirmEveryRound: v })} />
      </Row>
      <Row label="最大返工轮数" desc="达到上限保留成果并等待你的决定">
        <input type="number" min={1} max={10} value={config.maxRounds} style={{ width: 70, height: 30, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)' }}
          onChange={(e) => patch({ maxRounds: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
      </Row>
      <Row label="任务超时（分钟）" desc="超时停止任务，记录保留">
        <input type="number" min={1} max={720} value={config.timeoutMin} style={{ width: 70, height: 30, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)' }}
          onChange={(e) => patch({ timeoutMin: Math.max(1, Math.min(720, Number(e.target.value) || 30)) })} />
      </Row>
    </div>
  )
}

/* ---- 快捷键 ---- */
function ShortcutsSection() {
  const prefs = useSettings((s) => s.prefs)
  const patch = useSettings((s) => s.patchPrefs)
  if (!prefs) return null
  return (
    <div className="set-group">
      <Row label="Enter 发送" desc="关闭后 Enter 换行、Ctrl+Enter 发送（两种模式均受影响）">
        <Switch label="Enter 发送" on={prefs.enterToSend} onChange={(v) => patch({ enterToSend: v })} />
      </Row>
      <Row label="Shift + 滚轮切换 Agent" desc="工作站内使用；带节流、到列表边界停止、显示当前 Agent">
        <Switch label="Shift+滚轮" on={prefs.shiftWheelSwitch} onChange={(v) => patch({ shiftWheelSwitch: v })} />
      </Row>
      <div className="desc" style={{ lineHeight: 1.8 }}>
        <span className="kbd">Shift</span> + <span className="kbd">滚轮</span>：切到上/下一个 Agent
        <br />
        <span className="kbd">Enter</span> / <span className="kbd">Shift+Enter</span>：发送 / 换行（可配置）
        <br />
        <span className="kbd">Esc</span>：关闭浮层与弹窗（关键确认除外）
      </div>
    </div>
  )
}

/* ---- 数据 ---- */
function DataSection() {
  const settings = useSettings()
  const memory = useSettings((s) => s.memory)
  const info = useSettings((s) => s.appInfo)
  const [editId, setEditId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  return (
    <div>
      <div className="set-group">
        <div className="group-title">数据位置与备份</div>
        <Row label="数据保存位置" desc={info?.userDataPath}>
          <Button variant="secondary" style={{ height: 28 }} onClick={() => void bridge.app.openDataFolder()}>
            <Icon name="folder" size={13} /> 打开数据目录
          </Button>
        </Row>
        <Row label="配置导入 / 导出" desc="含 Agent、角色配置与偏好；API Key 不导出，导入后需重新填写">
          <Button variant="secondary" style={{ height: 28 }} onClick={() => void settings.exportConfig()}>导出</Button>
          <Button variant="secondary" style={{ height: 28 }} onClick={() => void settings.importConfig()}>导入</Button>
        </Row>
        <Row label="会话与任务记录导出" desc="把工作流任务记录导出为 Markdown">
          <Button variant="secondary" style={{ height: 28 }} onClick={() => void settings.exportSessionRecord()}>导出记录</Button>
        </Row>
      </div>

      <div className="set-group">
        <div className="group-title">项目长期记忆（区别于单次任务记录；由 AgentHub 持久保存，可查看/修改/删除）</div>
        {memory.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '4px 0 10px' }}>暂无记忆条目。</div>}
        {memory.map((m) => (
          <div key={m.id} className="mem-row">
            <span className="kind">{m.kind}</span>
            {editId === m.id ? (
              <>
                <input
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  style={{ flex: 1, fontSize: 12.5, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'var(--surface)' }}
                />
                <Button variant="primary" style={{ height: 24, padding: '0 8px' }} onClick={() => { settings.updateMemory(m.id, editText); setEditId(null) }}>保存</Button>
              </>
            ) : (
              <>
                <span className="txt word-break">{m.text}</span>
                <span className="acts">
                  {m.editable && (
                    <button className="icon-btn" title="修改" onClick={() => { setEditId(m.id); setEditText(m.text) }}>
                      <Icon name="reorder" size={13} />
                    </button>
                  )}
                  <button className="icon-btn danger" title="删除" onClick={() => settings.removeMemory(m.id)}>
                    <Icon name="close" size={13} />
                  </button>
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="set-group">
        <div className="group-title">清理</div>
        <Row label="清空任务记录" desc="删除所有工作流任务记录（演示数据一并删除）；不可恢复，请先导出">
          <Button
            variant="danger"
            style={{ height: 28 }}
            onClick={async () => {
              const runs = await bridge.runs.list()
              for (const r of runs) {
                await bridge.runs.remove(r.id)
              }
              useUi.getState().toast(`已清空 ${runs.length} 条任务记录`, 'ok')
            }}
          >
            清空记录
          </Button>
        </Row>
        <div className="desc" style={{ lineHeight: 1.7 }}>
          数据删除说明：会话与任务记录为独立 JSON 文件，删除对应文件即彻底移除；API Key 通过"Agent 与模型 → 删除 Key"逐个移除；
          完整卸载时删除数据目录（上方"打开数据目录"所在位置）即可清除全部本地数据。
        </div>
      </div>
    </div>
  )
}

/* ---- 关于 ---- */
function AboutSection() {
  const info = useSettings((s) => s.appInfo)
  return (
    <div className="set-group">
      <Row label="应用版本" desc={info?.version} />
      <Row label="Electron / Chromium / Node" desc={`${info?.electron} / ${info?.chrome} / ${info?.node}`} />
      <Row label="平台" desc={info?.platform} />
      <Row label="开源仓库与许可证" desc="发布时由项目所有者填写仓库地址；许可证待项目所有者确认后加入（当前 LICENSE 为占位说明）" />
      <Row label="诊断信息导出" desc="版本、平台、配置摘要（不含 API Key 与个人数据）">
        <Button
          variant="secondary"
          style={{ height: 28 }}
          onClick={async () => {
            const cfg = await bridge.config.get()
            const diag = {
              app: info,
              prefs: cfg.prefs,
              agents: cfg.agents.map((a) => ({ name: a.name, kind: a.kind, model: a.model, status: a.status, hasKey: a.modelConfig?.hasKey ?? false })),
              exportedAt: new Date().toISOString()
            }
            const r = await bridge.dialogs.saveFile('agenthub-diagnostics.json', JSON.stringify(diag, null, 2))
            useUi.getState().toast(r.ok ? `已导出到 ${r.message}` : '已取消', r.ok ? 'ok' : 'info')
          }}
        >
          导出诊断信息
        </Button>
      </Row>
      <div className="desc" style={{ lineHeight: 1.7 }}>
        自动更新：当前版本未实现自动更新，不声明相关支持。
        {info && <span style={{ color: 'var(--text-3)' }}>（生成于 {fmtTime(Date.now())}）</span>}
      </div>
    </div>
  )
}

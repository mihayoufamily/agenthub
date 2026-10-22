// 设置页：八分区（外观 / Agent 与模型 / Skill / 工作流 / 用量统计 / 快捷键 / 数据 / 关于）
import React, { useEffect, useState } from 'react'
import { useSettings } from '../stores/settings'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useWorkflow } from '../stores/workflow'
import type { Skill, HotkeyAction } from '@shared/types'
import { HOTKEY_DEFAULTS, HOTKEY_LABELS } from '@shared/types'
import { Icon } from '../components/Icons'
import { Switch, Button, Badge, statusText, Spinner } from '../components/primitives'
import { UsagePanel } from '../components/UsagePanel'
import { bridge } from '../lib/ipc'
import { fmtTime, fmtTokens, uid, cls, formatKeyBinding, validateKeyBinding } from '../lib/utils'

type Section = 'appearance' | 'agents' | 'skills' | 'workflow' | 'usage' | 'shortcuts' | 'data' | 'about'

const NAV: { key: Section; label: string; icon: string }[] = [
  { key: 'appearance', label: '外观', icon: 'info' },
  { key: 'agents', label: 'Agent 与模型', icon: 'file' },
  { key: 'skills', label: 'Skill', icon: 'file' },
  { key: 'workflow', label: '工作流', icon: 'reorder' },
  { key: 'usage', label: '用量统计', icon: 'file' },
  { key: 'shortcuts', label: '快捷键', icon: 'send' },
  { key: 'data', label: '数据', icon: 'folder' },
  { key: 'about', label: '关于', icon: 'info' }
]

export function SettingsPage() {
  const open = useUi((s) => s.settingsOpen)
  const close = useUi((s) => s.closeSettings)
  const jumpTo = useUi((s) => s.settingsSection)
  const [section, setSection] = useState<Section>('appearance')

  // 外部跳转（如聊天输入框 Skill 面板的"管理…"）指定分区
  useEffect(() => {
    if (open && jumpTo && (NAV.some((n) => n.key === jumpTo))) setSection(jumpTo as Section)
  }, [open, jumpTo])
  // 打开时重置为默认分区（无跳转参数时）
  useEffect(() => {
    if (open && !jumpTo) setSection('appearance')
  }, [open, jumpTo])

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
            {section === 'skills' && <SkillsSection />}
            {section === 'workflow' && <WorkflowSection />}
            {section === 'usage' && <UsageSection />}
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
            <div className="md">
              {a.model} · {statusText(a.status)}{a.modelConfig ? ` · ${a.modelConfig.baseUrl}` : ''}
              {!a.isDemo && (a.totalTokens ?? 0) > 0 && (
                <span style={{ color: 'var(--text-3)' }}>
                  {' '}· 累计 {fmtTokens(a.totalTokens!)} tokens
                  {a.cliConfig?.cli === 'codebuddy' && (
                    <span title="CodeBuddy 实际按积分（Credits）计费，消耗由模型等级/任务复杂度/上下文共同决定，官方未提供 token→积分换算公式，明细请查看 codebuddy.ai 个人主页 → 用量">
                      （积分制，明细见官网）
                    </span>
                  )}
                </span>
              )}
            </div>
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

/* ---- Skill 管理 ----
 * Skill = 可复用提示包（Markdown）：聊天输入框引用后随消息注入对话。
 * 数据存 userData/skills.json（主进程持久化）；不涉及凭据，导入导出走配置导出不含 skill。 */
function SkillsSection() {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [content, setContent] = useState('')

  const reload = () => { void bridge.skills.list().then(setSkills).catch(() => setSkills([])) }
  useEffect(reload, [])

  const openEdit = (sk: Skill | 'new') => {
    setEditing(sk)
    if (sk === 'new') { setName(''); setDesc(''); setContent('') }
    else { setName(sk.name); setDesc(sk.desc); setContent(sk.content) }
  }

  const save = async () => {
    if (!name.trim() || !content.trim()) {
      useUi.getState().toast('名称与内容不能为空', 'warn')
      return
    }
    const prev = editing && editing !== 'new' ? editing : undefined
    const r = await bridge.skills.save({
      id: prev?.id,
      name: name.trim(),
      desc: desc.trim(),
      content,
      // 编辑正文不能顺手丢掉来源目录/开关/格式（标准 skill 改一个字就退化成私有包了）
      createdAt: prev?.createdAt,
      enabled: prev?.enabled,
      dir: prev?.dir,
      files: prev?.files,
      format: prev?.format
    }).catch(() => null)
    if (r?.ok) {
      useUi.getState().toast(editing && editing !== 'new' ? 'Skill 已更新' : 'Skill 已创建', 'ok')
      setEditing(null)
      reload()
    } else {
      useUi.getState().toast(r?.message ?? '保存失败', 'error')
    }
  }

  const toggleEnabled = async (sk: Skill) => {
    const r = await bridge.skills.save({ ...sk, enabled: sk.enabled === false }).catch(() => null)
    if (r?.ok) reload()
    else useUi.getState().toast(r?.message ?? '操作失败', 'error')
  }

  const importSkillDir = async () => {
    const r = await bridge.skills.importDir().catch(() => null)
    if (r?.ok && r.skill) {
      useUi.getState().toast(`已导入标准 Skill：${r.skill.name}${r.skill.files?.length ? `（附带 ${r.skill.files.length} 个文件）` : ''}`, 'ok')
      reload()
    } else if (r && !(r.message ?? '').includes('已取消')) {
      useUi.getState().toast(r.message ?? '导入失败', 'error')
    }
  }

  const importMd = async () => {
    // 导入 .md 文件作为 Skill（文件名作为名称，全文作为内容）
    const files = await bridge.dialogs.pickFiles().catch(() => [])
    const md = files.find((f) => /\.(md|markdown|txt)$/i.test(f.name) && f.content !== undefined)
    if (!md) {
      useUi.getState().toast('请选择 .md / .txt 文件（内容需为文本）', 'warn')
      return
    }
    const r = await bridge.skills.save({
      name: md.name.replace(/\.(md|markdown|txt)$/i, ''),
      desc: `导入自 ${md.name}`,
      content: md.content!
    }).catch(() => null)
    if (r?.ok) { useUi.getState().toast(`已导入 Skill：${md.name}`, 'ok'); reload() }
    else useUi.getState().toast(r?.message ?? '导入失败', 'error')
  }

  return (
    <div className="set-group">
      <div className="group-title" style={{ display: 'flex', alignItems: 'center' }}>
        Skill 提示包（{skills?.length ?? 0}）
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Button variant="secondary" style={{ height: 28 }} onClick={() => void importSkillDir()} title="选择包含 SKILL.md 的目录（Agent Skills 开放标准）">
            <Icon name="folder" size={13} /> 导入 Skill 目录
          </Button>
          <Button variant="secondary" style={{ height: 28 }} onClick={importMd}>
            <Icon name="attach" size={13} /> 导入 .md
          </Button>
          <Button variant="primary" style={{ height: 28 }} onClick={() => openEdit('new')}>
            <Icon name="plus" size={13} /> 新建 Skill
          </Button>
        </span>
      </div>
      <div className="desc" style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, marginBottom: 8 }}>
        Skill 是一段可复用的提示词/领域知识（Markdown）。在聊天输入框点"引用 Skill"选择后，内容会随该条消息注入对话上下文（模型与 CLI 均生效）。引用记录随消息保存，可追溯。
      </div>

      {editing && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: 12, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="form-row">
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：登录页设计规范" maxLength={60} />
          </div>
          <div className="form-row">
            <label>简介（可选，列表中展示）</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话说明用途" maxLength={200} />
          </div>
          <div className="form-row">
            <label>内容（Markdown，注入对话）</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={'# 技能名称\n\n## 触发场景\n…\n\n## 执行要求\n…'}
              rows={10}
              style={{ width: '100%', fontSize: 12.5, lineHeight: 1.6, fontFamily: 'var(--font-mono, monospace)' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            <Button variant="primary" onClick={() => void save()}>保存</Button>
          </div>
        </div>
      )}

      {skills === null && <Spinner />}
      {skills?.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>还没有 Skill。点"新建 Skill"或"导入 .md"创建第一个。</div>}
      {skills?.map((sk) => {
        const on = sk.enabled !== false
        return (
          <div key={sk.id} className="agent-manage-row" style={on ? undefined : { opacity: 0.55 }}>
            <label className="skill-switch" title={on ? '已启用：可被引用，未引用时也会以一行清单告知模型' : '已禁用：不出现在引用列表，也不会被注入'}>
              <input type="checkbox" checked={on} onChange={() => void toggleEnabled(sk)} />
            </label>
            <div className="info">
              <div className="nm">
                {sk.name}
                {sk.format === 'agentskills' && <span className="skill-tag" title="来自 SKILL.md 的标准技能包">标准</span>}
              </div>
              <div className="md">
                {sk.desc || '（无简介）'} · {sk.content.length} 字 · {fmtTime(sk.updatedAt ?? sk.createdAt)}
                {sk.dir ? ` · ${sk.dir}${sk.files?.length ? `（附带 ${sk.files.length} 个文件）` : ''}` : ''}
              </div>
            </div>
            <Button variant="ghost" style={{ height: 26 }} onClick={() => openEdit(sk)}>编辑</Button>
            <Button variant="ghost" style={{ height: 26, color: 'var(--danger)' }} onClick={async () => {
              await bridge.skills.remove(sk.id).catch(() => null)
              useUi.getState().toast(`已删除 Skill：${sk.name}`, 'ok')
              reload()
            }}>删除</Button>
          </div>
        )
      })}
    </div>
  )
}

/* ---- 用量统计（按 harness × 模型；数据源是调用账本） ---- */
function UsageSection() {
  return (
    <div className="set-group">
      <div className="group-title">用量统计</div>
      <div className="desc" style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, marginBottom: 10 }}>
        按接入方（harness）与模型统计真实调用量。CLI 侧只有它自己上报 usage 时才有 token 数，
        未上报的调用会标出次数而不是估一个数；无公开单价的模型不折算金额。
      </div>
      <UsagePanel />
    </div>
  )
}

/* ---- 工作流 ---- */
function WorkflowSection() {
  const config = useWorkflow((s) => s.config)
  const patch = useWorkflow((s) => s.patchConfig)
  // 留空时展示主进程实际生效的默认目录，避免"看不到落在哪"
  const [effDir, setEffDir] = useState('')
  useEffect(() => {
    void bridge.artifacts.dir().then(setEffDir)
  }, [config.outputDir])
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
      <Row label="产物目录" desc="执行 Agent 已授权文件工具时，本次任务的工作根目录临时改为该目录（只换目录，不提升访问级别）；未授权时由 AgentHub 把成果写成文本产物">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 340 }}>
          <input
            value={config.outputDir ?? ''}
            placeholder={effDir || '文档目录/AgentHub-artifacts'}
            title={effDir || ''}
            onChange={(e) => patch({ outputDir: e.target.value })}
            style={{ flex: 1, minWidth: 0, height: 30, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', padding: '0 8px' }}
          />
          <Button variant="ghost" style={{ height: 30 }} onClick={async () => {
            const dir = await bridge.tools.pickDir()
            if (dir) patch({ outputDir: dir })
          }}>选择</Button>
        </div>
      </Row>
    </div>
  )
}

/* ---- 快捷键 ---- */
function ShortcutsSection() {
  const prefs = useSettings((s) => s.prefs)
  const patch = useSettings((s) => s.patchPrefs)
  const [recording, setRecording] = useState<HotkeyAction | null>(null)
  if (!prefs) return null
  const kb = prefs.keybindings ?? {}
  const bindingOf = (a: HotkeyAction) => kb[a] ?? HOTKEY_DEFAULTS[a]

  const onKey = (e: React.KeyboardEvent) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      return
    }
    const b = formatKeyBinding(e.nativeEvent)
    if (!b) return // 只按了修饰键：继续等主键
    const legal = validateKeyBinding(b)
    if (!legal.ok) {
      useUi.getState().toast(legal.message ?? '该键位不可用', 'warn')
      return
    }
    const all = Object.keys(HOTKEY_DEFAULTS) as HotkeyAction[]
    const clash = all.find((o) => o !== recording && bindingOf(o).toLowerCase() === b.toLowerCase())
    if (clash) {
      useUi.getState().toast(`与「${HOTKEY_LABELS[clash]}」的 ${b} 冲突，换一个组合`, 'warn')
      return
    }
    patch({ keybindings: { ...kb, [recording]: b } })
    useUi.getState().toast(`「${HOTKEY_LABELS[recording]}」已设为 ${b}`, 'ok')
    setRecording(null)
  }

  return (
    <div className="set-group">
      <Row label="Enter 发送" desc="关闭后 Enter 换行、Ctrl+Enter 发送（两种模式均受影响）">
        <Switch label="Enter 发送" on={prefs.enterToSend} onChange={(v) => patch({ enterToSend: v })} />
      </Row>
      <Row label="Shift + 滚轮切换 Agent" desc="工作站内使用；带节流、到列表边界停止、显示当前 Agent">
        <Switch label="Shift+滚轮" on={prefs.shiftWheelSwitch} onChange={(v) => patch({ shiftWheelSwitch: v })} />
      </Row>
      <div className="desc" style={{ lineHeight: 1.8, marginBottom: 6 }}>
        下面四个是窗口内全局快捷键（输入框聚焦时也生效）。点「改键」后直接按下新组合，Esc 取消；
        必须带 Ctrl/Alt/Shift 之一，不给裸键设全局键（会吃掉正常输入）。
      </div>
      <div onKeyDown={onKey}>
        {(Object.keys(HOTKEY_DEFAULTS) as HotkeyAction[]).map((a) => (
          <Row key={a} label={HOTKEY_LABELS[a]} desc={recording === a ? '请按下新的组合键…' : '窗口内全局生效'}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={cls('kbd', recording === a && 'kbd-rec')}>{recording === a ? '…' : bindingOf(a)}</span>
              <Button variant="ghost" style={{ height: 26 }} onClick={() => setRecording(recording === a ? null : a)}>
                {recording === a ? '取消' : '改键'}
              </Button>
              {(kb[a] ?? null) && (
                <Button
                  variant="ghost"
                  style={{ height: 26 }}
                  onClick={() => {
                    const next = { ...kb }
                    delete next[a]
                    patch({ keybindings: next })
                  }}
                >
                  默认
                </Button>
              )}
            </span>
          </Row>
        ))}
      </div>
      <div className="desc" style={{ lineHeight: 1.8, marginTop: 6 }}>
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
  const [autostart, setAutostart] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    bridge.autostart.get().then((on) => setAutostart(on)).catch(() => setAutostart(null))
  }, [])

  return (
    <div className="set-group">
      <Row label="应用版本" desc={info?.version} />
      <Row label="Electron / Chromium / Node" desc={`${info?.electron} / ${info?.chrome} / ${info?.node}`} />
      <Row label="平台" desc={info?.platform} />
      <Row label="检查更新" desc="比对 GitHub Releases 最新版本；发现新版会在界面顶部显示提示横幅">
        <Button
          variant="secondary"
          style={{ height: 28 }}
          loading={checking}
          onClick={async () => {
            setChecking(true)
            const r = await bridge.update.check(true).catch(() => null)
            setChecking(false)
            if (!r) { useUi.getState().toast('检查更新失败：无法连接更新服务', 'error'); return }
            if (r.error) { useUi.getState().toast(`检查更新失败：${r.error}`, 'error'); return }
            if (r.hasUpdate && r.latest && r.releaseUrl) {
              useUi.getState().setUpdateBanner({ version: r.latest, url: r.releaseUrl })
              useUi.getState().toast(`发现新版本 ${r.latest}，点击顶部横幅前往下载`, 'ok')
            } else {
              useUi.getState().toast(`已是最新版本（${r.current}）`, 'ok')
            }
          }}
        >
          检查更新
        </Button>
      </Row>
      <Row label="开机自启" desc="登录 Windows 后自动启动 AgentHub">
        {autostart === null ? (
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>读取中…</span>
        ) : (
          <Switch
            label="自启"
            on={autostart}
            onChange={async (v) => {
              const applied = await bridge.autostart.set(v).catch(() => null)
              if (applied === null) {
                useUi.getState().toast('设置开机自启失败（注册表写入被拒）', 'error')
                return
              }
              setAutostart(applied)
              useUi.getState().toast(applied ? '已开启开机自启' : '已关闭开机自启', 'ok')
            }}
          />
        )}
      </Row>
      <Row label="开源仓库与许可证" desc="MIT · https://github.com/mihayoufamily/agenthub" />
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
        更新方式：手动下载——应用只检查并提示新版本，不自动下载或安装；启动时亦会静默检查（3 天一次，失败不打扰）。
        {info && <span style={{ color: 'var(--text-3)' }}>（生成于 {fmtTime(Date.now())}）</span>}
      </div>
    </div>
  )
}

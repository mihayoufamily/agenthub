// 设置页：十一分区（外观 / Agent 与模型 / Skill / 工作流 / 用量统计 / 命令审批 / 工具 Hook / MCP / 快捷键 / 数据 / 关于）
import React, { useEffect, useState } from 'react'
import { useSettings } from '../stores/settings'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { useWorkflow } from '../stores/workflow'
import type { Skill, HotkeyAction, ApprovalRecord, HookRule, McpServer, McpProbe } from '@shared/types'
import { validateHook, HOOK_COMMAND_MAX_LENGTH } from '@shared/hooks'
import { cmdUnsafeReason, toLaunchPlan } from '@shared/argv'
import { fingerprintCommand, redactCommandForDisplay } from '@shared/approvals'
import { compatBadgeText, SANDBOX_FALLBACK_OPTIONS } from '@shared/compat'
import type { CompatState, SandboxFallbackPolicy } from '@shared/compat'
import { HOTKEY_DEFAULTS, HOTKEY_LABELS } from '@shared/types'
import { Icon } from '../components/Icons'
import { Switch, Button, Badge, statusText, Spinner } from '../components/primitives'
import { UsagePanel } from '../components/UsagePanel'
import { bridge } from '../lib/ipc'
import { fmtTime, fmtTokens, uid, cls, formatKeyBinding, validateKeyBinding } from '../lib/utils'

type Section = 'appearance' | 'agents' | 'skills' | 'workflow' | 'usage' | 'approvals' | 'hooks' | 'mcp' | 'shortcuts' | 'data' | 'about'

const NAV: { key: Section; label: string; icon: string }[] = [
  { key: 'appearance', label: '外观', icon: 'info' },
  { key: 'agents', label: 'Agent 与模型', icon: 'file' },
  { key: 'skills', label: 'Skill', icon: 'file' },
  { key: 'workflow', label: '工作流', icon: 'reorder' },
  { key: 'usage', label: '用量统计', icon: 'file' },
  { key: 'approvals', label: '命令审批', icon: 'shield' },
  { key: 'hooks', label: '工具 Hook', icon: 'terminal' },
  { key: 'mcp', label: 'MCP', icon: 'swap' },
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
            {section === 'approvals' && <ApprovalSection />}
            {section === 'hooks' && <HookSection />}
            {section === 'mcp' && <McpSection />}
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

/* ---- 命令审批：白名单一览 + 审批历史 ---- */
const DECISION_TEXT: Record<string, string> = { once: '本次允许', always: '始终允许', deny: '拒绝' }

function ApprovalSection() {
  const agents = useAgents((s) => s.agents)
  const [rules, setRules] = useState<Record<string, string[]>>({})
  const [records, setRecords] = useState<ApprovalRecord[]>([])
  const load = () => {
    void bridge.approval.allRules().then(setRules)
    void bridge.approval.history(200).then(setRecords)
  }
  useEffect(load, [])
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id

  return (
    <div className="set-group" data-testid="approval-settings">
      <div className="group-title">命令审批</div>
      <div className="desc" style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, marginBottom: 10 }}>
        模型 Agent 执行命令时逐条确认，点「始终允许」的规则落在各 Agent 的白名单里（可在 Agent 的工具面板增删）。
        危险形态（rm -rf、format、curl | sh 等）白名单覆盖不了，永远要确认。
        CLI Agent 的命令审批由它自己的 CLI 负责，AgentHub 不替它做决定。
      </div>

      <div className="group-title" style={{ marginTop: 6 }}>白名单</div>
      {Object.keys(rules).length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>（还没有任何规则）</div>
      )}
      {Object.entries(rules)
        .filter(([, list]) => list.length)
        .map(([id, list]) => (
          <div key={id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{nameOf(id)}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {list.map((r) => (
                <code key={r} style={{ fontSize: 11.5, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 999 }}>
                  {r}
                </code>
              ))}
            </div>
          </div>
        ))}

      <div className="group-title" style={{ marginTop: 12 }}>
        审批历史
        <Button variant="ghost" onClick={load} style={{ marginLeft: 8 }}>刷新</Button>
        <Button
          variant="ghost"
          onClick={() => {
            void bridge.approval.clearHistory().then(load)
            useUi.getState().toast('审批历史已清空', 'ok')
          }}
        >
          清空
        </Button>
      </div>
      {records.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>（还没有审批记录：开了命令审批后，每次确认都会留在这里）</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
          {records.map((r) => (
            <div key={r.id} data-approval-record style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                <b
                  style={{
                    color: r.decision === 'deny' ? 'var(--danger)' : r.decision === 'always' ? 'var(--ok, #16a34a)' : 'var(--text-2)'
                  }}
                >
                  {DECISION_TEXT[r.decision] ?? r.decision}
                </b>
                <span style={{ color: 'var(--text-3)' }}>{fmtTime(r.ts)}</span>
                {r.agentName && <span style={{ color: 'var(--text-3)' }}>· {r.agentName}</span>}
              </div>
              <code style={{ display: 'block', fontSize: 12, wordBreak: 'break-all', margin: '4px 0' }}>{r.command}</code>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                {r.reason}
                {r.rule ? ` → 写入白名单：${r.rule}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---- 工具 Hook：在工具调用前后跑你自己配的命令 ---- */
const EMPTY_RULE: HookRule = { id: '', event: 'post', command: '', match: '', enabled: true }

function HookSection() {
  const [rules, setRules] = useState<HookRule[]>([])
  const [draft, setDraft] = useState<HookRule>(EMPTY_RULE)
  const [err, setErr] = useState('')

  const load = () => {
    void bridge.hooks.list().then(setRules)
  }
  useEffect(load, [])

  const save = async (next: HookRule[]) => {
    const r = await bridge.hooks.set(next)
    setRules(r.list)
    return r
  }

  const patch = (id: string, p: Partial<HookRule>) => {
    void save(rules.map((h) => (h.id === id ? { ...h, ...p } : h)))
  }

  const add = async () => {
    const v = validateHook(draft)
    if (!v.ok) {
      setErr(v.message ?? 'Hook 不合法')
      return
    }
    setErr('')
    await save([...rules, { ...draft, id: uid('hook'), createdAt: Date.now(), enabled: true }])
    setDraft(EMPTY_RULE)
    useUi.getState().toast('Hook 已添加（下一次工具调用起生效）', 'ok')
  }

  return (
    <div className="set-group" data-testid="hook-settings">
      <div className="group-title">工具 Hook</div>
      <div className="desc" style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, marginBottom: 10 }}>
        在模型 Agent 的工具调用前后执行你配置的命令。<b>pre</b> 退出码非 0 = 否决这次调用（脚本的 stdout/stderr 会原样回传给模型）；
        <b>post</b> 只观察与后处理（跑格式化、跑测试、记流水），失败不会撤销已经发生的改动，但会如实报告。
        <br />
        数据只通过环境变量传入（<code>AHUB_HOOK_TOOL</code> / <code>_ARGS</code> / <code>_RESULT</code> / <code>_FILE</code> / <code>_DIR</code>，
        以及 <code>AHUB_AGENT_NAME</code> / <code>AHUB_RUN_ID</code>）——不把这些拼进命令串，免得模型给的参数变成可执行内容。
        工作目录固定为该 Agent 的沙箱根，超时默认 15 秒、输出有上限。命令最长 {HOOK_COMMAND_MAX_LENGTH} 个字符——超长不予保存（新增时这里会直接把原因显示出来），也不会在背后替你截断。
        <br />
        <b style={{ color: 'var(--danger)' }}>风险：</b>配了 Hook 就是让 AgentHub 在每次工具调用时代你执行这些命令，
        与命令审批不同，Hook 不再逐条问你。只写你自己完全信任的脚本。CLI Agent 不经过这一层。
        指纹按归一化（折叠多余空白、转小写）后的命令原文计算：改任意一个字符（大小写与多余空白的写法除外——那几种会被归一化，指纹不变）指纹就会变，哪怕改动落在显示里被遮成 *** 的凭据值上；它只用于肉眼确认「这条命令是不是我原来那条」，不参与任何放行判定。
      </div>

      {rules.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>（还没有 Hook）</div>}
      {rules.map((h) => (
        <div key={h.id} data-hook-row style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <Switch on={h.enabled !== false} onChange={(v) => patch(h.id, { enabled: v })} label={`启用 Hook ${h.id}`} />
            <select
              value={h.event}
              onChange={(e) => patch(h.id, { event: e.target.value as 'pre' | 'post' })}
              style={{ height: 28, font: 'inherit', fontSize: 12.5 }}
            >
              <option value="pre">pre（执行前，可否决）</option>
              <option value="post">post（执行后）</option>
            </select>
            <input
              placeholder="匹配工具的正则（留空=全部），如 write_file|replace_in_file"
              value={h.match ?? ''}
              onChange={(e) => patch(h.id, { match: e.target.value })}
              style={{ flex: 1, minWidth: 120, height: 28, font: 'inherit', fontSize: 12.5 }}
            />
            <Button variant="ghost" onClick={() => void save(rules.filter((x) => x.id !== h.id))}>删除</Button>
          </div>
          <input
            value={h.command}
            onChange={(e) => patch(h.id, { command: e.target.value })}
            placeholder='node -e "console.log(process.env.AHUB_HOOK_FILE)"'
            style={{ width: '100%', boxSizing: 'border-box', height: 28, font: 'inherit', fontSize: 12.5 }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3, wordBreak: 'break-all' }} data-testid="hook-fingerprint">
            {redactCommandForDisplay(h.command)}
            <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono, monospace)' }}>#{fingerprintCommand(h.command)}</span>
          </div>
        </div>
      ))}

      <div className="group-title" style={{ marginTop: 12 }}>新增一条</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <select
          value={draft.event}
          onChange={(e) => setDraft({ ...draft, event: e.target.value as 'pre' | 'post' })}
          style={{ height: 28, font: 'inherit', fontSize: 12.5 }}
        >
          <option value="pre">pre</option>
          <option value="post">post</option>
        </select>
        <input
          placeholder="匹配正则（可留空）"
          value={draft.match ?? ''}
          onChange={(e) => setDraft({ ...draft, match: e.target.value })}
          style={{ flex: 1, minWidth: 0, height: 28, font: 'inherit', fontSize: 12.5 }}
          data-testid="hook-match"
        />
        <input
          placeholder="超时毫秒（默认 15000）"
          value={draft.timeoutMs ?? ''}
          onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
          style={{ width: 130, height: 28, font: 'inherit', fontSize: 12.5 }}
          inputMode="numeric"
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          placeholder="要执行的命令（工作目录=沙箱根）"
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          style={{ flex: 1, height: 28, font: 'inherit', fontSize: 12.5 }}
          data-testid="hook-command"
        />
        <Button variant="primary" onClick={() => void add()}>添加</Button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }} data-hook-err>{err}</div>}
    </div>
  )
}

/* ---- MCP server（tools-only + stdio） ---- */
const EMPTY_MCP = { name: '', command: '' }

/**
 * comspec 分支保存前预检：与主进程 planSpawn 用的是同一个 cmdUnsafeReason（argv.ts 只此一份）。
 * argv 直传那条路不经 cmd，没有这个限制，所以只在 comspec 计划上检查。
 */
function comspecUnsafe(plan: { file: string; args: string[]; comspec: boolean }): { token: string; reason: string }[] {
  if (!plan.comspec) return []
  const out: { token: string; reason: string }[] = []
  for (const t of [plan.file, ...plan.args]) {
    const reason = cmdUnsafeReason(t)
    if (reason) out.push({ token: t, reason })
  }
  return out
}

function McpSection() {
  const [list, setList] = useState<McpServer[]>([])
  const [trusted, setTrusted] = useState<string[]>([])
  const [draft, setDraft] = useState(EMPTY_MCP)
  const [probes, setProbes] = useState<Record<string, McpProbe>>({})
  const [busy, setBusy] = useState('')
  // 「重填」的目标旧条目（null=没有在重填）。见 refill 的注释：移除推迟到保存那一刻。
  const [refillTarget, setRefillTarget] = useState<McpServer | null>(null)

  const load = () => {
    void bridge.mcp.list().then(setList)
    void bridge.mcp.trusted().then(setTrusted)
  }
  useEffect(load, [])

  const save = async (next: McpServer[]) => {
    const r = await bridge.mcp.set(next)
    setList(r.list)
    return r.list
  }

  const patch = (id: string, p: Partial<McpServer>) => {
    void save(list.map((s) => (s.id === id ? { ...s, ...p } : s)))
  }

  /**
   * 「重填」第一步（评审修复1）：把原文塞回草稿，旧条目**留在列表里**（仍失效+停用）。
   * 不能在点击时就 save(list.filter(...))：McpSection 是条件挂载的，切分区/关设置都会重挂，
   * 草稿随组件 state 蒸发，而删除已写进 config.json、mcp:set 还顺带撤销了该 id 的信任——
   * 记录不可恢复，违反"标失效+停用、绝不删除"的既定决策。真正的移除发生在保存新记录那一刻（add）。
   * 草稿丢了（重挂）不要紧：旧条目还在，再点一次「重填」即可。
   */
  const refill = (s: McpServer) => {
    setDraft({ name: s.name, command: s.command })
    setRefillTarget(s)
  }

  const add = async () => {
    const plan = toLaunchPlan(draft.command)
    if (!draft.name.trim() || !plan) {
      useUi.getState().toast('名称与启动命令都要填', 'warn')
      return
    }
    const unsafe = comspecUnsafe(plan)
    if (unsafe.length > 0) {
      // 表单里已经染红写明了（mcp-cmd-unsafe），这里再挡一次保存：不能让"看着存上了其实起不来"过关
      useUi.getState().toast(`该参数经 cmd 无法安全表示，已拦下：${unsafe[0].token}`, 'warn')
      return
    }
    // 重填保存：旧条目此刻才被新记录顶掉（remove-and-refill 的形状不变，只是移除推迟到这一笔保存里）
    const replacing = refillTarget && list.some((x) => x.id === refillTarget.id) ? refillTarget : null
    const rest = replacing ? list.filter((x) => x.id !== replacing.id) : list
    const next = await save([...rest, {
      id: uid('mcp'),
      name: draft.name.trim().slice(0, 40),
      command: draft.command.trim(),
      launch: { bin: plan.file, args: plan.args },
      formatVersion: 2 as const,
      enabled: true,
      createdAt: Date.now()
    }])
    setDraft(EMPTY_MCP)
    setRefillTarget(null)
    if (replacing) {
      useUi.getState().toast(`已用新记录顶掉旧条目「${replacing.name}」：旧记录与它的信任授权一起移除`, 'info')
    }
    // 加完就探一次：列不到工具的话，第一次真正调用时会连不上，早知道比晚知道好
    const first = next[next.length - 1]
    if (first) void probe(first)
  }

  const probe = async (s: McpServer) => {
    setBusy(s.id)
    const r = await bridge.mcp.probe(s)
    setProbes((p) => ({ ...p, [s.id]: r }))
    setBusy('')
  }

  const usedBy = (id: string) => useAgents.getState().agents.filter((a) => a.tools?.mcpServerIds?.includes(id)).map((a) => a.name)

  return (
    <div className="set-group" data-testid="mcp-settings">
      <div className="group-title">MCP server</div>
      <div className="desc" style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, marginBottom: 10 }}>
        只接 <b>tools</b>：把外部 MCP server 的工具并进模型可调用的清单，不接它的 prompts/resources，也不让它往上下文里塞系统提示。
        第一版<b>只支持 stdio</b>（本机拉起一条命令，换行分隔的 JSON-RPC）；远程 HTTP/SSE 没做。
        <br />
        <b style={{ color: 'var(--danger)' }}>风险：</b>MCP server 就是本机任意代码执行，它的工具以那条命令的权限运行。
        首次连接会弹窗要你确认；点「始终信任」后这个 server 的工具整组放行（下面可撤销）。
        哪些 Agent 能用，在各自「文件/命令工具」面板里勾选，没勾的看不到。
      </div>

      {list.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>（还没配 MCP server）</div>}
      {list.map((s) => {
        const p = probes[s.id]
        const users = usedBy(s.id)
        return (
          <div key={s.id} data-mcp-row style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Switch on={s.enabled !== false} onChange={(v) => patch(s.id, { enabled: v })} label={`启用 ${s.name}`} />
              <b style={{ fontSize: 13 }}>{s.name}</b>
              <Badge tone={trusted.includes(s.id) ? 'ok' : 'warn'}>{trusted.includes(s.id) ? '已信任' : '未信任（首次连接要确认）'}</Badge>
              {users.length > 0 && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>被 {users.join('、')} 勾选</span>}
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => void probe(s)} disabled={busy === s.id}>{busy === s.id ? '连接中…' : '连接并查看工具'}</Button>
              {trusted.includes(s.id) && (
                <Button variant="ghost" onClick={() => void bridge.mcp.setTrust(s.id, false).then((r) => setTrusted(r.list))}>撤销信任</Button>
              )}
              <Button variant="ghost" onClick={() => void save(list.filter((x) => x.id !== s.id))}>删除</Button>
            </div>
            <code style={{ display: 'block', fontSize: 11.5, marginTop: 4, wordBreak: 'break-all', color: s.legacyInvalid ? 'var(--text-3)' : 'var(--text-2)' }}>
              {s.launch ? `${s.launch.bin} ${s.launch.args.join(' ')}`.trim() : s.command}
            </code>
            {s.legacyInvalid && (
              <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }} data-testid="mcp-legacy">
                旧版单命令配置，已停用。v0.4.0 不再把整条命令交 shell 解析，请重填后保存。
              </div>
            )}
            {s.legacyInvalid && (
              <Button variant="ghost" style={{ marginTop: 4 }} data-testid="mcp-refill" onClick={() => refill(s)}>
                重填
              </Button>
            )}
            {p && (
              <div style={{ marginTop: 4, fontSize: 11.5, color: p.ok ? 'var(--text-3)' : 'var(--danger)' }} data-mcp-probe={s.id}>
                {p.message}
                {p.ok && !!p.tools?.length && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {p.tools.map((t) => (
                      <code key={t.name} title={t.description} style={{ fontSize: 11, padding: '1px 6px', border: '1px solid var(--border)', borderRadius: 999 }}>
                        {t.name}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div className="group-title" style={{ marginTop: 12 }}>新增一个</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input placeholder="名称" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ width: 140, height: 28, font: 'inherit', fontSize: 12.5 }} data-testid="mcp-name" />
        <input placeholder='启动命令，例如 node "C:\path\to\server.js" 或 npx -y @some/mcp-server' value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} style={{ flex: 1, height: 28, font: 'inherit', fontSize: 12.5 }} data-testid="mcp-command" />
        <Button variant="primary" onClick={() => void add()}>添加并探测</Button>
      </div>
      {refillTarget && list.some((x) => x.id === refillTarget.id) && (
        <div style={{ fontSize: 11.5, color: 'var(--warn)', marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }} data-testid="mcp-refill-note">
          <span>
            正在重填「{refillTarget.name}」：原命令已填回上面的表单，旧条目暂时留在列表里（失效+停用）。
            保存后新记录会顶掉它——旧记录和它的信任授权一起删除；不保存就一切照旧。
          </span>
          <Button variant="ghost" style={{ height: 24, flexShrink: 0 }} data-testid="mcp-refill-cancel" onClick={() => setRefillTarget(null)}>
            取消重填
          </Button>
        </div>
      )}
      {(() => {
        const p = toLaunchPlan(draft.command)
        if (!p) return <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>填一条启动命令，下面会实时显示实际会执行的 argv。</div>
        const unsafe = comspecUnsafe(p)
        return (
          <div style={{ fontSize: 11.5, color: unsafe.length ? 'var(--danger)' : p.comspec ? 'var(--warn)' : 'var(--text-3)', marginTop: 4 }} data-testid="mcp-argv-preview">
            实际执行：<code style={{ wordBreak: 'break-all' }}>{JSON.stringify([p.file, ...p.args])}</code>
            {p.comspec && <div data-testid="mcp-via-shell">可执行文件是 .cmd/.bat 或 npx/npm 这类启动器，只能经 cmd 包一层启动（不是 argv 直传）。</div>}
            {unsafe.length > 0 && (
              <div data-testid="mcp-cmd-unsafe">
                {unsafe.map((u, i) => (
                  <div key={i}>参数 <code style={{ wordBreak: 'break-all' }}>{u.token}</code> 保存不了：{u.reason}</div>
                ))}
                改掉它再保存；这一限制只在经 cmd 包一层的启动方式上，argv 直传（node 之类）不受影响。
              </div>
            )}
          </div>
        )
      })()}
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
  // 兼容模式（A4）：状态从主进程读（app:compat 只报事实），策略写回走 config 那条既有路径
  const [compat, setCompat] = useState<CompatState | null>(null)
  // 读取失败与"还没读到"要分开：混成一个 null 时三态选择器会永久卡在「读取中…」、连入口都没了（评审一行项）
  const [compatError, setCompatError] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState<SandboxFallbackPolicy | null>(null)
  const reloadCompat = () => {
    setCompatError(false)
    void bridge.app.compat()
      .then((s) => { setCompat(s); setCompatError(false) })
      .catch(() => { setCompat(null); setCompatError(true) })
  }

  useEffect(() => {
    bridge.autostart.get().then((on) => setAutostart(on)).catch(() => setAutostart(null))
    reloadCompat()
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
      <Row
        label="兼容模式状态"
        desc={compat === null
          ? compatError
            ? '读取主进程状态失败（通道或本机读取异常）。这里仍不猜状态；用下方「重试」再读一次。'
            : '读取中……读不到主进程状态时这里不猜（宁可空着，也不写"沙箱正常"）'
          : compatBadgeText(compat) === null
            ? '本机没有降级：Chromium 沙箱与硬件加速都按默认方式运行。'
            : `${compatBadgeText(compat)}（原因：${compat.reason || '未知'}）。这是本机现在的真实状态，不是配置里写了什么。`}
      />
      <Row
        label="降级策略"
        desc="渲染进程在窗口出现前崩溃时，要不要自动降级重启。策略覆盖整条阶梯：「不自动降级」= 不做任何自动重启（含 GPU 软件渲染兜底）。改完自下一次降级起生效（本次运行不变）。"
      >
        {compat === null ? (
          compatError ? (
            <Button variant="secondary" style={{ height: 28 }} data-testid="compat-retry" onClick={reloadCompat}>
              重试读取
            </Button>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>读取中…</span>
          )
        ) : (
          <div className="seg" role="radiogroup" aria-label="降级策略">
            {SANDBOX_FALLBACK_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={o.value === compat.policy}
                data-testid="sandbox-fallback-option"
                data-policy={o.value}
                className={o.value === compat.policy ? 'active' : ''}
                disabled={savingPolicy !== null}
                title={o.desc}
                onClick={async () => {
                  if (o.value === compat.policy) return
                  setSavingPolicy(o.value)
                  const r = await bridge.config.setSandboxFallback(o.value).catch(() => null)
                  setSavingPolicy(null)
                  if (!r) {
                    // 不武断归因："没拿到回应"既可能是主进程通道异常，也可能是本地写盘失败——
                    // 如实说"未确认生效"，并回读一次让界面跟着主进程的事实走
                    useUi.getState().toast('保存降级策略失败：未确认写入（本地写盘或主进程通道都可能失败），当前值以主进程回读为准', 'error')
                    reloadCompat()
                    return
                  }
                  if (!r.ok) { useUi.getState().toast(r.message ?? '保存降级策略失败（未写入）', 'error'); return }
                  reloadCompat()
                  useUi.getState().toast(`降级策略已设为「${o.label}」，自下一次降级起生效`, 'ok')
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </Row>
      {compat && (
        <div className="desc" style={{ display: 'flex', flexDirection: 'column', gap: 4, lineHeight: 1.65 }}>
          {SANDBOX_FALLBACK_OPTIONS.map((o) => (
            <div
              key={o.value}
              data-testid="sandbox-fallback-desc"
              data-active={o.value === compat.policy ? '1' : '0'}
              style={o.value === compat.policy ? { color: 'var(--text)' } : undefined}
            >
              <strong>{o.label}</strong>：{o.desc}
            </div>
          ))}
        </div>
      )}
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

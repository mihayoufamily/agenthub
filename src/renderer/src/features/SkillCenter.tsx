// 技能中心：已安装 / 官方内置 / 技能市场 三栏弹窗。
// 与设置页 Skill 分区的分工：设置页管"编辑与增删"，这里管"发现与安装"；
// 两边读的都是 skills:list 这一份后端数据，装完各自 reload 即自动同步，
// 不引入新的全局 store（stores 本批次禁改，且 settings store 里本就没有 skills 状态）。
import React, { useCallback, useEffect, useState } from 'react'
import type { Skill } from '@shared/types'
import { skillUsages, SKILL_TIMING_NOTE, SKILL_TIMING_NOTE_WF, SKILL_SOURCE_LABELS } from '@shared/skill-usages'
import { bridge, market, type RegistryItem } from '../lib/ipc'
import { useUi } from '../stores/ui'
import { useAgents } from '../stores/agents'
import { useWorkflow } from '../stores/workflow'
import { Modal } from '../components/Modal'
import { Button, Badge, Switch } from '../components/primitives'
import { cls, fmtSize, fmtTime } from '../lib/utils'

/* 生效范围行里 mode 的短文案（面板空间小，用短版；完整解释在 shared 的 SKILL_MODE_HINTS） */
const MODE_TEXT: Record<'auto' | 'reference', string> = { auto: '自动注入全文', reference: '仅引用清单' }

/**
 * 生效范围面板：每个技能条目下方一块，"生效于谁 + 矛盾态点名"。
 * 事实计算在 shared/skill-usages.ts（逻辑层断言钉着），这里只做展示与矛盾态判定。
 * 数据源在组件内订阅两个 store（agents / workflow.config）：在 Agent 管理卡或工作流设置里
 * 改了绑定，切回技能中心/设置页立刻反映，不需要各自调用方再传一次。
 * SkillCenter 与设置页 SkillsSection 同一份渲染（导出共用，不复制第二份）。
 */
export function SkillUsagePanel({ skill }: { skill: Skill }) {
  const agents = useAgents((s) => s.agents)
  const config = useWorkflow((s) => s.config)
  const usages = skillUsages(skill.id, { agents, roles: config })
  const enabled = skill.enabled !== false
  const places = usages.map((u) => u.place).join('、')
  return (
    <div className="skill-usage-panel">
      {/* 矛盾态点名，二者只居其一、优先红：绑定还在但技能停用了，最怕的是用户以为还在注入 */}
      {!enabled && usages.length > 0 ? (
        <div className="skill-usage-conflict-danger">已绑定但停用中，不会被注入（绑定处：{places}）</div>
      ) : enabled && usages.length === 0 ? (
        <div className="skill-usage-conflict-warn">已启用，但当前没有任何地方使用它——去 Agent 管理卡绑定，或在输入框引用</div>
      ) : usages.length > 0 ? (
        <div className="skill-usage-line">
          生效于：
          {usages.map((u, i) => (
            <span key={`${u.kind}:${u.place}`} className="skill-usage-place">
              {i > 0 && '｜'}
              {u.place}
              {u.mode ? `（${MODE_TEXT[u.mode]}）` : ''}
            </span>
          ))}
        </div>
      ) : null}
      {/* 时机一句话不再放在面板里：分区说明（设置页）/列表顶部（技能中心）各说一次就够，
          此前面板每张卡带一句、3 张卡 = 4 次重复（2026-10-25 UI 审查） */}
    </div>
  )
}

type TabKey = 'installed' | 'builtin' | 'market' | 'wf'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'installed', label: '已安装' },
  { key: 'builtin', label: '官方内置' },
  { key: 'market', label: '技能市场' },
  { key: 'wf', label: '工作流绑定' }
]

// 来源标签在 shared（Agent 管理卡的技能徽章与这里共用一份，不许各写一份）

/** 语义化版本逐段比较：非数字段按 0 处理（够用于"官方发的 v1.2.3"这种口径） */
function verCmp(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const WF_ROLES = ['planner', 'executor', 'reviewer'] as const
const WF_ROLE_LABEL: Record<(typeof WF_ROLES)[number], string> = { planner: '规划', executor: '执行', reviewer: '审核' }

/**
 * 「工作流绑定」矩阵：行 = 已安装技能，列 = 工作流三角色，格子 = 角色级绑定勾选。
 * 写路径与 ConfigPanel.roleSelect / RolePicker 浮层逐字同源：
 * patchConfig({ [role]: { ...cur, skillIds } })（store 内部落盘 setWorkflowDefaults 的 skillIds 三件套）。
 * 停用技能照 AgentManageCard 的交互（⚠ 已停用 + 勾选禁用）：绑了也不会被注入，不能放行勾选。
 */
function WfBindingTab({ skills }: { skills: Skill[] | null }) {
  const config = useWorkflow((s) => s.config)
  const patchConfig = useWorkflow((s) => s.patchConfig)
  const toggle = (role: (typeof WF_ROLES)[number], sk: Skill, checked: boolean) => {
    const cur = config[role]
    patchConfig({
      [role]: { ...cur, skillIds: checked ? [...(cur.skillIds ?? []), sk.id] : (cur.skillIds ?? []).filter((x) => x !== sk.id) }
    } as never)
    // 即时反馈按既有 toggle 的 toast 风格，并把"何时生效"说在同一个句子里
    useUi.getState().toast(`已更新「${sk.name}」在工作流${WF_ROLE_LABEL[role]}的绑定（下一次「开始任务」生效）`, 'ok')
  }
  return (
    <div>
      {skills === null && <div className="skill-center-empty">加载中…</div>}
      {skills !== null && skills.length === 0 && (
        <div className="skill-center-empty">还没有安装任何技能；先去「已安装 / 官方内置 / 技能市场」装一个</div>
      )}
      {skills !== null && skills.length > 0 && (
        <div className="wf-skill-matrix" data-wf-skill-matrix>
          <div className="wf-skill-matrix-head">
            <div className="wf-skill-matrix-name">技能</div>
            {WF_ROLES.map((r) => (
              <div key={r} className="wf-skill-matrix-col">
                {WF_ROLE_LABEL[r]}
                <span className="wf-skill-count">{(config[r].skillIds ?? []).length}</span>
              </div>
            ))}
          </div>
          {skills.map((sk) => {
            const src = sk.source ?? 'local'
            const off = sk.enabled === false
            return (
              <div key={sk.id} className={cls('wf-skill-matrix-row', off && 'off')} style={off ? { opacity: 0.55 } : undefined}>
                <div className="wf-skill-matrix-name">
                  <span className="ac-skill-name">{sk.name}</span>
                  <span className={cls('skill-src-badge', `src-${src}`)}>{SKILL_SOURCE_LABELS[src] ?? src}</span>
                  {sk.version && <span className="wf-skill-ver">v{sk.version}</span>}
                  {off && <span className="ac-skill-off" title="该技能已停用，绑定也不会生效">⚠ 已停用</span>}
                </div>
                {WF_ROLES.map((r) => {
                  const on = (config[r].skillIds ?? []).includes(sk.id)
                  return (
                    <div key={r} className="wf-skill-matrix-cell">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={off}
                        title={off ? '该技能已停用，绑定也不会生效' : `绑定到${WF_ROLE_LABEL[r]}角色`}
                        onChange={(e) => toggle(r, sk, e.target.checked)}
                      />
                    </div>
                  )
                })}
              </div>
            )
          })}
          {/* Agent 级绑定（工作站 Agent 管理卡）是另一条注入来源，矩阵只管角色级这一层 */}
          <div className="wf-skill-matrix-note">
            这里只管<b>角色级</b>绑定；Agent 自身的技能绑定在工作站 Agent 管理卡配置，两边会合并注入。
          </div>
          <div className="skill-usage-note skill-usage-note-inline">{SKILL_TIMING_NOTE_WF}</div>
        </div>
      )}
    </div>
  )
}

type PreviewTarget =
  | { kind: 'installed'; skill: Skill }
  | { kind: 'builtin'; skill: Skill }
  | { kind: 'market'; item: RegistryItem }

export function SkillCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('installed')
  // 已安装：与设置页 SkillsSection 同一通道（skills:list），装完/开关后 reload
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [builtin, setBuiltin] = useState<Skill[] | null>(null)
  const [builtinErr, setBuiltinErr] = useState<string | null>(null)
  const [reg, setReg] = useState<{ items: RegistryItem[]; fromCache: boolean } | null>(null)
  const [regErr, setRegErr] = useState<string | null>(null)
  const [regAt, setRegAt] = useState(0)
  /** 正在安装的技能 id：按钮态"安装中…"要精确到卡片，不能整面板一起转圈 */
  const [installing, setInstalling] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewTarget | null>(null)

  const loadInstalled = useCallback(() => {
    void bridge.skills.list().then(setSkills).catch(() => setSkills([]))
  }, [])

  const loadBuiltin = useCallback(() => {
    setBuiltinErr(null)
    setBuiltin(null)
    // 契约：失败以 ok=false + message 如实回传（不抛桥异常），这里照原文亮出
    void bridge.market
      .builtin()
      .then((r) => {
        if (r.ok) setBuiltin(r.skills ?? [])
        else setBuiltinErr(r.message ?? '内置技能列表读取失败')
      })
      .catch((e) => setBuiltinErr((e as Error).message || '内置技能列表读取失败'))
  }, [])

  const loadRegistry = useCallback(() => {
    setRegErr(null)
    setReg(null)
    void bridge.market
      .registry()
      .then((r) => {
        setRegAt(Date.now())
        if (r.ok) setReg({ items: r.items ?? [], fromCache: !!r.fromCache })
        else setRegErr(r.error ?? '注册表拉取失败')
      })
      .catch((e) => setRegErr((e as Error).message || '注册表拉取失败'))
  }, [])

  // 打开时三栏并行拉齐；预览的二级弹窗不在这里关（它有自己的 Esc/遮罩路径）
  useEffect(() => {
    if (!open) return
    setTab('installed')
    setPreview(null)
    loadInstalled()
    loadBuiltin()
    loadRegistry()
  }, [open, loadInstalled, loadBuiltin, loadRegistry])

  // 开关口径与设置页 SkillsSection.toggleEnabled 完全一致：
  // save 整条记录只翻 enabled，成功后 reload 拉回落盘结果（不做本地乐观改写）
  const toggleEnabled = async (sk: Skill) => {
    const r = await bridge.skills.save({ ...sk, enabled: sk.enabled === false }).catch(() => null)
    if (r?.ok) loadInstalled()
    else useUi.getState().toast(r?.message ?? '操作失败', 'error')
  }

  /**
   * 安装分流（以落地的主进程契约为准）：
   * - 市场/更新：market:install，只传条目 id，url/哈希由主进程以它刚拉到的注册表为准；
   * - 内置：主进程没有 builtin 安装通道（market:install 只受理注册表条目），"安装"=
   *   走 skills:save 把只读目录里的条目落盘一份拷贝，id 保持 `builtin-<目录名>`——
   *   与"已安装"判定（skills:list 里能按同 id 找到）天然对得上，更新应用后重装即覆盖。
   */
  const install = async (target: { kind: 'builtin'; skill: Skill } | { kind: 'market'; id: string; name: string }) => {
    const id = target.kind === 'builtin' ? target.skill.id : target.id
    setInstalling(id)
    const r =
      target.kind === 'builtin'
        ? await bridge.skills.save({ ...target.skill, enabled: true }).catch(() => null)
        : await market.install(target.id).catch(() => null)
    setInstalling(null)
    if (r?.ok) {
      // 回执 message 由主进程写（市场安装含"默认启用、脚本只登记不执行"等事实），界面只转发不加工
      useUi.getState().toast(r.message ?? `已安装：${target.kind === 'builtin' ? target.skill.name : target.name}`, 'ok')
      loadInstalled()
    } else {
      useUi.getState().toast(r?.message ?? '安装失败', 'error')
    }
  }

  const exportPack = async (sk: Skill) => {
    const r = await market.exportPack(sk.id).catch(() => null)
    if (r?.ok && r.path) useUi.getState().toast(`已导出：${r.path}`, 'ok')
    else useUi.getState().toast(r?.message ?? '导出失败', 'error')
  }

  // 内置技能的已装判定：装=落盘一份拷贝且 id 保持不变（builtin-<目录名>），按 id 对得上即已装
  const builtinInstalled = (id: string) => !!skills && skills.some((s) => s.id === id)

  // 市场技能的已装判定：主进程按 sourceId = 注册表条目 id 落盘（技能本体 id 是 market-<id>）
  const marketInstalledOf = (id: string): Skill | undefined => skills?.find((s) => s.sourceId === id)

  const previewBody = (t: PreviewTarget): { meta: string; content: string } => {
    if (t.kind === 'market') {
      const it = t.item
      const meta = [it.author ? `作者 ${it.author}` : '', `v${it.version}`, fmtSize(it.size), it.homepage ?? '', `sha256 ${it.sha256.slice(0, 12)}…`]
        .filter(Boolean)
        .join(' · ')
      // 注册表条目只有元数据（包在安装时才下载解包），装前预览如实亮元数据——
      // 不伪造一份假装是正文的文本；正文装后可在"已安装"里预览
      return {
        meta,
        content: `（该技能包的 SKILL.md 正文在安装时才下载，装前仅登记元数据）\n\n描述：${it.desc}\n版本：${it.version}\n体积：${fmtSize(it.size)}\n校验：sha256 ${it.sha256}`
      }
    }
    const sk = t.skill
    const meta = [sk.desc || '（无简介）', sk.version ? `v${sk.version}` : '', sk.dir ?? ''].filter(Boolean).join(' · ')
    return { meta, content: sk.content }
  }

  const installedEmpty = skills !== null && skills.length === 0

  return (
    <>
      <Modal open={open} onClose={onClose} title="技能中心" width={760}>
        {/* Tab 复用设置页 .seg 的视觉口径（同一类组合，不新造轮子） */}
        <div className="seg skill-center-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} className={cls(tab === t.key && 'active')} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'installed' && (
          <div>
            {/* 分区级"何时生效"只在这一处（列表顶部，先读说明再看卡片）：不再靠每张卡下方的
                SkillUsagePanel 各带一句——那会让 3 张卡 = 4 次同文案（2026-10-25 UI 审查） */}
            {skills !== null && skills.length > 0 && <div className="skill-center-hint">{SKILL_TIMING_NOTE}</div>}
            {(skills === null) && <div className="skill-center-empty">加载中…</div>}
            {installedEmpty && <div className="skill-center-empty">还没有安装任何技能；去官方内置或技能市场看看</div>}
            {skills?.map((sk) => {
              // source 由主进程标注（内置/市场装的时候写入）；本地自建的没有该字段 → 本地
              const src = sk.source ?? 'local'
              const on = sk.enabled !== false
              return (
                <div key={sk.id}>
                  <div className="agent-manage-row" style={on ? undefined : { opacity: 0.55 }}>
                    <div className="info">
                      <div className="nm">
                        {sk.name}
                        <span className={cls('skill-center-src', `skill-center-src-${src}`)}>{SKILL_SOURCE_LABELS[src] ?? src}</span>
                      </div>
                      <div className="md">
                        {sk.desc || '（无简介）'}
                        {sk.version ? ` · v${sk.version}` : ''} · {sk.content.length} 字
                      </div>
                    </div>
                    <Button variant="ghost" style={{ height: 26 }} onClick={() => setPreview({ kind: 'installed', skill: sk })}>
                      预览
                    </Button>
                    <Button variant="ghost" style={{ height: 26 }} onClick={() => void exportPack(sk)}>
                      导出 .zip
                    </Button>
                    {/* 启用开关从左侧 checkbox 改为行尾（右上角）Switch：checkbox 的"选中"观感
                        与 Agent 管理卡"勾选=绑定"的语义相反，Switch 是无歧义的开关（2026-10-25 UI 审查） */}
                    <span title={on ? '已启用：可被引用' : '已禁用：不出现在引用列表'}>
                      <Switch on={on} onChange={() => void toggleEnabled(sk)} label={`启用 Skill ${sk.name}`} />
                    </span>
                  </div>
                  {/* 生效范围面板：绑定关系（Agent 卡 / 工作流角色）在面板内部订阅 store，
                      在别处改了绑定，切回技能中心即自动反映 */}
                  <SkillUsagePanel skill={sk} />
                </div>
              )
            })}
          </div>
        )}

        {tab === 'wf' && <WfBindingTab skills={skills} />}

        {tab === 'builtin' && (
          <div>
            <div className="skill-center-hint">内置技能随应用分发，装前可预览全文。</div>
            {builtinErr && (
              <div className="skill-center-error">
                <span>{builtinErr}</span>
                <Button variant="secondary" style={{ height: 26 }} onClick={loadBuiltin}>重试</Button>
              </div>
            )}
            {!builtinErr && builtin === null && <div className="skill-center-empty">加载中…</div>}
            {builtin !== null && builtin.length === 0 && <div className="skill-center-empty">（应用没有内置技能）</div>}
            <div className="skill-center-grid">
              {builtin?.map((s) => {
                const done = builtinInstalled(s.id)
                return (
                  <div key={s.id} className="skill-center-card">
                    <div className="skill-center-card-head">
                      <b>{s.name}</b>
                      {done && <Badge tone="ok">已安装</Badge>}
                    </div>
                    <div className="skill-center-card-desc">{s.desc || '（无简介）'}</div>
                    <div className="skill-center-card-acts">
                      <Button variant="ghost" style={{ height: 26 }} onClick={() => setPreview({ kind: 'builtin', skill: s })}>
                        预览
                      </Button>
                      <Button
                        variant="primary"
                        style={{ height: 26 }}
                        disabled={done}
                        loading={installing === s.id}
                        onClick={() => void install({ kind: 'builtin', skill: s })}
                      >
                        {done ? '已安装' : installing === s.id ? '安装中…' : '安装'}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {tab === 'market' && (
          <div>
            {/* 拉取失败如实亮原文 + 重试；fromCache 必须标明来源，不把缓存装成在线数据 */}
            {regErr && (
              <div className="skill-center-error">
                <span>{regErr}</span>
                <Button variant="secondary" style={{ height: 26 }} onClick={loadRegistry}>重试</Button>
              </div>
            )}
            {!regErr && reg === null && <div className="skill-center-empty">加载中…</div>}
            {reg && reg.items.length === 0 && <div className="skill-center-empty">（注册表暂无技能）</div>}
            <div className="skill-center-grid">
              {reg?.items.map((it) => {
                const inst = marketInstalledOf(it.id)
                // 可更新 = 已装（sourceId 同条目）且注册表版本更高；注册表校验会剥掉非法字段，
                // version 一定存在，但落盘历史数据可能没有 version——没有就当作不可比、不亮更新
                const updatable = !!inst?.version && verCmp(it.version, inst.version) > 0
                const done = !!inst && !updatable
                return (
                  <div key={it.id} className="skill-center-card">
                    <div className="skill-center-card-head">
                      <b>{it.name}</b>
                      <span className="skill-center-ver">v{it.version}</span>
                      {done && <Badge tone="ok">已安装</Badge>}
                      {updatable && <Badge tone="warn">已安装 v{inst?.version}·可更新到 v{it.version}</Badge>}
                    </div>
                    <div className="skill-center-card-desc">{it.desc}</div>
                    <div className="skill-center-card-meta">
                      {[it.author, fmtSize(it.size), it.homepage].filter(Boolean).join(' · ')}
                    </div>
                    <div className="skill-center-card-acts">
                      <Button variant="ghost" style={{ height: 26 }} onClick={() => setPreview({ kind: 'market', item: it })}>
                        预览
                      </Button>
                      <Button
                        variant="primary"
                        style={{ height: 26 }}
                        disabled={done}
                        loading={installing === it.id}
                        onClick={() => void install({ kind: 'market', id: it.id, name: it.name })}
                      >
                        {done ? '已安装' : installing === it.id ? '安装中…' : updatable ? `更新到 v${it.version}` : '安装'}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
            {reg?.fromCache && (
              // fromCache 必须标明来源与读取时间，不把缓存装成在线数据
              <div className="skill-center-cache">来自缓存（读取于 {fmtTime(regAt)}），当前离线或注册表不可达</div>
            )}
            <div className="skill-center-note">技能只是提示词文本，包内脚本只登记不执行；安装后默认启用，可随时停用。</div>
          </div>
        )}
      </Modal>

      {/* 预览是二级弹窗：与主弹窗平级渲染（Modal 是 fixed overlay，DOM 顺序靠后自然在上层），
          Esc/遮罩只关预览这一层，不会连带把技能中心一起关掉 */}
      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview ? `预览：${preview.kind === 'market' ? preview.item.name : preview.skill.name}` : '预览'}
        width={680}
        footer={
          preview && (preview.kind === 'builtin' || preview.kind === 'market') ? (
            (() => {
              // 预览底部才是"装前必读"的落点：读完正文/元数据再决定装不装
              const id = preview.kind === 'builtin' ? preview.skill.id : preview.item.id
              const target =
                preview.kind === 'builtin'
                  ? ({ kind: 'builtin', skill: preview.skill } as const)
                  : ({ kind: 'market', id: preview.item.id, name: preview.item.name } as const)
              const done =
                preview.kind === 'builtin'
                  ? builtinInstalled(preview.skill.id)
                  : (() => {
                      const inst = marketInstalledOf(preview.item.id)
                      return !!inst && !(!!inst.version && verCmp(preview.item.version, inst.version) > 0)
                    })()
              return (
                <>
                  <Button variant="ghost" onClick={() => setPreview(null)}>关闭</Button>
                  <Button
                    variant="primary"
                    disabled={done}
                    loading={installing === id}
                    onClick={() => void install(target)}
                  >
                    {done ? '已安装' : installing === id ? '安装中…' : '安装'}
                  </Button>
                </>
              )
            })()
          ) : (
            <Button variant="ghost" onClick={() => setPreview(null)}>关闭</Button>
          )
        }
      >
        {preview && (
          <>
            {/* 技能正文是 markdown 源码不是聊天消息：纯文本等宽只读渲染，
                不走 MessageBody 的代码块切分（那段解析会改写原文排版） */}
            <div className="skill-center-preview-meta">{previewBody(preview).meta}</div>
            <pre className="skill-center-preview">{previewBody(preview).content}</pre>
          </>
        )}
      </Modal>
    </>
  )
}

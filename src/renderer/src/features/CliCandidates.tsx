// CLI/API 候选列表（文档一.3）：列出支持通过 CLI 或 OpenAI 兼容 API 接入的 Agent，
// 提供安装方式、运行环境、凭据说明、官方文档入口与本机检测；
// 如实区分"有 CLI/API"、"AgentHub 已适配"、"已在当前设备连接成功"。
// 约束：不编造命令、能力、平台或网页地址；未适配/未实测状态如实标注。
import React, { useMemo, useState } from 'react'
import type { CliName } from '@shared/types'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { bridge } from '../lib/ipc'
import { Button, Badge } from '../components/primitives'
import { Icon } from '../components/Icons'
import { cls } from '../lib/utils'

export interface CliCandidate {
  id: string
  name: string
  /** cli = 本机 CLI 接入；api = OpenAI 兼容 API 接入 */
  type: 'cli' | 'api'
  /** type=cli 时对应的 AgentHub CLI 适配名 */
  cli?: CliName
  desc: string
  platforms: string
  /** 安装命令（可复制）；api 类为空 */
  install?: string
  runtime: string
  /** 登录 / 凭据配置方式 */
  auth: string
  /** api 类：预填自定义模型表单 */
  baseUrlHint?: string
  providerHint?: string
  docs: { label: string; url: string }[]
  /** AgentHub 已实现的接入方式与能力范围（如实） */
  adapt: string
}

/** 已本机实测的候选（界面徽章依据，与主进程适配器实现状态一致） */
export const TESTED_CLI_IDS = new Set(['arkcli', 'codex', 'codebuddy', 'dsh'])

/** 候选清单（仅收录有 CLI 或官方 API 的；GUI 桌面应用不在此列） */
export const CLI_CANDIDATES: CliCandidate[] = [
  {
    id: 'arkcli',
    name: 'arkcli（火山方舟）',
    type: 'cli',
    cli: 'arkcli',
    desc: '火山方舟官方 CLI：方舟大模型对话与 Agent 工具集',
    platforms: 'Windows / macOS / Linux',
    install: 'npm install -g @volcengine/ark-cli',
    runtime: 'Node.js 18+（npm 全局安装）',
    auth: '使用 arkcli 自身的登录与 profile 凭据（Volc SSO / API Key），AgentHub 不读取、不保存任何密钥',
    docs: [
      { label: 'npm 包页', url: 'https://www.npmjs.com/package/@volcengine/ark-cli' },
      { label: '火山方舟控制台', url: 'https://console.volcengine.com/ark' }
    ],
    adapt: 'AgentHub 已适配并本机实测：流式对话、用量统计、取消、工作目录、模型参数覆盖；凭据由 CLI 自身管理'
  },
  {
    id: 'claude-code',
    name: 'Claude Code（CLI）',
    type: 'cli',
    cli: 'claude',
    desc: 'Anthropic 官方编码 Agent CLI',
    platforms: 'Windows / macOS / Linux',
    install: 'npm install -g @anthropic-ai/claude-code',
    runtime: 'Node.js 18+（npm 全局安装）',
    auth: '按官方流程登录 Claude 订阅账号（首次运行 CLI 时引导）',
    docs: [
      { label: '官方文档', url: 'https://docs.anthropic.com/en/docs/claude-code' },
      { label: 'npm 包页', url: 'https://www.npmjs.com/package/@anthropic-ai/claude-code' }
    ],
    adapt: 'AgentHub 按官方非交互模式（-p --output-format stream-json）实现，本机未安装、未实测；仅原生 .exe 安装形态可被执行'
  },
  {
    id: 'codex',
    name: 'Codex（OpenAI CLI）',
    type: 'cli',
    cli: 'codex',
    desc: 'OpenAI 官方开源编码 Agent CLI',
    platforms: 'Windows / macOS / Linux',
    install: 'npm install -g @openai/codex',
    runtime: 'Node.js 18+（npm 全局安装）',
    auth: '按官方流程登录 OpenAI 账号',
    docs: [
      { label: 'GitHub 仓库', url: 'https://github.com/openai/codex' },
      { label: 'npm 包页', url: 'https://www.npmjs.com/package/@openai/codex' }
    ],
    adapt: 'AgentHub 已适配并本机实测：exec --json JSONL 事件流、用量、错误透出、取消、工作目录、模型覆盖；支持应用安装形态（%LOCALAPPDATA%\\OpenAI\\Codex\\bin）'
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    type: 'cli',
    cli: 'codebuddy',
    desc: '腾讯 CodeBuddy Code CLI（与 Claude Code 同构的 stream-json）',
    platforms: 'Windows',
    install: 'npm install -g @tencent-ai/codebuddy-code（WorkBuddy 桌面版内置的 lite 版也会被自动发现）',
    runtime: 'Node.js 18+（npm 全局安装）',
    auth: '在终端运行 codebuddy 后执行 /login 完成授权（凭据落在 ~/.codebuddy）；或设 CODEBUDDY_API_KEY（自定义端点再加 CODEBUDDY_BASE_URL）。AgentHub 不读取、不保存任何密钥',
    docs: [{ label: 'CLI 文档', url: 'https://www.codebuddy.ai/docs/cli/installation' }],
    adapt: 'AgentHub 已适配并本机实测：-p --output-format stream-json 事件流、用量统计、取消、工作目录、模型覆盖（--model）；优先使用官方 npm 安装，WorkBuddy 内置版作兜底。注意：WorkBuddy 内置的 lite 版没有交互模式，无法在其中执行 /login'
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness（headless）',
    type: 'cli',
    cli: 'dsh',
    desc: 'DeepSeek Harness 的非交互模式：回答一次任务、打印结果并退出',
    platforms: 'Windows',
    install: '随 DeepSeek Harness 桌面版安装，无需单独安装；入口：<安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd',
    runtime: 'DeepSeek Harness 自带的 Electron 运行时（以 node 模式执行）',
    auth: '用 DSH 自身的模型凭据：在启动环境导出 DEEPSEEK_API_KEY，或在 web profile 的 Models 页写入。AgentHub 不读取、不保存任何密钥',
    docs: [],
    adapt: 'AgentHub 已适配并本机实测：headless 一次性任务；输出为纯文本（非流式），卡片内容在任务结束时一次性出现；缺少凭据时 CLI 返回 MISSING_CREDENTIAL，本层原样透出'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek（API）',
    type: 'api',
    desc: 'DeepSeek 官方 OpenAI 兼容 API',
    platforms: '网络可达即可（无本机安装）',
    runtime: '无需本机运行环境，仅需 API Key',
    auth: '在 DeepSeek 开放平台申请 API Key',
    baseUrlHint: 'https://api.deepseek.com',
    providerHint: 'DeepSeek',
    docs: [
      { label: 'API 文档', url: 'https://api-docs.deepseek.com/' },
      { label: '开放平台（申请 Key）', url: 'https://platform.deepseek.com/' }
    ],
    adapt: '经 AgentHub"自定义模型"接入（OpenAI 兼容）：流式对话、真实模型列表切换、文件/命令工具授权'
  },
  {
    id: 'openai',
    name: 'OpenAI（API）',
    type: 'api',
    desc: 'OpenAI 官方 API',
    platforms: '网络可达即可（无本机安装）',
    runtime: '无需本机运行环境，仅需 API Key',
    auth: '在 OpenAI 平台申请 API Key',
    baseUrlHint: 'https://api.openai.com/v1',
    providerHint: 'OpenAI',
    docs: [
      { label: 'API 文档', url: 'https://platform.openai.com/docs' }
    ],
    adapt: '经 AgentHub"自定义模型"接入（OpenAI 兼容）：流式对话、真实模型列表切换、文件/命令工具授权'
  }
]

/** 复制文本到剪贴板并提示 */
const copyText = async (t: string) => {
  try {
    await navigator.clipboard.writeText(t)
    useUi.getState().toast('已复制到剪贴板', 'ok')
  } catch {
    useUi.getState().toast('复制失败，请手动选择复制', 'warn')
  }
}

export function CliCandidatesTab({ onUseApi, onClose }: {
  /** API 类候选：跳转自定义模型表单并预填 */
  onUseApi: (prefill: { provider: string; baseUrl: string }) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 本机检测结果（CLI 类真实执行版本命令；不联网） */
  const [tests, setTests] = useState<Partial<Record<string, { ok: boolean; message: string; version?: string }>>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const addCliAgent = useAgents((s) => s.addCliAgent)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return CLI_CANDIDATES
    return CLI_CANDIDATES.filter((c) => `${c.name} ${c.desc} ${c.type}`.toLowerCase().includes(q))
  }, [query])

  const detect = async (c: CliCandidate) => {
    if (!c.cli) return
    setTesting(c.id)
    const r = await bridge.cli.test(c.cli)
    setTests((t) => ({ ...t, [c.id]: r }))
    setTesting(null)
  }

  const addCli = async (c: CliCandidate) => {
    if (!c.cli) return
    setAdding(c.id)
    const r = await addCliAgent(c.cli)
    setAdding(null)
    if (r.ok) {
      useUi.getState().toast(`已添加 ${c.name}（真实连接）`, 'ok')
      onClose()
    } else {
      useUi.getState().toast(`添加失败：${r.message}`, 'error')
    }
  }

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 10 }}>
        支持通过 <b>CLI</b> 或 <b>OpenAI 兼容 API</b> 接入的 Agent 候选。状态如实标注：
        已适配并实测 / 已适配未实测 / 需 API Key；安装命令与文档入口来自官方渠道，可复制、可直达。
      </div>
      <div className="form-row" style={{ marginBottom: 10 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按名称或用途搜索候选…"
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((c) => {
          const t = tests[c.id]
          const open = expanded === c.id
          const statusBadge = c.type === 'cli'
            ? (t ? (t.ok ? <Badge tone="ok">已安装{t.version ? ` · ${t.version.slice(0, 24)}` : ''}</Badge> : <Badge tone="warn">未检测到</Badge>) : <Badge tone="default">未检测</Badge>)
            : <Badge tone="info">需 API Key</Badge>
          return (
            <div key={c.id} className={cls('cand-card', open && 'open')}>
              <button className="cand-head" onClick={() => setExpanded(open ? null : c.id)}>
                <div className="cand-title">
                  <b>{c.name}</b>
                  <span className="cand-type">{c.type === 'cli' ? 'CLI' : 'API'}</span>
                  {TESTED_CLI_IDS.has(c.id) && <span className="demo-badge">已实测</span>}
                  {c.type === 'cli' && !TESTED_CLI_IDS.has(c.id) && <span className="demo-badge" style={{ opacity: 0.75 }}>适配未实测</span>}
                </div>
                <div className="cand-sub">{c.desc}</div>
                <div className="cand-meta">
                  {statusBadge}
                  <span className="cand-platforms">{c.platforms}</span>
                  <span className="cand-more">{open ? '收起' : '查看配置步骤'}</span>
                </div>
              </button>
              {open && (
                <div className="cand-body">
                  {c.install && (
                    <div className="cand-row">
                      <span className="cand-k">安装命令</span>
                      <code className="cand-code">{c.install}</code>
                      <button className="btn btn-ghost" style={{ height: 26, fontSize: 12 }} onClick={() => void copyText(c.install!)}>
                        <Icon name="copy" size={12} /> 复制
                      </button>
                    </div>
                  )}
                  <div className="cand-row"><span className="cand-k">运行环境</span><span>{c.runtime}</span></div>
                  <div className="cand-row"><span className="cand-k">凭据配置</span><span>{c.auth}</span></div>
                  <div className="cand-row"><span className="cand-k">接入方式</span><span>{c.adapt}</span></div>
                  <div className="cand-row">
                    <span className="cand-k">官方文档</span>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {c.docs.map((d) => (
                        <button
                          key={d.url}
                          className="btn btn-ghost"
                          style={{ height: 26, fontSize: 12, gap: 4 }}
                          onClick={() => void bridge.app.openExternal(d.url)}
                          title={d.url}
                        >
                          <Icon name="download" size={11} /> {d.label}
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="cand-actions">
                    {c.type === 'cli' ? (
                      <>
                        {!t?.ok && (
                          <Button variant="secondary" disabled={testing === c.id} onClick={() => void detect(c)}>
                            {testing === c.id ? '检测中…' : t ? '重新检测安装' : '检测安装'}
                          </Button>
                        )}
                        {t?.ok && (
                          <Button variant="primary" disabled={adding === c.id} onClick={() => void addCli(c)}>
                            {adding === c.id ? '添加中…' : '验证连接并添加'}
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button variant="primary" onClick={() => onUseApi({ provider: c.providerHint ?? c.name, baseUrl: c.baseUrlHint ?? '' })}>
                        去配置自定义模型（预填地址）
                      </Button>
                    )}
                  </div>
                  {c.type === 'cli' && t && !t.ok && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
                      未检测到可执行文件：{t.message}。请先按上方命令安装（或确认安装形态为原生 .exe），完成后重新检测；
                      安装与授权在你自己的终端中进行，AgentHub 不会代为执行安装。
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {list.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
            没有匹配的候选。其他 OpenAI 兼容服务请直接用「自定义模型」标签页接入。
          </div>
        )}
      </div>
    </div>
  )
}

// Agent 管理：列表、顺序、状态、未读、发现扫描、连接
import { create } from 'zustand'
import type { AgentConfig, ScanResultItem, CustomModelConfig, CliName } from '@shared/types'
import { bridge } from '../lib/ipc'
import { uid } from '../lib/utils'
import { useUi } from './ui'

const DEMO_COLORS = ['#5b6cd9', '#1f9d6d', '#b4820b', '#a25b9e']

/** CLI 展示信息（与主进程适配器声明保持一致） */
export const CLI_META: Record<CliName, { display: string; note: string }> = {
  arkcli: { display: 'arkcli（火山方舟）', note: '本机实测：真实流式调用；凭据走 arkcli 自身 profile，AgentHub 不保存密钥' },
  codex: { display: 'Codex CLI', note: '本机实测：exec --json 事件流；凭据走 ~/.codex 配置，AgentHub 不保存密钥' },
  codebuddy: {
    display: 'CodeBuddy Code',
    note: '本机实测：官方 npm CLI（优先）或 WorkBuddy 内置版；需先 codebuddy 登录（凭据在 ~/.codebuddy），AgentHub 不保存密钥'
  },
  dsh: {
    display: 'DeepSeek Harness（headless）',
    note: '本机实测：headless 一次性任务，输出为纯文本非流式；需该环境已有模型凭据（DEEPSEEK_API_KEY）'
  },
  claude: { display: 'Claude Code CLI', note: '按官方 CLI 规范实现，本机未安装、未实测' }
}

interface AgentsState {
  agents: AgentConfig[]
  selectedId: string | null
  discovered: ScanResultItem[]
  scanning: boolean
  unread: Record<string, number>
  /** 配置色：头像取色 */
  colors: Record<string, string>

  init: (list: AgentConfig[]) => void
  persist: () => void
  addDemoAgent: () => AgentConfig
  addCustomModelAgent: (cfg: Omit<CustomModelConfig, 'keyId' | 'hasKey'>, apiKey: string) => Promise<{ ok: boolean; agent?: AgentConfig; message: string }>
  addCliAgent: (cli: CliName, model?: string, workDir?: string) => Promise<{ ok: boolean; agent?: AgentConfig; message: string }>
  addDiscoveredAgent: (name: string, path: string) => AgentConfig
  updateAgent: (id: string, patch: Partial<AgentConfig>) => void
  removeAgent: (id: string, opts: { deleteHistory: boolean }) => Promise<void>
  reorder: (newIds: string[]) => void
  moveBy: (id: string, delta: number) => void
  select: (id: string) => void
  setStatus: (id: string, status: AgentConfig['status']) => void
  scan: () => Promise<void>
  bumpUnread: (id: string) => void
  clearUnread: (id: string) => void
  colorOf: (id: string) => string
}

export const useAgents = create<AgentsState>()((set, get) => ({
  agents: [],
  selectedId: null,
  discovered: [],
  scanning: false,
  unread: {},
  colors: {},

  init: (list) => {
    const colors: Record<string, string> = {}
    list.forEach((a, i) => (colors[a.id] = DEMO_COLORS[i % DEMO_COLORS.length]))
    const selected = list.find((a) => a.id === get().selectedId)?.id ?? null
    set({ agents: list, colors, selectedId: selected })
  },

  persist: () => {
    void bridge.config.setAgents(get().agents)
  },

  addDemoAgent: () => {
    const n = get().agents.filter((a) => a.kind === 'demo').length + 1
    const agent: AgentConfig = {
      id: uid('agent'),
      name: `演示 Agent ${n}`,
      kind: 'demo',
      desc: '演示模式 · 脚本化回复',
      model: 'demo-scripted',
      status: 'available',
      isDemo: true,
      addedAt: Date.now()
    }
    set((s) => ({ agents: [...s.agents, agent], colors: { ...s.colors, [agent.id]: DEMO_COLORS[(get().agents.length - 1) % DEMO_COLORS.length] } }))
    get().persist()
    return agent
  },

  addCustomModelAgent: async (cfg, apiKey) => {
    const keyId = uid('key')
    // 先测试连接，成功才保存 Key 并标记可用——不伪造连接状态
    const testCfg: CustomModelConfig = { ...cfg, keyId, hasKey: true }
    const result = await bridge.models.test(testCfg, apiKey)
    if (!result.ok) {
      return { ok: false, message: `连接测试失败：${result.message}` }
    }
    // 模型名校验：服务端返回了模型列表且不含所填 ID 时提前拦截
    // （列表为空/未返回时不拦截——部分服务的 /models 不全，避免误伤）
    if (result.models && result.models.length > 0 && !result.models.some((m) => m.toLowerCase() === cfg.modelId.toLowerCase())) {
      const shown = result.models.slice(0, 12).join('、')
      return {
        ok: false,
        message: `连接成功，但模型 ID「${cfg.modelId}」不在该服务支持列表中（需与列表完全一致）。可用模型：${shown}${result.models.length > 12 ? ` 等 ${result.models.length} 个` : ''}`
      }
    }
    await bridge.credentials.save(keyId, apiKey)
    const agent: AgentConfig = {
      id: uid('agent'),
      name: cfg.provider || cfg.modelId,
      kind: 'model',
      desc: `${cfg.baseUrl}`,
      model: cfg.modelId,
      status: 'available',
      modelConfig: { ...testCfg, hasKey: true },
      addedAt: Date.now()
    }
    set((s) => ({ agents: [...s.agents, agent], colors: { ...s.colors, [agent.id]: DEMO_COLORS[get().agents.length % DEMO_COLORS.length] } }))
    get().persist()
    return { ok: true, agent, message: result.message }
  },

  addCliAgent: async (cli, model, workDir) => {
    // 先真实测试（解析 exe + 版本命令），成功才添加——不伪造连接状态
    const t = await bridge.cli.test(cli)
    if (!t.ok) {
      return { ok: false, message: `连接测试失败：${t.message}` }
    }
    if (!workDir?.trim()) {
      return { ok: false, message: '请设置工作目录：CLI 的文件读写与命令执行都发生在此目录内（必须指定，避免污染应用目录）' }
    }
    const agent: AgentConfig = {
      id: uid('agent'),
      name: CLI_META[cli].display,
      kind: 'cli',
      desc: t.exePath ?? '',
      model: model?.trim() || '默认（CLI 自身配置）',
      status: 'available',
      cliConfig: { cli, workDir: workDir!.trim(), ...(model?.trim() ? { model: model.trim() } : {}), exePath: t.exePath ?? '' },
      addedAt: Date.now()
    }
    set((s) => ({ agents: [...s.agents, agent], colors: { ...s.colors, [agent.id]: '#0e7490' } }))
    get().persist()
    return { ok: true, agent, message: `${t.version ?? '可用'}` }
  },

  addDiscoveredAgent: (name, path) => {
    const agent: AgentConfig = {
      id: uid('agent'),
      name,
      kind: 'demo', // 未内置适配器的 CLI：加入后仅作为占位（如实在 desc 标注）
      desc: `已发现：${path}（待连接，本版本未内置该 CLI 执行适配器）`,
      model: '—',
      status: 'disconnected',
      addedAt: Date.now()
    }
    set((s) => ({ agents: [...s.agents, agent], colors: { ...s.colors, [agent.id]: '#64748b' } }))
    get().persist()
    return agent
  },

  updateAgent: (id, patch) => {
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
    get().persist()
  },

  removeAgent: async (id, opts) => {
    // 明确区分"移除连接"与"删除历史记录"
    if (opts.deleteHistory) {
      await bridge.sessions.remove(id, true)
    }
    set((s) => {
      const agents = s.agents.filter((a) => a.id !== id)
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId
      return { agents, selectedId }
    })
    get().persist()
  },

  reorder: (newIds) => {
    const map = new Map(get().agents.map((a) => [a.id, a]))
    const agents = newIds.map((id) => map.get(id)!).filter(Boolean)
    set({ agents })
    get().persist()
  },

  moveBy: (id, delta) => {
    const agents = [...get().agents]
    const i = agents.findIndex((a) => a.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= agents.length) return
    ;[agents[i], agents[j]] = [agents[j], agents[i]]
    set({ agents })
  },

  select: (id) => set({ selectedId: id }),

  setStatus: (id, status) => {
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, status } : a)) }))
  },

  scan: async () => {
    set({ scanning: true })
    try {
      const list = await bridge.agents.scan()
      set({ discovered: list })
      if (list.length === 0) useUi.getState().toast('未发现已知 Agent CLI（仅扫描 PATH，不读取任何软件配置）', 'info')
      else useUi.getState().toast(`发现 ${list.length} 个候选，检测到 ≠ 已接入，执行前需连接验证`, 'info')
    } catch (e) {
      useUi.getState().toast(`扫描失败：${(e as Error).message}`, 'error')
    } finally {
      set({ scanning: false })
    }
  },

  bumpUnread: (id) => set((s) => ({ unread: { ...s.unread, [id]: (s.unread[id] ?? 0) + 1 } })),
  clearUnread: (id) => set((s) => ({ unread: { ...s.unread, [id]: 0 } })),
  colorOf: (id) => get().colors[id] ?? '#64748b'
}))

import { contextBridge, ipcRenderer } from 'electron'
import type { CompatState, SandboxFallbackPolicy } from '../shared/compat'
// 类型-only 导入（编译期擦除，不产生对 main 的运行时依赖）：注册表条目形状的唯一真相在 main/market.ts
import type { RegistryItem as MarketRegistryItem } from '../main/market'
// 同上：官方模型清单形状的唯一真相在 main/official-models.ts
import type { OfficialModelsResult } from '../main/official-models'
import type {
  AppConfig, AgentSession, WorkflowRun, MemoryEntry, CustomModelConfig,
  ModelTestResult, ScanResultItem, AppInfo, AgentConfig, CliName, ToolGrant, ToolCall, Skill, ThinkingLevel,
  LedgerEntry, LedgerUsageRow, ConventionFile, ApprovalDecision, ApprovalRequest, ApprovalRecord,
  CheckpointManifest, CheckpointDelta, RollbackResult, FileChange, PriceOverride, HookRule, McpServer, McpProbe,
  RejectedEntry, TaskSchedule, WorkflowTemplate
} from '../shared/types'

/** 更新下载事件（main -> renderer，update:event 通道）：进度 / 完成 / 失败 */
export type UpdateDownloadEvent =
  | { type: 'progress'; got: number; total: number; pct: number }
  | { type: 'done'; path: string; sha256: string; verified: boolean; hashNote?: string; staged?: boolean; stagedVersion?: string; stagedNote?: string }
  | { type: 'error'; message: string }

/** 已暂存待应用的更新（main -> renderer，update:stagedStatus 通道）：staged.json 的内容 */
export interface StagedUpdate {
  version: string
  sha256: string
  stagedAt: number
}

/** 损坏备份条目（store.listCorruptBackups 的返回形状） */
export interface CorruptBackupItem {
  corruptPath: string
  originalPath: string
  ts: number
}

/**
 * 渲染进程唯一桥。所有通道在 main/ipc.ts 中以 allowlist 方式注册。
 * API Key 一经保存即进入系统凭据存储，渲染进程不再回读明文。
 */
const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    /** 打开本机文件或目录（产物交付用；主进程校验绝对路径且存在） */
    openPath: (p: string) => ipcRenderer.invoke('app:openPath', p) as Promise<{ ok: boolean; message?: string }>,
    /** 确保并返回 AgentHub 自建工作区目录（<文档>/AgentHub-workspaces/<name>）：目录由主进程创建，渲染层不再自己拼路径 */
    ensureWorkspaceDir: (name: string) =>
      ipcRenderer.invoke('app:ensureWorkspaceDir', name) as Promise<{ ok: boolean; path?: string; message?: string }>,
    /** 后台任务完成/失败的系统通知（窗口聚焦时主进程会自己跳过） */
    notify: (title: string, body: string) =>
      ipcRenderer.invoke('app:notify', title, body) as Promise<{ ok: boolean; skipped?: boolean; message?: string }>,
    /** 上报"有工作流正在执行"：主进程据此决定关闭窗口要不要弹确认 */
    setBusy: (busy: boolean) => ipcRenderer.invoke('app:setBusy', busy) as Promise<{ ok: boolean }>,
    /** 当前应用菜单的加速键清单（验证用） */
    menuSummary: () => ipcRenderer.invoke('app:menuSummary') as Promise<{ accelerators: string[]; custom: boolean }>,
    /** 兼容模式事实（只读）：实际关掉了沙箱还是硬件加速 + 当前生效的降级策略。
     *  主进程报的是"这台机器现在跑成什么样"，不是配置里写了什么 */
    compat: () => ipcRenderer.invoke('app:compat') as Promise<CompatState>,
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    /** Agent 工作目录只读列举（@文件引用用）：CLI/演示/未配置目录的 Agent 以 ok=false + message 拒绝 */
    listDir: (agentId: string, rel: string) =>
      ipcRenderer.invoke('fs:listDir', agentId, rel) as Promise<{
        ok: boolean; entries?: { name: string; isDir: boolean; size: number }[]; message?: string
      }>,
    /** Agent 工作目录只读读文本（@文件引用用）：超 64KB 拒收并提示改用附件按钮 */
    readTextFile: (agentId: string, rel: string) =>
      ipcRenderer.invoke('fs:readTextFile', agentId, rel) as Promise<{ ok: boolean; content?: string; message?: string }>,
    /** Agent 工作目录只读图片预览（FilePreviewPanel 用）：仅图片扩展名、≤5MB，返回 data URL */
    readDataUrl: (agentId: string, rel: string) =>
      ipcRenderer.invoke('fs:readDataUrl', agentId, rel) as Promise<{ ok: boolean; dataUrl?: string; mime?: string; bytes?: number; message?: string }>
  },
  update: {
    /** 版本检查（manual=true 不受 3 天节流，用于设置页按钮）；asset 为便携包资产信息（确认弹窗显示大小用） */
    check: (manual: boolean) => ipcRenderer.invoke('update:check', manual) as Promise<{
      current: string; hasUpdate: boolean; latest?: string; releaseUrl?: string; asset?: { name: string; size: number }; error?: string
    }>,
    /** 下载便携更新包（只下载与校验哈希，绝不执行/安装）：立即返回，进度与结果经 onUpdateEvent 推送 */
    download: () => ipcRenderer.invoke('update:download') as Promise<{ ok: boolean; message?: string }>,
    /** 打开下载目录（<userData>/updates） */
    openDownloadDir: () => ipcRenderer.invoke('update:openDownloadDir') as Promise<{ ok: boolean; message?: string }>,
    /** 已暂存待应用的更新（staged.json）；没有则 null。挂载时查一次即可，有就亮「应用更新」按钮 */
    stagedStatus: () => ipcRenderer.invoke('update:stagedStatus') as Promise<StagedUpdate | null>,
    /** 一键应用已暂存的更新（只由用户点按钮触发；只换便携版明文 resources/app）。
     *  ok=true 时主进程延迟片刻自行 relaunch；pending=true 表示这次没换成、下次启动自动补做 */
    apply: () =>
      ipcRenderer.invoke('update:apply') as Promise<{ ok: boolean; relaunch?: boolean; pending?: boolean; message?: string }>,
    /** 订阅更新下载事件（progress / done / error）；返回退订函数 */
    onUpdateEvent: (cb: (ev: UpdateDownloadEvent) => void) => {
      const handler = (_e: unknown, data: UpdateDownloadEvent) => cb(data)
      ipcRenderer.on('update:event', handler)
      return () => { ipcRenderer.removeListener('update:event', handler) }
    }
  },
  autostart: {
    get: () => ipcRenderer.invoke('autostart:get') as Promise<boolean>,
    set: (on: boolean) => ipcRenderer.invoke('autostart:set', on) as Promise<boolean>
  },
  /** 定时任务：rejected = 这次保存里没被接受的条目（形状闸门在 main/scheduler.partitionSchedules，照 mcp:set 口径点名拒收） */
  schedule: {
    list: () => ipcRenderer.invoke('schedule:list') as Promise<TaskSchedule[]>,
    set: (list: TaskSchedule[]) =>
      ipcRenderer.invoke('schedule:set', list) as Promise<{ ok: boolean; list: TaskSchedule[]; rejected: RejectedEntry[] }>,
    remove: (id: string) => ipcRenderer.invoke('schedule:remove', id) as Promise<{ ok: boolean; message?: string }>,
    /** 定时任务到点事件（main 30 秒 tick 判定后推送）；返回退订函数 */
    onFire: (cb: (s: TaskSchedule) => void) => {
      const handler = (_e: unknown, data: TaskSchedule) => cb(data)
      ipcRenderer.on('scheduler:fire', handler)
      return () => { ipcRenderer.removeListener('scheduler:fire', handler) }
    }
  },
  /** 工作流剧本（目标模板 + 预设 + 计划档的一键载入方案）；rejected 口径同 schedule.set */
  templates: {
    get: () => ipcRenderer.invoke('templates:get') as Promise<WorkflowTemplate[]>,
    set: (list: WorkflowTemplate[]) =>
      ipcRenderer.invoke('templates:set', list) as Promise<{ ok: boolean; list: WorkflowTemplate[]; rejected: RejectedEntry[] }>
  },
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    setPrefs: (prefs: AppConfig['prefs']) => ipcRenderer.invoke('prefs:set', prefs),
    setAgents: (agents: AgentConfig[]) => ipcRenderer.invoke('agents:set', agents),
    setWorkflowDefaults: (wd: AppConfig['workflowDefaults']) => ipcRenderer.invoke('workflowDefaults:set', wd),
    setPresets: (list: AppConfig['presets']) => ipcRenderer.invoke('presets:set', list),
    /** 沙箱降级策略（设置 → 关于 三选）：值域由主进程限定，写回的当前值随结果返回 */
    setSandboxFallback: (policy: SandboxFallbackPolicy) =>
      ipcRenderer.invoke('sandboxFallback:set', policy) as Promise<{ ok: boolean; policy: SandboxFallbackPolicy; message?: string }>,
    exportFile: () => ipcRenderer.invoke('config:export'),
    importFile: () => ipcRenderer.invoke('config:import'),
    /** 程序化导入（验证专用）：主进程仅在 argv 带 --ahub-verify 时注册该通道，入口并拒绝非字符串/超限 payload；
     * 普通启动下调用会以"未注册"失败——这是设计行为，界面上也从不提供入口 */
    importJson: (json: string) => ipcRenderer.invoke('config:importJson', json) as Promise<{ ok: boolean; message: string }>
  },
  credentials: {
    save: (keyId: string, secret: string) => ipcRenderer.invoke('credential:save', keyId, secret),
    has: (keyId: string) => ipcRenderer.invoke('credential:has', keyId) as Promise<boolean>,
    delete: (keyId: string) => ipcRenderer.invoke('credential:delete', keyId)
  },
  sessions: {
    /** 保存该 Agent 的全部会话（v2 多会话；activeId 为当前活跃会话） */
    save: (agentId: string, sessions: AgentSession[], activeId?: string) =>
      ipcRenderer.invoke('session:save', agentId, sessions, activeId),
    load: (agentId: string) =>
      ipcRenderer.invoke('session:load', agentId) as Promise<{ sessions: AgentSession[]; activeId?: string } | null>,
    remove: (agentId: string, deleteHistory: boolean) => ipcRenderer.invoke('session:remove', agentId, deleteHistory)
  },
  runs: {
    save: (r: WorkflowRun) => ipcRenderer.invoke('run:save', r),
    list: () => ipcRenderer.invoke('run:list') as Promise<WorkflowRun[]>,
    remove: (id: string) => ipcRenderer.invoke('run:remove', id)
  },
  /** 损坏备份（*.corrupt-<ts>）的发现与恢复；恢复会覆盖现有原文件，恢复后需重启应用。
   *  整包迁移（换机）：导出/导入对话框在主进程侧，渲染层只发意图。
   *  整包刻意不含 credentials.enc——safeStorage 加密绑定原机器用户，导入后 API Key 需重填 */
  data: {
    corruptList: () => ipcRenderer.invoke('data:corruptList') as Promise<CorruptBackupItem[]>,
    corruptRestore: (corruptPath: string) =>
      ipcRenderer.invoke('data:corruptRestore', corruptPath) as Promise<{ ok: boolean; message: string }>,
    exportBundle: () => ipcRenderer.invoke('data:exportBundle') as Promise<{ ok: boolean; message: string }>,
    importBundle: () =>
      ipcRenderer.invoke('data:importBundle') as Promise<{
        ok: boolean
        message: string
        counts?: { sessions: number; runs: number; memory: number; skills: number }
      }>
  },
  memory: {
    get: () => ipcRenderer.invoke('memory:get') as Promise<MemoryEntry[]>,
    set: (entries: MemoryEntry[]) => ipcRenderer.invoke('memory:set', entries)
  },
  agents: {
    scan: () => ipcRenderer.invoke('agents:scan') as Promise<ScanResultItem[]>,
    checkPath: (p: string) => ipcRenderer.invoke('agents:checkPath', p) as Promise<boolean>
  },
  cli: {
    /** 本地连接测试（解析 exe + 版本命令，不联网） */
    test: (name: CliName) => ipcRenderer.invoke('cli:test', name) as Promise<{ ok: boolean; message: string; version?: string; exePath?: string }>,
    /** 可枚举的模型清单（不可枚举时 ok=false，界面回退到手填） */
    models: (name: CliName) => ipcRenderer.invoke('cli:models', name) as Promise<{ ok: boolean; models?: string[]; message?: string; source?: string }>,
    chat: (name: CliName, opts: { model?: string; exePath?: string; workDir?: string; timeoutMs?: number; thinkingLevel?: ThinkingLevel }, reqId: string, messages: { role: string; content: string; reasoning?: string }[]) =>
      ipcRenderer.invoke('cli:chat', name, opts, reqId, messages) as Promise<{ ok: boolean; message?: string }>,
    cancel: (reqId: string) => ipcRenderer.invoke('cli:cancel', reqId),
    /** 流式事件与 models 共用 model:event 通道（reqId 路由） */
    onEvent: (cb: (e: { reqId: string; type: string; text?: string; message?: string; usage?: { tokens?: number; prompt?: number; completion?: number } }) => void) => {
      const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('model:event', handler)
      return () => ipcRenderer.removeListener('model:event', handler)
    }
  },
  models: {
    test: (cfg: CustomModelConfig, apiKey: string) => ipcRenderer.invoke('model:test', cfg, apiKey) as Promise<ModelTestResult>,
    /** 列出接口真实可用的模型（切换模型用；凭据在主进程取，渲染层不经手） */
    list: (cfg: CustomModelConfig) => ipcRenderer.invoke('model:list', cfg) as Promise<{ ok: boolean; models?: string[]; message?: string }>,
    /** 余额查询（DeepSeek 官方 /user/balance；其他接口 ok=false） */
    balance: (cfg: CustomModelConfig) => ipcRenderer.invoke('model:balance', cfg) as Promise<{ ok: boolean; message?: string; balance?: number; currency?: string }>,
    chat: (cfg: CustomModelConfig, reqId: string, messages: { role: string; content: string; reasoning?: string; images?: { name: string; dataUrl: string; path: string }[] }[], opts?: { agentId?: string; workflow?: boolean; checkpointId?: string; runId?: string; planMode?: boolean }) =>
      ipcRenderer.invoke('model:chat', cfg, reqId, messages, opts) as Promise<{ ok: boolean; checkpoint?: string }>,
    cancel: (reqId: string) => ipcRenderer.invoke('model:cancel', reqId),
    /** 订阅流式事件（main -> renderer；tool 事件为工具调用执行记录） */
    onEvent: (cb: (e: { reqId: string; type: string; text?: string; message?: string; usage?: { tokens?: number; prompt?: number; completion?: number }; toolCall?: ToolCall; writtenPath?: string }) => void) => {
      const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('model:event', handler)
      return () => ipcRenderer.removeListener('model:event', handler)
    },
    /** 命令审批到达（独立订阅口：payload 与流事件不同构，不塞进 onEvent 的联合类型里） */
    onApproval: (cb: (req: ApprovalRequest) => void) => {
      const handler = (_e: unknown, data: { type?: string; approval?: ApprovalRequest }) => {
        if (data?.type === 'approval' && data.approval) cb(data.approval)
      }
      ipcRenderer.on('model:event', handler)
      return () => ipcRenderer.removeListener('model:event', handler)
    }
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list') as Promise<Skill[]>,
    save: (skill: Partial<Skill> & { name: string; content: string }) =>
      ipcRenderer.invoke('skills:save', skill) as Promise<{ ok: boolean; skill?: Skill; message?: string }>,
    remove: (id: string) => ipcRenderer.invoke('skills:remove', id) as Promise<{ ok: true }>,
    /** 导入 Agent Skills 标准目录（含 SKILL.md） */
    importDir: () => ipcRenderer.invoke('skills:importDir') as Promise<{ ok: boolean; skill?: Skill; message?: string }>
  },
  /** 技能中心（市场）：内置技能只读清单 / 官方注册表 / 安装 / 导出。安装走 saveSkill 同一存储与注入链 */
  market: {
    /** 内置技能（不落盘的只读清单；装前可读，SKILL.md 正文就在 content 里）。失败以 ok=false + message 回传，不抛桥异常 */
    builtin: () => ipcRenderer.invoke('market:builtin') as Promise<{ ok: boolean; skills?: Skill[]; message?: string }>,
    /** 官方注册表（fromCache=true 表示来自本地缓存，界面要如实标注） */
    registry: () => ipcRenderer.invoke('market:registry') as Promise<{ ok: boolean; items?: MarketRegistryItem[]; error?: string; fromCache?: boolean; skipped?: string[] }>,
    /** 按条目 id 安装：渲染层不传 url/哈希——以主进程拉到的注册表为准 */
    install: (id: string) =>
      ipcRenderer.invoke('market:install', id) as Promise<{ ok: boolean; skill?: Skill; message?: string }>,
    /** 导出技能包（zip）：选择保存位置的对话框在主进程侧 */
    exportPack: (id: string) =>
      ipcRenderer.invoke('market:exportPack', id) as Promise<{ ok: boolean; path?: string; message?: string }>
  },
  /** 官方模型服务：端点+模型清单来自注册表仓库（fromCache=true 为本地缓存，界面如实标注）。
   *  连接测试与对话走既有 models.test / models.chat——key 由用户粘贴，不经本通道 */
  officialModels: {
    list: () => ipcRenderer.invoke('officialModels:list') as Promise<OfficialModelsResult>
  },
  /** MCP server（tools-only + stdio）：配置在 config，信任标记在主进程 approvals.json */
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list') as Promise<McpServer[]>,
    /** rejected：这次保存里没被接受的条目（点名 id + 既有拒绝原因文案）。静默丢条目是本波修掉的缺陷 */
    set: (list: McpServer[]) => ipcRenderer.invoke('mcp:set', list) as Promise<{ ok: boolean; list: McpServer[]; rejected: RejectedEntry[] }>,
    probe: (server: McpServer) => ipcRenderer.invoke('mcp:probe', server) as Promise<McpProbe>,
    trusted: () => ipcRenderer.invoke('mcp:trust') as Promise<string[]>,
    setTrust: (id: string, trusted: boolean) => ipcRenderer.invoke('mcp:trust:set', id, trusted) as Promise<{ ok: boolean; list: string[] }>,
    /** 内置组全局启停（设置页内置行的开关；id 只认主进程常量里的内置 server） */
    builtinSet: (id: string, on: boolean) =>
      ipcRenderer.invoke('mcp:builtin:set', id, on) as Promise<{ ok: boolean; message?: string }>
  },
  /** 工具前后 Hook：pre 可否决调用，post 只观察/后处理 */
  hooks: {
    list: () => ipcRenderer.invoke('hooks:list') as Promise<HookRule[]>,
    /** rejected：校验不通过的条目**原样留在配置里**（不删用户数据），这里只把原因回给界面显示 */
    set: (list: HookRule[]) => ipcRenderer.invoke('hooks:set', list) as Promise<{ ok: boolean; list: HookRule[]; rejected: RejectedEntry[] }>
  },
  /** 自定义单价覆盖（内置表是手写快照，价格变了由你填，带填写日期） */
  prices: {
    get: () => ipcRenderer.invoke('prices:get') as Promise<PriceOverride[]>,
    /** rejected：空模式等没有生效的行会被点名回界面，不再由 .filter/.slice 静默丢掉 */
    set: (list: PriceOverride[]) => ipcRenderer.invoke('prices:set', list) as Promise<{ ok: boolean; list: PriceOverride[]; rejected: RejectedEntry[] }>
  },
  /** 调用账本：只含元数据的用量与排障数据（不含正文与凭据） */
  ledger: {
    list: (limit?: number) => ipcRenderer.invoke('ledger:list', limit) as Promise<LedgerEntry[]>,
    stats: (sinceTs?: number) => ipcRenderer.invoke('ledger:stats', sinceTs) as Promise<LedgerUsageRow[]>,
    /** 某时刻以来能折算出的金额合计（预算闸用；传 runId 只算这次任务的调用） */
    costSince: (sinceTs: number, runId?: string) => ipcRenderer.invoke('ledger:costSince', sinceTs, runId) as Promise<number>,
    clear: () => ipcRenderer.invoke('ledger:clear') as Promise<{ ok: boolean }>,
    export: () => ipcRenderer.invoke('ledger:export') as Promise<{ ok: boolean; message?: string }>
  },
  tools: {    /** 直接执行一次沙箱工具（验证与高级用途；参数不合法/越界会被拒；给 checkpointId 则改动可回滚） */
    exec: (grant: ToolGrant, tool: string, argsJson: string, checkpointId?: string) =>
      ipcRenderer.invoke('tools:exec', grant, tool, argsJson, checkpointId) as Promise<{
        ok: boolean; output: string; writtenPath?: string; change?: FileChange
      }>,
    /** 内置工具清单（只读展示）：与发给模型的同一份定义；flags 按面板当前开关状态传 */
    defs: (flags: { allowCommands?: boolean; allowWeb?: boolean; advanced?: string[] }) =>
      ipcRenderer.invoke('tools:defs', flags) as Promise<{ name: string; desc: string }[]>,
    pickDir: () => ipcRenderer.invoke('dialog:pickDir') as Promise<string | null>
  },
  /** 模型回复图片代理（image:fetch）：主进程按 web_fetch 同口径做 SSRF 守卫后下载并转
   *  base64 data URL；只收 http(s) 图片链接，响应必须 image/* 且 ≤5MB，进程内 LRU 缓存。
   *  allowWeb（该 Agent 是否开启联网）的把关在渲染层（ModelImage 的 allowRemoteImages prop） */
  images: {
    fetch: (url: string) =>
      ipcRenderer.invoke('image:fetch', url) as Promise<{ ok: boolean; dataUrl?: string; mime?: string; bytes?: number; message?: string }>
  },
  artifacts: {
    /** 当前生效的工作流产物目录（用户在执行设置里选的；未选为主进程默认值） */
    dir: () => ipcRenderer.invoke('artifact:dir') as Promise<string>,    /** 由 AgentHub 落盘一篇文本产物：固定写入工作流产物目录，渲染层只能给文件名 */
    write: (fileName: string, content: string, checkpointId?: string) =>
      ipcRenderer.invoke('artifact:write', fileName, content, checkpointId) as Promise<{ ok: boolean; path?: string; message?: string; checkpoint?: string }>,
    /** 产物目录真实文件清单（核对"验收项↔文件"用；主进程给，不让渲染层自己猜目录）。传 dir 列那个目录 */
    ls: (dir?: string) => ipcRenderer.invoke('artifact:ls', dir) as Promise<{
      ok: boolean
      dir?: string
      files: { rel: string; bytes: number }[]
      truncated?: boolean
      message?: string
    }>
  },
  /** 改动检查点：工具层文件改动的备份清单与整体回滚（不覆盖 run_command 与 CLI 自己的写盘） */
  checkpoint: {
    manifest: (id: string) =>
      ipcRenderer.invoke('checkpoint:manifest', id) as Promise<{
        manifest: CheckpointManifest | null
        summary: { total: number; created: number; modified: number; deleted: number; moved: number; unbacked: string[] }
        delta: CheckpointDelta | null
      }>,
    /** mode：'tool'（缺省，工具层备份回滚）| 'git'（另一批次扩展的 git 回滚），主进程原样透传 */
    rollback: (id: string, mode?: 'tool' | 'git') =>
      ipcRenderer.invoke('checkpoint:rollback', id, mode) as Promise<RollbackResult>,
    prune: (id: string) => ipcRenderer.invoke('checkpoint:prune', id) as Promise<{ ok: boolean }>
  },
  /** 项目约定自动读取（AGENTS.md / CLAUDE.md 原文，主进程只读不写） */
  conv: {
    read: (dir?: string) => ipcRenderer.invoke('conv:read', dir) as Promise<ConventionFile[]>
  },
  /** 工作目录概览（正则扫顶层声明，不是 AST/LSP；读不到就空串） */
  repomap: {
    get: (dir?: string) => ipcRenderer.invoke('repomap:get', dir) as Promise<{ text: string; files: number; scanned: number; omitted: number; truncated: boolean }>
  },
  /** 命令审批：白名单规则由主进程持有（渲染层改不动它，只能显式提交新规则） */
  approval: {
    pending: () => ipcRenderer.invoke('approval:pending') as Promise<ApprovalRequest[]>,
    decide: (id: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke('approval:decide', id, decision) as Promise<{ ok: boolean; message?: string }>,
    rules: (agentId?: string) => ipcRenderer.invoke('approval:rules', agentId) as Promise<string[]>,
    allRules: () => ipcRenderer.invoke('approval:rules:all') as Promise<Record<string, string[]>>,
    setRules: (agentId: string, rules: string[]) => ipcRenderer.invoke('approval:rules:set', agentId, rules) as Promise<string[]>,
    history: (limit?: number) => ipcRenderer.invoke('approval:history', limit) as Promise<ApprovalRecord[]>,
    clearHistory: () => ipcRenderer.invoke('approval:history:clear') as Promise<{ ok: boolean }>,
    /** ask_user 的回答提交（空文本=跳过；该提问超时/结束时 ok=false） */
    answer: (id: string, text: string) =>
      ipcRenderer.invoke('approval:answer', id, text) as Promise<{ ok: boolean; message?: string }>
  },
  dialogs: {
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles') as Promise<Array<{ name: string; path: string; size: number; content?: string; dataUrl?: string; image?: boolean; error?: boolean; message?: string }>>,
    saveFile: (defaultName: string, content: string, defaultDir?: string) =>
      ipcRenderer.invoke('dialog:saveFile', defaultName, content, defaultDir) as Promise<{ ok: boolean; message: string }>
  },
  theme: {
    set: (t: 'light' | 'dark' | 'system') => ipcRenderer.invoke('theme:set', t)
  }
}

export type AgentHubApi = typeof api

contextBridge.exposeInMainWorld('agenthub', api)

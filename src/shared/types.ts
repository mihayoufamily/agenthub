// ============ 共享类型（main / preload / renderer 通用） ============

export type WorkMode = 'workbench' | 'workflow'
export type Theme = 'light' | 'dark' | 'system'
export type ReviewMode = 'auto' | 'human'

/** Agent 接入方式 */
export type AgentKind = 'demo' | 'model' | 'cli'
export type CliName = 'arkcli' | 'claude' | 'codex' | 'codebuddy' | 'dsh'
export type AgentConnStatus = 'disconnected' | 'available' | 'running' | 'awaiting' | 'failed'

export interface AgentConfig {
  id: string
  name: string
  kind: AgentKind
  desc: string
  model: string
  status: AgentConnStatus
  /**
   * 该 Agent 的常驻提示词：每次真实调用都自动拼上（工作站对话与工作流角色都生效）。
   * 与 Skill 的区别是"这是我对这个执行者的长期要求"，不是可复用的方法包。
   */
  systemPrompt?: string
  /** 自定义模型配置（kind === 'model' 时有效），apiKey 从不落此处 */
  modelConfig?: CustomModelConfig
  /** 本机 CLI 配置（kind === 'cli' 时有效）；凭据由 CLI 自身管理，AgentHub 不保存任何密钥 */
  cliConfig?: CliAgentConfig
  /** 文件/命令工具授权（kind === 'model' 时可选）：开启即授权在 dir 内读写；未开启 = 纯对话无文件能力 */
  tools?: ToolGrant
  /** 演示模式数据 */
  isDemo?: boolean
  addedAt: number
  /** 累计 Token 用量（usage 事件累计；CLI/模型 Agent 通用，演示 Agent 恒为空） */
  totalTokens?: number
}

/**
 * 模型 Agent 的工具授权（Agent 级授权制）。
 * dir 为沙箱根：read/write/list/delete/move/search/glob/replace 全部限制在其内（路径规范化后逃逸即拒绝）；
 * allowCommands 单独开关（默认关）：开启后 run_command 以 dir 为工作目录执行，超时与输出有上限；
 * allowWeb 单独开关（默认关）：开启后 web_fetch/web_search 可访问外网（http/https）。
 * access 单独开关（默认 'sandbox'）：'full' = 完全访问——文件工具不再限制目录（全盘），命令不限工作目录；
 *   开启需用户在授权面板勾选红色风险确认，界面持续显示"完全访问"红标。
 */
export interface ToolGrant {
  dir: string
  allowCommands?: boolean
  /** 联网工具（web_fetch/web_search）授权；默认关，用户在授权面板单独开启 */
  allowWeb?: boolean
  /** 访问模式：sandbox（默认，沙箱内）/ full（完全访问，全盘文件 + 不限目录命令） */
  access?: 'sandbox' | 'full'
}

/** 思考强度（仅对官方支持的 harness 显示与透传；不支持的模型不显示该设置） */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

/** Skill：可复用提示包（Markdown），聊天中引用后注入本次对话上下文 */
export interface Skill {
  id: string
  name: string
  desc: string
  /** Markdown 内容（注入时的正文） */
  content: string
  createdAt: number
  updatedAt?: number
  /** 禁用后不出现在引用列表、也不会被注入（缺省 = 启用） */
  enabled?: boolean
  /** 兼容 Agent Skills 标准：来源目录与附带文件（相对该目录），渐进加载时告诉模型还能读什么 */
  dir?: string
  files?: string[]
  format?: 'legacy' | 'agentskills'
}

/** 单次请求的用量（usage 事件；CLI 与模型 Agent 通用） */
export interface UsageInfo {
  /** 总 tokens（尽力解析；拿不到明细时仅有此字段） */
  tokens?: number
  /** 输入 tokens（prompt_tokens） */
  prompt?: number
  /** 输出 tokens（completion_tokens） */
  completion?: number
}

/** 一次工具调用的执行记录（随消息保存，可追溯） */
export interface ToolCall {
  id: string
  /** read_file | write_file | list_dir | delete_file | move | run_command */
  tool: string
  args: Record<string, string>
  status: 'running' | 'done' | 'error'
  /** 执行结果文本（文件内容/命令输出/错误信息；超限截断） */
  result?: string
  ts: number
}

/** CLI Agent 配置：执行走 CLI 可执行文件，凭据走 CLI 自身（如 arkcli 的 profile） */
export interface CliAgentConfig {
  cli: CliName
  /** 覆盖模型；不填用 CLI 自身默认（如 arkcli 当前 profile 的默认模型） */
  model?: string
  /** 添加时解析到的可执行路径（展示与预填；执行时失效会重新解析） */
  exePath: string
  /**
   * 工作目录（方案1 边界）：CLI 进程的 cwd，其文件读写/命令执行都发生在此目录内。
   * 不填 = 跟随应用进程目录（默认行为）。目录不存在时执行会如实报错，不悄悄创建。
   */
  workDir?: string
  /** 思考强度（仅 codex/claude 等官方支持的 CLI 显示；透传到各自参数） */
  thinkingLevel?: ThinkingLevel
  /** 上下文窗口大小（tokens；仅用于上下文用量条显示，不传给 CLI） */
  contextWindow?: number
}

export interface CustomModelConfig {
  provider: string
  baseUrl: string
  modelId: string
  /** API Key 保存在系统凭据存储，keyId 为索引 */
  keyId: string
  hasKey: boolean
  temperature?: number
  /** 思考强度（仅对官方支持的模型显示：o 系列/方舟思考模型等；不支持的模型不显示） */
  thinkingLevel?: ThinkingLevel
  /** 上下文窗口大小（tokens；用于上下文用量条；留空按内置对照表推断） */
  contextWindow?: number
}

export interface Attachment {
  id: string
  name: string
  size: number
  path: string
  status: 'ok' | 'error'
  /** text = 文本附件（内容随真实调用发送）；image = 图片（模型走 base64，CLI 只给路径）；binary = 仅记录引用，不发送 */
  kind: 'text' | 'image' | 'binary'
  /** 文本附件的内容（主进程选取时读取；超过上限或读取失败则无此字段并标记 error） */
  content?: string
  /** 图片附件的 data URL（发给支持视觉的模型；不写入任何持久化记录） */
  dataUrl?: string
}

/** 工作台单 Agent 会话消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  ts: number
  demo?: boolean
  streaming?: boolean
  error?: string
  attachments?: Attachment[]
  handoff?: { fromAgentId: string; fromAgentName: string }
  /** 本条消息发送/回复时实际使用的模型（切换模型后仍可追溯） */
  model?: string
  /** 思考模型的思考过程（reasoning_content；多轮对话需随 assistant 消息传回，UI 折叠展示） */
  reasoning?: string
  /** 本次回复中的工具调用记录（文件读写/命令执行，随消息可追溯） */
  toolCalls?: ToolCall[]
  /** 本条回复的 token 用量（usage 事件；CLI 与模型 Agent 通用） */
  usage?: UsageInfo
  /** 本条回复的估算费用（元；按官方单价折算，无单价数据时缺省） */
  cost?: number
  /** 本条消息引用的 Skill（注入对话的提示包，仅记录名称） */
  skills?: string[]
}

export interface AgentSession {
  /** 会话 ID（多会话管理；旧单会话数据加载时自动迁移补 id） */
  id: string
  agentId: string
  /** 会话标题：默认"新会话"，首条消息后取其前缀自动命名，可手动重命名 */
  title: string
  messages: ChatMessage[]
  draft: string
  createdAt: number
  updatedAt?: number
  /** 运行中的后台任务状态（演示） */
  bgTask?: 'running' | 'awaiting' | null
}

/** 工作流任务状态机 */
export type TaskStatus =
  | 'not_started'
  | 'preparing'
  | 'running'
  | 'waiting_review'
  | 'waiting_user'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rework_limit'
  | 'interrupted'
  /** 超时被看门狗停止（非失败：成果与记录保留） */
  | 'timeout'
  /** 累计 Token 达到上限自动停止（非失败：成果与记录保留） */
  | 'token_limit'

export type Stage = 'planning' | 'executing' | 'reviewing' | 'delivering'

/** 卡片角色 */
export type CardRole = 'planner' | 'executor' | 'reviewer' | 'delivery' | 'system'

export interface ChecklistItem {
  text: string
  done: boolean
  /** 审核结论 */
  verdict?: 'pass' | 'issue'
}

export interface ProcessEvent {
  kind: 'summary' | 'tool' | 'log' | 'thinking'
  text: string
  ts: number
  demo?: boolean
  /** 工具调用 id（running→done 同 id 替换，避免重复记录） */
  id?: string
}

export interface ArtifactRef {
  id: string
  name: string
  kind: 'file' | 'change' | 'record'
  demo?: boolean
  path?: string
  /** 产物来源说明（如实标注）：模型经工具真实写盘 / 由 AgentHub 把文本成果落盘 */
  by?: 'tool' | 'app'
}

export interface RoleCard {
  id: string
  role: CardRole
  agentName: string
  model: string
  round: number
  status: 'streaming' | 'done' | 'error'
  title: string
  conclusion: string
  checklist?: ChecklistItem[]
  process: ProcessEvent[]
  artifacts?: ArtifactRef[]
  demo?: boolean
  ts: number
  userExpanded?: boolean
}

/** 人工确认门 */
export interface ReviewGate {
  id: string
  round: number
  passed: ChecklistItem[]
  issues: ChecklistItem[]
  reworkFeedback?: string
}

export interface WorkflowRun {
  id: string
  goal: string
  status: TaskStatus
  stage: Stage | null
  round: number
  maxRounds: number
  reviewMode: ReviewMode
  startedAt: number
  endedAt?: number
  cards: RoleCard[]
  gate?: ReviewGate
  usage?: { tokens?: number; elapsedMs?: number }
  demo?: boolean
  notes?: string[]
  /** 本次任务实际生效的产物目录（由主进程裁决后记录，交付卡片与事后回看都以此为准） */
  outputDir?: string
}

export interface WorkflowRoleConfig {
  agentId: string
  agentName: string
  model: string
  /** 角色级模型覆盖（真实生效，不影响该 Agent 在工作站的默认模型）：
   *  model Agent = 覆盖 modelId；CLI Agent = 覆盖 --model 参数。切换 Agent 时清除。 */
  modelOverride?: string
}

export interface WorkflowConfig {
  planner: WorkflowRoleConfig
  executor: WorkflowRoleConfig
  reviewer: WorkflowRoleConfig
  reviewMode: ReviewMode
  maxRounds: number
  timeoutMin: number
  confirmEveryRound: boolean
  /** 整个任务真实调用累计消耗 Token 上限；0 = 不限制 */
  maxTokens: number
  /**
   * 产物目录：本次工作流的落盘位置。
   * 执行角色若已授权文件工具，其沙箱根临时覆盖为此目录（只换目录，不提升访问级别）；
   * 未授权工具时，AgentHub 把执行结论写成本目录下的一篇文本产物。
   * 留空 = 默认文档目录下的 AgentHub-artifacts。
   */
  outputDir?: string
}

/** 可自定义的全局快捷键动作（窗口内生效，非系统级热键） */
export type HotkeyAction = 'modeSwitch' | 'openSettings' | 'stopTask' | 'newWorkflow'

/** 默认键位；用户在设置里改了就覆盖 */
export const HOTKEY_DEFAULTS: Record<HotkeyAction, string> = {
  modeSwitch: 'Ctrl+M',
  openSettings: 'Ctrl+Comma',
  stopTask: 'Ctrl+Backspace',
  newWorkflow: 'Ctrl+Shift+N'
}

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  modeSwitch: '工作站 ↔ 工作流互切',
  openSettings: '打开设置',
  stopTask: '停止正在执行的工作流',
  newWorkflow: '新建工作流'
}

export interface Prefs {
  theme: Theme
  animations: boolean
  reducedMotion: boolean
  replayWelcome: boolean
  fontSize: number
  sidebarCollapsed: boolean
  enterToSend: boolean
  shiftWheelSwitch: boolean
  firstRunDone: boolean
  lastMode: WorkMode | null
  /** 自定义键位（只存被改过的项；缺省用 HOTKEY_DEFAULTS） */
  keybindings?: Partial<Record<HotkeyAction, string>>
}

/** 持久化配置（带版本号，支持迁移） */
export interface AppConfig {
  schemaVersion: number
  prefs: Prefs
  agents: AgentConfig[]
  workflowDefaults: Omit<WorkflowConfig, 'planner' | 'executor' | 'reviewer'> & {
    plannerAgentId: string
    executorAgentId: string
    reviewerAgentId: string
    /**
     * 角色在工作流侧单独选的模型（覆盖 Agent 自带模型）。
     * 必须持久化：否则重启/resolveRoles 之后覆盖丢失，表现为"工作流里切了模型又变回原模型"。
     */
    plannerModel?: string
    executorModel?: string
    reviewerModel?: string
  }
  /** 工作流预设（角色 + 模型方案，一键套用） */
  presets?: WorkflowPreset[]
  /** Skill 提示包（Markdown 可复用；聊天引用注入，设置页管理） */
  skills?: Skill[]
}

/** 保存的任务：目标 + 三角色完整配置 + 审核方式（点击卡片直接恢复整套配置发起新任务） */
/**
 * 工作流预设：只打包"用谁来干"——三角色各用哪个 Agent、各用什么模型。
 * 目标文字、产物目录、审核方式都不进预设（那是"干什么"和"怎么跑"，与预设正交）。
 */
export interface WorkflowPreset {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  planner: PresetRole
  executor: PresetRole
  reviewer: PresetRole
}

export interface PresetRole {
  agentId: string
  /** 角色级模型覆盖；留空 = 用该 Agent 自带模型 */
  model?: string
}

/** 调用账本条目（只含元数据：不含请求/响应正文，也不含任何凭据） */
export interface LedgerEntry {
  ts: number
  channel: 'model' | 'cli'
  /** harness 标识：模型侧是 baseUrl 主机名，CLI 侧是 cli 名 */
  harness: string
  model?: string
  agentId?: string
  agentName?: string
  workflow?: boolean
  ok: boolean
  ms?: number
  tokens?: number
  prompt?: number
  completion?: number
  cost?: number | null
  events?: number
  error?: string
}

/** 按 harness × 模型 聚合后的用量行 */
export interface LedgerUsageRow {
  harness: string
  model: string
  calls: number
  ok: number
  failed: number
  tokens: number
  prompt: number
  completion: number
  cost: number
  /** 该 harness 未上报 usage 的调用数：如实标注，不拿估算冒充实测 */
  noUsage: number
  ms: number
}

/** 长期记忆条目（区别于单次任务记录） */export interface MemoryEntry {
  id: string
  kind: 'goal' | 'constraint' | 'decision' | 'progress' | 'review' | 'confirm' | 'summary'
  text: string
  ts: number
  editable: boolean
}

export interface ModelTestResult {
  ok: boolean
  message: string
  models?: string[]
}

export interface ScanResultItem {
  name: string
  path: string
  status: 'discovered'
  supportNote: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userDataPath: string
  /** 系统文档目录（CLI Agent 未设工作目录时的默认落点） */
  documentsPath: string
}

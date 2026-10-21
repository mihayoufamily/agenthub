// ============ 共享类型（main / preload / renderer 通用） ============

export type WorkMode = 'workbench' | 'workflow'
export type Theme = 'light' | 'dark' | 'system'
export type ReviewMode = 'auto' | 'human'

/** Agent 接入方式 */
export type AgentKind = 'demo' | 'model' | 'cli'
export type CliName = 'arkcli' | 'claude' | 'codex'
export type AgentConnStatus = 'disconnected' | 'available' | 'running' | 'awaiting' | 'failed'

export interface AgentConfig {
  id: string
  name: string
  kind: AgentKind
  desc: string
  model: string
  status: AgentConnStatus
  /** 自定义模型配置（kind === 'model' 时有效），apiKey 从不落此处 */
  modelConfig?: CustomModelConfig
  /** 本机 CLI 配置（kind === 'cli' 时有效）；凭据由 CLI 自身管理，AgentHub 不保存任何密钥 */
  cliConfig?: CliAgentConfig
  /** 文件/命令工具授权（kind === 'model' 时可选）：开启即授权在 dir 内读写；未开启 = 纯对话无文件能力 */
  tools?: ToolGrant
  /** 演示模式数据 */
  isDemo?: boolean
  addedAt: number
}

/**
 * 模型 Agent 的工具授权（Agent 级授权制）。
 * dir 为沙箱根：read/write/list/delete/move 全部限制在其内（路径规范化后逃逸即拒绝）；
 * allowCommands 单独开关（默认关）：开启后 run_command 以 dir 为工作目录执行，超时与输出有上限。
 */
export interface ToolGrant {
  dir: string
  allowCommands?: boolean
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
}

export interface CustomModelConfig {
  provider: string
  baseUrl: string
  modelId: string
  /** API Key 保存在系统凭据存储，keyId 为索引 */
  keyId: string
  hasKey: boolean
  temperature?: number
}

export interface Attachment {
  id: string
  name: string
  size: number
  path: string
  status: 'ok' | 'error'
  /** text = 文本附件（内容随真实调用发送给模型/CLI）；binary = 仅记录引用，不发送内容 */
  kind: 'text' | 'binary'
  /** 文本附件的内容（主进程选取时读取；超过上限或读取失败则无此字段并标记 error） */
  content?: string
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
  /** 本次回复中的工具调用记录（文件读写/命令执行，随消息可追溯） */
  toolCalls?: ToolCall[]
}

export interface AgentSession {
  agentId: string
  messages: ChatMessage[]
  draft: string
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
  }
}

/** 长期记忆条目（区别于单次任务记录） */
export interface MemoryEntry {
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
}

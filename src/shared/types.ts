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
  /** 演示模式数据 */
  isDemo?: boolean
  addedAt: number
}

/** CLI Agent 配置：执行走 CLI 可执行文件，凭据走 CLI 自身（如 arkcli 的 profile） */
export interface CliAgentConfig {
  cli: CliName
  /** 覆盖模型；不填用 CLI 自身默认（如 arkcli 当前 profile 的默认模型） */
  model?: string
  /** 添加时解析到的可执行路径（展示与预填；执行时失效会重新解析） */
  exePath: string
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
}

export interface WorkflowConfig {
  planner: WorkflowRoleConfig
  executor: WorkflowRoleConfig
  reviewer: WorkflowRoleConfig
  reviewMode: ReviewMode
  maxRounds: number
  timeoutMin: number
  confirmEveryRound: boolean
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

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
  /**
   * 该 Agent 绑定的 Skill（Agent 级，与角色级、会话级是**并集去重**，没有优先级开关）。
   * `skillMode === 'auto'` 时每次真实调用自动注入正文；`'reference'`（缺省）只进可引用清单。
   */
  skillIds?: string[]
  /** Agent 级 Skill 的注入方式；缺省或脏值都按 'reference' 处理（老配置行为完全不变） */
  skillMode?: 'auto' | 'reference'
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
  /**
   * 命令审批策略：'ask'（默认，每条不在白名单的命令都要人工确认）/ 'auto'（沿用旧行为，授权即放行）。
   * 白名单本身不在这里——它由主进程 approvals.json 持有，渲染层改不了，避免自我提权。
   */
  commandPolicy?: 'ask' | 'auto'
  /** 写前预览：覆盖已有文件前先给出行级 diff 让人确认（默认关，工具循环里逐次弹窗很吵） */
  previewWrites?: boolean
  /**
   * 计划态：true 时五个写类工具（write_file/replace_in_file/delete_file/move/run_command）
   * 一律拒绝，并且连发给模型的 schema 都不给它们；只读与联网照常。
   * 只对**模型 Agent 的工具层**成立——CLI 角色的写盘由它自己的子进程执行，这里拦不到，
   * 界面措辞按 spec 批次 F 写，不写"一定没改文件"。
   */
  planMode?: boolean
  /** 该 Agent 勾选启用的 MCP server id（不勾 = 这个 Agent 看不到任何 MCP 工具） */
  mcpServerIds?: string[]
}

/** 命令审批的人工裁决结果 */
export type ApprovalDecision = 'once' | 'always' | 'deny'

/** 一次待裁决的命令审批请求（推给渲染层界面） */
export interface ApprovalRequest {
  id: string
  /** 关联的流 reqId：该流被取消时待审批一律按拒绝收场 */
  reqId: string
  tool: string
  /** 命令原文（界面完整展示，不折叠、不改写）；kind='diff' 时为受影响路径 */
  command: string
  dir: string
  agentId?: string
  agentName?: string
  /** 为什么要问：不在白名单 / 命中危险形态 / 未配置白名单 / 将覆盖已有文件 */
  reason: string
  /** 未被规则覆盖的命令片段（如实指出到底是哪一段没过） */
  uncovered?: string[]
  ts: number
  /** 'command'（默认）= 命令审批；'diff' = 写前预览（不提示"始终允许"）；'mcp' = 首次连接一个 MCP server */
  kind?: 'command' | 'diff' | 'mcp'
  /** kind='diff' 时的行级 diff */
  diff?: string
  /** kind='mcp' 时：这个 server 暴露的工具清单（放行前必须看得见） */
  mcpTools?: { name: string; description?: string }[]
  /** kind='mcp' 时：要记住信任的 server id */
  mcpServerId?: string
}

/** 审批历史条目（裁决落盘，事后可审计） */
export interface ApprovalRecord {
  id: string
  ts: number
  tool: string
  command: string
  dir: string
  agentName?: string
  decision: ApprovalDecision
  /** 命中的放行理由（与当初为什么问它放在一起看才有意义） */
  reason: string
  /** decision=always 时写入白名单的规则 */
  rule?: string
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
  /** 本次改动登记（有检查点时）：界面显示行级 diff 与"能不能回滚" */
  change?: FileChange
  /** 这次工具调用跑过的 Hook（含被 pre 否决的情况） */
  hooks?: HookRun[]
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
  /** 本次回复对应的改动检查点 id（工具层写过文件才有；回滚入口据此找清单） */
  checkpoint?: string
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
  /** 折算费用达到预算上限自动停止（非失败：成果与记录保留） */
  | 'budget_limit'

export type Stage = 'planning' | 'executing' | 'reviewing' | 'delivering' | 'awaiting_plan_approval'

/** 卡片角色 */
export type CardRole = 'planner' | 'executor' | 'reviewer' | 'delivery' | 'system'

export interface ChecklistItem {
  text: string
  done: boolean
  /** 审核结论 */
  verdict?: 'pass' | 'issue'
  /**
   * 这条验收项对应到产物目录里的哪些文件（角色自己给的，不虚构：
   * 界面会拿真实目录核对，指到不存在的文件会标出来）
   */
  files?: string[]
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
  /**
   * 门的种类。缺省 = 'review'（审核后人工确认，既有语义）；
   * 'plan' = 计划批准门：批准前不进执行与审核，批准后同一个 run 继续。
   * 老记录没有这个字段，按 'review' 渲染（不迁移、不猜）。
   */
  kind?: 'review' | 'plan'
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
  /**
   * 计划轮（planFirst）产出的计划正文。批准门展示它、执行角色把它当作规划结论；
   * 点「存为产物」之前它不落盘（spec 批次 F：计划正文自己不该成为交付物）。
   */
  planText?: string
}

export interface WorkflowRoleConfig {
  agentId: string
  agentName: string
  model: string
  /** 角色级模型覆盖（真实生效，不影响该 Agent 在工作站的默认模型）：
   *  model Agent = 覆盖 modelId；CLI Agent = 覆盖 --model 参数。切换 Agent 时清除。 */
  modelOverride?: string
  /** 这个角色固定要遵守的 Skill（会话级引用之外的角色级绑定；缺省 = 不绑定） */
  skillIds?: string[]
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
   * 整个任务的费用上限（元）；0 = 不限制。
   * 只统计算得出金额的调用（有公开单价或你填了单价）——是下界，不是总账。
   */
  budgetYuan?: number
  /**
   * 产物目录：本次工作流的落盘位置。
   * 执行角色若已授权文件工具，其沙箱根临时覆盖为此目录（只换目录，不提升访问级别）；
   * 未授权工具时，AgentHub 把执行结论写成本目录下的一篇文本产物。
   * 留空 = 默认文档目录下的 AgentHub-artifacts。
   */
  outputDir?: string
  /**
   * 任务级计划态（批次 F）：开工先跑一轮**只读规划**，产出计划正文并挂批准门；
   * 用户批准后才进正常三角色链，且同一个 run 继续（不重跑计划轮、不新建任务）。
   * 缺省 false = 行为与既有任务完全一致。
   */
  planFirst?: boolean
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
    /** 角色级 Skill 绑定（同上：必须持久化，否则重启后"绑了技能"这件事会静默丢失） */
    plannerSkillIds?: string[]
    executorSkillIds?: string[]
    reviewerSkillIds?: string[]
  }
  /** 工作流预设（角色 + 模型方案，一键套用） */
  presets?: WorkflowPreset[]
  /** Skill 提示包（Markdown 可复用；聊天引用注入，设置页管理） */
  skills?: Skill[]
  /** 工具前后 Hook（用户在设置里配置；开启即等于让 AgentHub 替你执行这些命令） */
  hooks?: HookRule[]
  /** MCP server 全局列表（各 Agent 在工具面板勾选启用；信任标记在主进程侧） */
  mcpServers?: McpServer[]
  /** 沙箱/GPU 崩溃自动降级策略：auto=降级后提示一次，ask=降级前问，off=不降级直接失败 */
  sandboxFallback?: 'auto' | 'ask' | 'off'
  /**
   * 自定义单价（元 / 1M tokens）：内置表是手写快照，价格变了或没收录的模型由你自己填，
   * 带填写日期，界面据此说明金额是按哪份数据折算的。
   */
  priceOverrides?: PriceOverride[]
}

/** 自定义单价覆盖条目（元 / 1M tokens） */
export interface PriceOverride {
  /** 匹配 modelId 的正则（与内置表同一口径，忽略大小写） */
  pattern: string
  input: number
  output: number
  cacheHit?: number
  /** 这份价格的日期（你自己填的，界面如实标"填写于 X"） */
  asOf: string
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
  /** 属于哪次工作流任务：预算闸只算本次任务的调用，不把同时发生的工作站对话算进来 */
  runId?: string
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

/** 自动读取到的项目约定文件（AGENTS.md / CLAUDE.md 原文，注入上下文用） */
export interface ConventionFile {
  /** 文件名（AGENTS.md / CLAUDE.md） */
  name: string
  path: string
  content: string
  /** 超过注入上限时主进程截断，界面与提示词都要如实标出 */
  truncated?: boolean
}

/** repo map 的单文件条目（概览注入用） */
export interface RepoMapFile {
  rel: string
  bytes?: number
  symbols: string[]
}

/** 一次工具层文件改动的登记条目（回滚清单与交付验收共用） */
export interface FileChange {
  /** 绝对路径 */
  path: string
  /** 相对本次工作目录的路径（回滚只按它在工作目录内操作） */
  rel: string
  kind: 'created' | 'modified' | 'deleted' | 'moved'
  /** moved 的来源相对路径 */
  from?: string
  bytes?: number
  /** 行级 diff（过大/二进制/新建时为 null，不假装算完了） */
  diff?: string | null
  /** 未纳入回滚的原因（超上限、越界等）：界面必须显示，不给"一键回滚"的假安全感 */
  unbacked?: string
}

/** 改动检查点清单：copy-on-write，只存"第一次改动前"的原件副本 */
export interface CheckpointManifest {
  id: string
  /** 本次检查点的工作目录（回滚只动它之内的路径） */
  dir: string
  createdAt: number
  /** 已存过原件副本的相对路径 */
  backed: string[]
  entries: FileChange[]
  /** 开工前拍的目录文件清单（相对路径）；没拍成则缺省，界面要能说"对照不可用" */
  baseline?: string[]
  baselineAt?: number
  /** 清单超过上限被截断：对照结果只是部分 */
  baselineTruncated?: boolean
}

/** 目录与基线的差集（含命令与 CLI 造成的改动，回滚清单不覆盖这些） */
export interface CheckpointDelta {
  added: string[]
  removed: string[]
  baseline: number
  truncated?: boolean
}

/** 回滚结果（逐项如实汇报，部分失败不粉饰成成功） */
export interface RollbackResult {
  ok: boolean
  restored: number
  removed: number
  moved: number
  failed: { rel: string; message: string }[]
  message?: string
}

/**
 * 工具 Hook：在工具调用前后插一段你自己的命令（对齐 PreToolUse / PostToolUse 语义）。
 * 数据通过环境变量传（AHUB_HOOK_TOOL / _ARGS / _RESULT / _FILE），不做字符串模板替换——
 * 命令是你写的，参数是模型给的，拼接会把注入面留在命令串里。
 */
export interface HookRule {
  id: string
  /** pre=执行前（可否决）；post=执行后（观察/后处理，不撤销已发生的改动） */
  event: 'pre' | 'post'
  /** 匹配工具名的正则（忽略大小写）；空 = 全部工具 */
  match?: string
  /** 要跑的命令（shell 语法，工作目录 = 该 Agent 的沙箱根） */
  command: string
  /** 缺省视为启用 */
  enabled?: boolean
  /** 默认 15 秒 */
  timeoutMs?: number
  createdAt?: number
}

/** 一次 Hook 的执行结果（如实回传给模型与界面） */
export interface HookRun {
  id: string
  command: string
  exit: number | null
  ok: boolean
  blocked: boolean
  timedOut?: boolean
  /** stdout/stderr 摘要（截断后） */
  output?: string
}

/**
 * MCP server 配置（tools-only：只用它提供的工具，不接它的 prompts/resources）。
 * 第一版只支持 stdio：本机拉起一条命令，按换行分隔的 JSON-RPC 通信。
 * 远程 HTTP/SSE 刻意不做——那要多一套鉴权与网络风险。
 * 信任标记不在这里：它存在主进程的 approvals.json，渲染层改不动，
 * 免得配置通道变成"自我授权"。
 */
export interface McpServer {
  id: string
  name: string
  /** 旧版整条启动命令（shell 语法）。v0.4.0 起仅作只读原文与失效判定依据，不再用于启动 */
  command: string
  /** v0.4.0 起的启动方式：可执行文件 + 参数数组，spawn 时不经 shell 解释 */
  launch?: { bin: string; args: string[] }
  /** 配置格式版本；缺省视为 1（旧版单命令） */
  formatVersion?: 2
  /** 迁移判定为旧版单命令：已禁用，等用户重填 */
  legacyInvalid?: boolean
  /** 附加环境变量 */
  env?: Record<string, string>
  /** 缺省视为启用 */
  enabled?: boolean
  /** initialize / tools/list / tools/call 的超时（毫秒，默认 15 秒） */
  timeoutMs?: number
  createdAt?: number
}

/** 一次 MCP 连接探测的结果（设置页"连接并查看工具"用） */
export interface McpProbe {
  ok: boolean
  message: string
  tools?: { name: string; description?: string }[]
  serverTitle?: string
  serverVersion?: string
}

/**
 * 保存整表时「这一条没被接受」的回报（hooks:set / mcp:set 共用）。
 *
 * 为什么必须有它：界面那次保存提交的永远是**整表**（拨一个开关也会把整份列表回传），
 * 主进程按条校验后就只有"过滤掉不合格的再落盘"这一种写法——用户碰了一下无关的开关，
 * 一条旧记录（导入来的、手改的、上一个版本写的）就地消失，而且没人告诉他。
 * 拒收本身没错，错的是**静默**：id 用来在界面上点名是哪一条，message 用既有的拒绝原因文案。
 * 落盘那一半的口径见 shared/hooks.partitionHookRules 与 shared/mcp-list.partitionMcpServers。
 */
export interface RejectedEntry {
  /** 被拒条目的 id；条目自己没带 id 时是它在表里的位置（`#3`） */
  id: string
  message: string
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

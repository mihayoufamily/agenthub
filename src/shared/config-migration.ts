// 配置迁移的纯规则层（store.ts 只负责读写盘；规则放这里才能被逻辑层验证覆盖）
import type { McpServer, Prefs, AppConfig } from './types'

/** 当前配置格式头版本：`store.ts` 的迁移链与 importConfig 都以此为准，不再各写各的数字 */
export const SCHEMA_HEAD = 3

/** v1 -> v2 只关心这三项；其余字段原样透传，不做全量 AppConfig 断言 */
export interface McpConfigShape {
  mcpServers?: McpServer[]
  sandboxFallback?: 'auto' | 'ask' | 'off'
  schemaVersion?: number
}

/** v0 -> v1 缺的工作流骨架：谁都没选、审核走人工、预算不设上限（0=不限） */
const defaultWorkflowDefaults: NonNullable<AppConfig['workflowDefaults']> = {
  plannerAgentId: '',
  executorAgentId: '',
  reviewerAgentId: '',
  reviewMode: 'human',
  maxRounds: 3,
  timeoutMin: 30,
  confirmEveryRound: false,
  maxTokens: 0,
  budgetYuan: 0
}

/**
 * v0 -> v1：补齐默认偏好与工作流骨架（旧配置缺的那一层）。
 * 返回结构必须是"**展开 raw 再覆盖必填项**"——以前这里是重新拼一个字面量，只留
 * schemaVersion/prefs/agents/workflowDefaults，任何调用它的路径都会静默丢掉
 * mcpServers/presets/hooks/priceOverrides/skills（导入配置就是踩的这条）。
 * v1->v2、v2->v3 一直住在本纯模块，把它也搬来对齐"迁移规则不进 store"的口径。
 */
export function migrateV0toV1(raw: Partial<AppConfig> & Record<string, unknown>): Partial<AppConfig> & Record<string, unknown> {
  const defaultPrefs: Prefs = {
    theme: 'system',
    animations: true,
    reducedMotion: false,
    replayWelcome: true,
    fontSize: 14,
    sidebarCollapsed: false,
    enterToSend: true,
    shiftWheelSwitch: true,
    firstRunDone: false,
    lastMode: null
  }
  const oldPrefs = (raw.prefs ?? {}) as Partial<Prefs>
  const oldWd = (raw.workflowDefaults ?? {}) as Partial<NonNullable<AppConfig['workflowDefaults']>>
  return {
    ...raw,
    schemaVersion: 1,
    prefs: { ...defaultPrefs, ...oldPrefs },
    agents: (raw.agents as AppConfig['agents']) ?? [],
    workflowDefaults: { ...defaultWorkflowDefaults, ...oldWd }
  }
}

/**
 * MCP 启动方式从"整条 shell 命令"改成 argv。
 * 只有 command 没有 launch 的记录一律标失效、禁用、保留原文——不猜着拆（拆错的命令行比"连不上"更难定位），
 * 也不删（用户重填时至少知道原来填的是什么）。这是用户 2026-10-23 拍定的。
 */
export function migrateV1toV2(raw: McpConfigShape): McpConfigShape {
  const out: McpConfigShape = { ...raw }
  // 只在**真是数组**时才逐条盖章；不是数组（undefined / 对象 / 字符串）就原样透传，不替它编一个 []。
  // 这是有意的：`mcpServers === undefined` 意味着这份配置压根没有 MCP 这一段，迁移层把它变成 []
  // 会凭空写出一段"用户删过所有 server"的语义；消费方（mcp:list / 设置页 / ipc.ts 挑 server）
  // 各自负责挡脏数据。已被 fixes-check [W] 断言钉住（`没有 mcpServers 的旧配置照样能迁移，不抛异常`
  // + `null / 字符串 / 数字元素原样透传…`），评审 Task 2 ⑩ 要的是把这条意图写在这儿。
  if (Array.isArray(raw.mcpServers)) {
    out.mcpServers = raw.mcpServers.map((s) => {
      // 脏数据（config.json 被手改过、或被更早的版本写坏）原样透传：
      // 对 null 解引用会抛 TypeError 掀掉整个 getConfig()（它外面没有 try/catch），
      // 对字符串/数字做 { ...s } 会伪造出一条 {0:'x',legacyInvalid:true,enabled:false} 的假记录并写回磁盘。
      // 挡脏数据是消费者的活（ipc.ts 挑 server 已经用 !!s；mcp:list 与设置页列表还没有，留给 Task 3/4），
      // 迁移层不认的记录也别替它编一个出来。
      if (!s || typeof s !== 'object') return s
      const bin = typeof s.launch?.bin === 'string' ? s.launch.bin.trim() : ''
      return bin
        ? { ...s, legacyInvalid: false, formatVersion: 2 as const }
        : { ...s, legacyInvalid: true, enabled: false }
    })
  }
  if (out.sandboxFallback !== 'auto' && out.sandboxFallback !== 'ask' && out.sandboxFallback !== 'off') {
    out.sandboxFallback = 'auto'
  }
  return out
}

/**
 * 导入配置时的规范化：跑完整条迁移链，并把版本号盖成 SCHEMA_HEAD。
 * 关键约定是**保留未知键**——v0.3.0 的 importConfig 走的是"重建字面量"式迁移（只留
 * schemaVersion/prefs/agents/workflowDefaults），导入任何配置都会静默丢掉
 * mcpServers / presets / hooks / priceOverrides / skills。这里只做透传式合并，一个键都不丢。
 * 结构补齐（prefs、agents、workflowDefaults 的默认值）由调用方先跑 v0->v1 再进来。
 */
/**
 * v2 → v3：Agent 级 Skill 绑定（`skillIds` / `skillMode`）。
 * 只给 `skillMode` 补一个与"加字段之前"完全等价的缺省值（reference），**不凭空造 skillIds**——
 * 造出来等于替用户绑了东西。老记录没有这两个字段时行为不变。
 */
export function migrateV2toV3(cfg: Record<string, unknown>): Record<string, unknown> {
  const agents = Array.isArray(cfg.agents) ? (cfg.agents as Record<string, unknown>[]) : null
  if (!agents) return { ...cfg, schemaVersion: 3 }
  return {
    ...cfg,
    schemaVersion: 3,
    agents: agents.map((a) => (a && typeof a === 'object' ? { ...a, skillMode: a.skillMode === 'auto' ? 'auto' : 'reference' } : a))
  }
}

export function normalizeImported<T extends Record<string, unknown>>(incoming: T): T {
  const merged: T = { ...incoming }
  const stepped = migrateV1toV2(merged as unknown as McpConfigShape)
  return migrateV2toV3({ ...merged, ...stepped, schemaVersion: SCHEMA_HEAD }) as T
}

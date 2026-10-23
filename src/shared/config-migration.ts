// 配置迁移的纯规则层（store.ts 只负责读写盘；规则放这里才能被逻辑层验证覆盖）
import type { McpServer } from './types'

/** 当前配置格式头版本：`store.ts` 的迁移链与 importConfig 都以此为准，不再各写各的数字 */
export const SCHEMA_HEAD = 2

/** v1 -> v2 只关心这三项；其余字段原样透传，不做全量 AppConfig 断言 */
export interface McpConfigShape {
  mcpServers?: McpServer[]
  sandboxFallback?: 'auto' | 'ask' | 'off'
  schemaVersion?: number
}

/**
 * MCP 启动方式从"整条 shell 命令"改成 argv。
 * 只有 command 没有 launch 的记录一律标失效、禁用、保留原文——不猜着拆（拆错的命令行比"连不上"更难定位），
 * 也不删（用户重填时至少知道原来填的是什么）。这是用户 2026-10-23 拍定的。
 */
export function migrateV1toV2(raw: McpConfigShape): McpConfigShape {
  const out: McpConfigShape = { ...raw }
  if (Array.isArray(raw.mcpServers)) {
    out.mcpServers = raw.mcpServers.map((s) => {
      // 脏数据（config.json 被手改过、或被更早的版本写坏）原样透传：
      // 对 null 解引用会抛 TypeError 掀掉整个 getConfig()（它外面没有 try/catch），
      // 对字符串/数字做 { ...s } 会伪造出一条 {0:'x',legacyInvalid:true,enabled:false} 的假记录并写回磁盘。
      // 消费者侧（ipc.ts 挑 server、设置页列表）本来就用 !!s 挡脏数据，这里保持一致、不替它编数据。
      if (!s || typeof s !== 'object') return s
      const bin = typeof s.launch?.bin === 'string' ? s.launch.bin.trim() : ''
      return bin
        ? { ...s, legacyInvalid: false, formatVersion: SCHEMA_HEAD as 2 }
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
export function normalizeImported<T extends Record<string, unknown>>(incoming: T): T {
  const merged: T = { ...incoming }
  const stepped = migrateV1toV2(merged as unknown as McpConfigShape)
  return { ...merged, ...stepped, schemaVersion: SCHEMA_HEAD } as T
}

// 配置迁移的纯规则层（store.ts 只负责读写盘；规则放这里才能被逻辑层验证覆盖）
import type { McpServer } from './types'

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
      const bin = typeof s.launch?.bin === 'string' ? s.launch.bin.trim() : ''
      return bin ? { ...s, legacyInvalid: false, formatVersion: 2 as const } : { ...s, legacyInvalid: true, enabled: false }
    })
  }
  if (out.sandboxFallback !== 'auto' && out.sandboxFallback !== 'ask' && out.sandboxFallback !== 'off') {
    out.sandboxFallback = 'auto'
  }
  return out
}

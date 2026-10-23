/**
 * 渲染层读取 MCP server 列表的唯一形状闸门（ipc.ts 的 mcp:list 走这里，组件里不再各自挡）。
 *
 * 为什么需要：任务 2 的迁移层对手改坏的 config.json 元素是**刻意原样透传**的
 * （null 解引用会掀掉整个 getConfig()，字符串被 { ...s } 展开会伪造记录写回盘），
 * 脏数据因此能活到 mcp:list——SettingsPage 的 probes[s.id]/key={s.id}、ChatView 的
 * mcpIds.includes(s.id) 都是直接解引用，会在渲染层当场抛。本仓库既有约定是消费者挡脏数据
 * （ipc.ts 挑 server 用 !!s），这里把这道消费者闸门做成可断言的纯函数。
 * 不放在 mcp.ts：那是主进程模块，逻辑层测试不该为断言形状闸门去起 MCP 代码。
 */
import type { McpServer } from './types'

/** 形状正确 = 非空对象 + 字符串 id。其余（null、字符串、数字、没 id 的残片）一律不收 */
function isWellFormed(s: unknown): s is McpServer {
  return !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string'
}

/**
 * 与加载期迁移（migrateV1toV2）同一口径的现场判定 + 渲染层安全补形：
 * ① launch 只要存在就必须是"能用"的形状——args 缺失/不是数组规范成 []，launch 本体是脏值
 *   （手改出来的字符串/数组）按缺失处理。渲染层直接解引用 `s.launch.args.join(' ')`
 *   （SettingsPage 列表行），bin 填了而 args 没了的记录原样放行会在设置页当场炸 TypeError；
 *   主进程对同一个输入在使用点各自兜了底（mcp.ts planSpawn、ipc.ts 信任弹窗标签），
 *   本模块自称渲染层唯一闸门，补形就得在这里做，组件里才真的"不再各自挡"。
 * ② 只有 command、launch.bin 为空的记录标失效并停用（与加载期迁移同一口径）；
 *   迁移链只在 schemaVersion<2 时跑一遍，之后经 mcp:set 或手改进配置的旧格式记录要靠这里
 *   补同一面横幅；main 侧 planSpawn 本来就拒收，不靠这个标记把关。
 * 幂等：补形/打标跑两遍与一遍逐字节相同（不重排键，界面"配置已还原"的 JSON 对比才稳）。
 */
export function stampMcpLegacy(s: McpServer): McpServer {
  const bin = typeof s.launch?.bin === 'string' ? s.launch?.bin.trim() : ''
  let out = s
  const l = out.launch as unknown
  if (l !== undefined && l !== null) {
    if (typeof l !== 'object' || Array.isArray(l)) out = { ...out, launch: undefined }
    else if (!Array.isArray((l as { args?: unknown }).args)) out = { ...out, launch: { ...(l as { bin: string }), args: [] } }
  }
  if (bin) return out.legacyInvalid ? { ...out, legacyInvalid: false } : out
  if (!(out.command ?? '').trim()) return out
  if (out.legacyInvalid === true && out.enabled === false) return out
  return { ...out, legacyInvalid: true, enabled: false }
}

/** 过滤脏元素 + 补旧格式标记；不是数组（config.json 被手改成别的类型）就当没有 */
export function sanitizeMcpList(list: unknown): McpServer[] {
  if (!Array.isArray(list)) return []
  return list.filter(isWellFormed).map(stampMcpLegacy)
}

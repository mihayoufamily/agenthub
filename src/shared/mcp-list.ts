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
import type { McpServer, RejectedEntry } from './types'

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

/**
 * 一张 mcpServers 表"界面上"最多加多少条。**只作用于新增那一关**（设置页的「添加并探测」到上限就禁用），
 * 不再作用于落盘：保存整表时按条数截断，等于替用户删掉表尾的 server（连带它的信任一起作废）——
 * 而这正是本闸门要消灭的那类静默（与 shared/hooks.HOOK_RULES_MAX 同一取向）。
 */
export const MCP_SERVERS_MAX = 20

/**
 * 形状不合格（名称为空，且 command 与 launch.bin 都为空）时的拒收原因。
 * 与设置页「添加并探测」按钮上既有的那句是**同一份**（SettingsPage 直接引这个常量），
 * 免得"表单里说 A、保存时说 B"。
 */
export const MCP_SHAPE_REJECT_MESSAGE = '名称与启动命令都要填'

/** 形状合格 = 有名称，且 command 与 launch.bin 至少填了一个（与旧 handler 的 filter 同一口径） */
function isShapedEntry(raw: unknown): raw is McpServer {
  if (!raw || typeof raw !== 'object') return false
  const s = raw as Partial<McpServer>
  if (typeof s.name !== 'string' || !s.name.trim()) return false
  const hasCommand = typeof s.command === 'string' && !!s.command.trim()
  const hasBin = typeof s.launch?.bin === 'string' && !!s.launch.bin.trim()
  return hasCommand || hasBin
}

/**
 * `mcp:set` 的落盘闸门（修复波 A · 项 3）。返回「该存什么」与「哪些条目没被接受、为什么」。
 *
 * 旧写法是 `.filter(形状).slice(0, 20).map(stampMcpLegacy)`：第 21 条被 .slice 静默丢掉。
 * 界面那次 save 提交的永远是整表（拨一个"启用"开关也会把整份列表回传），
 * 所以用户加到第 21 个 server 时看到的是"保存成功但列表里没了"——最难查的那一类。
 * 拒收本身没错，错的是**静默**：现在每一条被拒的都点名回界面。
 *
 * 落盘口径与 hooks 那一侧**刻意不同**，理由是读路径不同：`mcp:list` 走 sanitizeMcpList，
 * 形状不合格的记录本来就不会回到渲染层，把它们留在配置里只会造成"存了但界面看不见、
 * 下一次整表 save 又把它覆盖掉"，比明确拒收更坏；hooks:list 是原样返回整表的，
 * 所以那一侧保留被拒条目（不删用户数据，见 shared/hooks.partitionHookRules）。
 * 这里的形状不合格＝名称空且两个命令位都空，是"一行空表单"，不含用户数据。
 * 补形与旧格式打标沿用同一个 stampMcpLegacy，缺 id 的合法记录由这里补一个
 * （原来这半句写在 handler 的 .map 里，搬进闸门后不能丢）。
 */
export function partitionMcpServers(list: unknown): { kept: McpServer[]; rejected: RejectedEntry[] } {
  const incoming: unknown[] = Array.isArray(list) ? list : []
  const kept: McpServer[] = []
  const rejected: RejectedEntry[] = []
  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i]
    const id = String((raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined) ?? `#${i + 1}`)
    if (!isShapedEntry(raw)) {
      rejected.push({ id, message: MCP_SHAPE_REJECT_MESSAGE })
      continue
    }
    kept.push(stampMcpLegacy({ ...raw, id: raw.id || `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` }))
  }
  return { kept, rejected }
}

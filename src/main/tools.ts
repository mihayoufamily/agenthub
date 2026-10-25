// 模型 Agent 工具层：沙箱文件操作 + 编辑增强 + 命令执行 + 联网（Agent 级授权制）
// 所有文件路径在沙箱根（ToolGrant.dir）内规范化校验，逃逸即拒绝；
// 命令以沙箱根为工作目录运行，超时与输出有上限，全程记录可追溯。
// 联网工具（web_fetch/web_search）需用户在授权面板单独开启（allowWeb）。
import { promises as fs, realpathSync } from 'node:fs'
import { resolve as resolvePath, dirname, sep, relative } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import type { ToolGrant } from '../shared/types'
import type { ApprovalDecision, FileChange, HookRun } from '../shared/types'
import { checkCommand } from '../shared/approvals'
import { isWriteTool, planModeVerdict } from '../shared/plan-mode'
import { relativeOf, beforeChange as cpBefore, record as cpRecord, diffOfFile, diffLines } from './checkpoints'
import { runShell, MAX_OUTPUT } from './shell'
import { runHooks } from './hooks'

const MAX_READ = 200 * 1024 // 读文件上限
const MAX_WRITE = 1024 * 1024 // 写文件上限
const MAX_LIST = 500 // 列目录条目上限
export { MAX_OUTPUT } // 工具结果上限（shell.ts 定义，openai 适配层按此截断）
const CMD_TIMEOUT_MS = 60_000 // 命令超时
const MAX_SEARCH_HITS = 100 // 文本搜索匹配上限
const MAX_GLOB = 200 // 通配符匹配文件上限
const MAX_GLOB_LEN = 200 // 通配符模式长度上限（模型可控输入）
const WEB_TIMEOUT_MS = 20_000 // 联网请求超时
const MAX_WEB_BODY = 200 * 1024 // 联网响应体上限
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AgentHub/0.2'
/** 遍历时跳过的目录（对齐常见工程习惯，避免把依赖/版本库翻出来） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'out', 'release'])

/** 段内通配匹配（* 任意字符、? 单字符）：双指针回溯，O(n·m)；不用正则故不存在灾难性回溯 */
function matchSegment(pat: string, s: string): boolean {
  let p = 0
  let i = 0
  let star = -1
  let mark = 0
  while (i < s.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p].toLowerCase() === s[i].toLowerCase())) { p++; i++ }
    else if (p < pat.length && pat[p] === '*') { star = p; p++; mark = i }
    else if (star >= 0) { p = star + 1; i = ++mark }
    else return false
  }
  while (p < pat.length && pat[p] === '*') p++
  return p === pat.length
}

/**
 * 编译路径通配：** 跨目录段（含零段）、* 段内、? 单字符，大小写不敏感（Windows 习惯）。
 * 按段推进"可能位置集合"，复杂度是多项式——模式由模型可控，
 * 用正则会留下 `*a*a*a*b` 这类灾难性回溯打爆主进程的口子。
 * 模式为空或超长返回 null（调用方据此拒绝）。
 */
function compileGlob(pattern: unknown): ((relPath: string) => boolean) | null {
  if (typeof pattern !== 'string') return null
  const g = pattern.trim()
  if (!g || g.length > MAX_GLOB_LEN) return null
  const segs = g.split(/[\\/]/).filter(Boolean)
  if (segs.length === 0) return null
  return (relPath: string) => {
    const target = relPath.split(/[\\/]/).filter(Boolean)
    let cur = new Set<number>([0])
    for (const seg of segs) {
      const next = new Set<number>()
      if (seg === '**') {
        for (const j of cur) for (let k = j; k <= target.length; k++) next.add(k)
      } else {
        for (const j of cur) if (j < target.length && matchSegment(seg, target[j])) next.add(j + 1)
      }
      if (next.size === 0) return false
      cur = next
    }
    return cur.has(target.length)
  }
}

/** 递归收集沙箱内全部文件的相对路径（跳过 SKIP_DIRS；上限保护） */
async function walkRelPaths(root: string, dir: string, out: string[], limit = 5000): Promise<void> {
  if (out.length >= limit) return
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= limit) return
    if (e.name.startsWith('.') && SKIP_DIRS.has(e.name.toLowerCase())) continue
    const abs = resolvePath(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue
      await walkRelPaths(root, abs, out, limit)
    } else if (e.isFile()) {
      out.push(relative(root, abs).replace(/\\/g, '/'))
    }
  }
}

/** HTML 粗转文本：剥 script/style/标签、基础实体解码（轻量，不做完整 markdown 化） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim()
}

/** 判定主机是否非公网（环回/内网/链路本地/组播/保留）——SSRF 拦截 */
function isNonPublicHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  const v4 = h.match(/^(?:\d{1,3}\.){3}\d{1,3}$/)?.[0] ?? h.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/)?.[1]
  if (v4) {
    const [a, b] = v4.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && (b === 168 || b === 0)) return true
  }
  return false
}

/**
 * 校验外链 URL：仅 http/https，且主机不得指向本机/内网（SSRF）。
 * 域名会做一次 DNS 解析复核，拦掉 localtest.me 这类"公网名字指向 127.0.0.1"的把戏。
 * 残留限制（如实记录）：解析与真实请求之间存在重新解析窗口，DNS rebinding 无法在本层彻底消除。
 */
async function safeWebUrl(raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (isNonPublicHost(u.hostname)) return null
  try {
    const addrs = await dnsLookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true })
    if (addrs.length === 0 || addrs.some((a) => isNonPublicHost(a.address))) return null
  } catch { return null }
  return u.toString()
}

/** 流式读取响应体到上限即停：不整体缓冲，超大/无限响应不会撑爆主进程（会卡住整个应用） */
async function readBodyCapped(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let len = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const s = decoder.decode(value, { stream: true })
      if (len + s.length > limit) {
        parts.push(s.slice(0, Math.max(0, limit - len)))
        len = limit
        truncated = true
        break
      }
      parts.push(s)
      len += s.length
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => { /* 已放弃剩余内容 */ })
  }
  return { text: parts.join(''), truncated }
}

/**
 * 联网 GET（web_fetch / web_search 共用）：SSRF 校验 + 跳转后按最终地址复核 + 流式限量读取。
 * 用 redirect:'follow' 而非 'manual'：Electron net 的 manual 语义不保证能读到 Location，
 * 逐跳手工跟随会把常见的 301/302 页面变成失败；改为跟随后用 res.url 复核最终落点。
 * 残留限制：跳转到内网的那次请求本身仍已发出（盲 SSRF），但响应体一律不外传给模型。
 */
async function webGet(
  rawUrl: string,
  signal: AbortSignal | undefined,
  accept: string
): Promise<
  | { ok: true; contentType: string; text: string; truncated: boolean }
  | { ok: false; output: string }
> {
  const url = await safeWebUrl(rawUrl)
  if (!url) return { ok: false, output: '拒绝：URL 为空、不是 http/https 链接，或指向本机/内网地址（SSRF 已拦截）' }
  const { net } = require('electron') as typeof import('electron')
  const fetchSignal = signal ? AbortSignal.any([AbortSignal.timeout(WEB_TIMEOUT_MS), signal]) : AbortSignal.timeout(WEB_TIMEOUT_MS)
  const res = await net.fetch(url, {
    redirect: 'follow',
    signal: fetchSignal,
    headers: { 'User-Agent': WEB_UA, Accept: accept }
  }).catch((e: unknown) => ({ err: e as Error }))
  if ('err' in res && res.err) return { ok: false, output: `请求失败：${res.err.message}` }
  const r = res as Response
  if (!(await safeWebUrl(r.url || url))) return { ok: false, output: '拒绝：跳转后指向本机/内网地址（SSRF 已拦截，响应体未外传）' }
  if (!r.ok) return { ok: false, output: `HTTP ${r.status} ${r.statusText}` }
  const { text, truncated } = await readBodyCapped(r, MAX_WEB_BODY)
  return { ok: true, contentType: r.headers.get('content-type') ?? '', text, truncated }
}

/** 取一条工具定义的函数名（OpenAI function calling 是嵌套形状：{ type, function: { name } }） */
function defName(def: unknown): string {
  const fn = (def as { function?: { name?: unknown } } | undefined)?.function
  return typeof fn?.name === 'string' ? fn.name : ''
}

/** OpenAI function calling 工具定义（发给模型的 schema；命令执行与联网仅授权后可见） */
export function toolDefs(allowCommands: boolean, allowWeb: boolean, planMode?: boolean): unknown[] {
  const defs: unknown[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取沙箱目录内的文本文件内容',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '相对沙箱根的路径，如 "notes/todo.md"' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '在沙箱目录内写入文本文件（覆盖已有内容；父目录自动创建）',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对沙箱根的路径' },
            content: { type: 'string', description: '文件全文内容' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出沙箱目录内某子目录的条目（名称/类型/大小）',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '相对沙箱根的目录路径，空串表示根目录' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: '删除沙箱目录内的文件或空目录（移入系统回收站，可恢复）',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '相对沙箱根的路径' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move',
        description: '移动或重命名沙箱目录内的文件/目录（源与目标都必须在沙箱内）',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '相对沙箱根的原路径' },
            to: { type: 'string', description: '相对沙箱根的目标路径' }
          },
          required: ['from', 'to']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: '在沙箱目录内递归搜索文本（类似 grep）：返回 文件:行号: 匹配行。可用 glob 过滤文件范围',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '搜索的文本片段（或正则，需 is_regex=true）' },
            is_regex: { type: 'boolean', description: '默认 false 按普通文本搜索；true 时 pattern 按正则解析（非法正则会被拒绝）' },
            glob: { type: 'string', description: '可选文件过滤，如 "**/*.md" 仅搜 markdown；支持 ** * ?' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'glob_files',
        description: '按通配符列出沙箱目录内匹配的文件（支持 ** * ?，如 "src/**/*.ts"）',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: '通配符模式，如 "**/*.md"' } },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description: '在沙箱内某文件中做精准文本替换：默认要求目标片段在文件中唯一（出现多次会拒绝，需更长上下文或 replace_all）',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对沙箱根的路径' },
            find: { type: 'string', description: '要查找的原文（含足够上下文以保证唯一）' },
            replace: { type: 'string', description: '替换后的文本' },
            replace_all: { type: 'boolean', description: '默认 false；true 时替换全部出现' }
          },
          required: ['path', 'find', 'replace']
        }
      }
    }
  ]
  if (allowCommands) {
    defs.push({
      type: 'function',
      function: {
        name: 'run_command',
        description: '在沙箱目录内执行一条 shell 命令（Windows 系统，shell 为 cmd.exe；工作目录为沙箱根；超时 60 秒）。用于构建、测试、环境检查等。注意：请使用 Windows 兼容的命令语法（如 where 而非 command -v）',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '完整命令行' } },
          required: ['command']
        }
      }
    })
  }
  if (allowWeb) {
    defs.push(
      {
        type: 'function',
        function: {
          name: 'web_fetch',
          description: '抓取一个 http/https 网页并转为纯文本（HTML 会剥离标签；JSON/纯文本原样返回）。上限 200KB，超限停止下载并标注截断；本机/内网地址一律拒绝',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '完整 URL（http/https）' } },
            required: ['url']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: '联网搜索（DuckDuckGo，无需 Key）：返回前 8 条结果的标题、链接与摘要',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: '搜索词' } },
            required: ['query']
          }
        }
      }
    )
  }
  // 计划态连"能调什么"的清单里都不留写类工具：只靠执行期拒绝，模型会反复试同一堵墙
  if (planMode === true) return defs.filter((d) => !isWriteTool(defName(d)))
  return defs
}

/** 沙箱校验：路径规范化后必须仍在沙箱根内（防 ../ 逃逸与绝对路径注入）；返回原始大小写路径。
 *  access='full'（完全访问）时跳过目录限制：路径仍规范化（防相对歧义），但允许全盘。 */
function sandboxPath(grant: ToolGrant, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null
  const abs = resolvePath(grant.dir || '.', rel)
  if (grant.access === 'full') return abs
  const root = resolvePath(grant.dir)
  const rootLow = root.toLowerCase()
  const low = abs.toLowerCase()
  if (low !== rootLow && !low.startsWith(rootLow + sep)) return null
  // 符号链接解析校验：词法前缀校验发现不了沙箱内的 symlink/junction 指向外部，
  // 解析最近已存在祖先的真实路径后再校验一次（write_file 等新建场景祖先不存在时跳过）
  try {
    let real = abs
    for (;;) {
      try {
        real = realpathSync(real)
        break
      } catch {
        const parent = dirname(real)
        if (parent === real) break // 已到卷根仍不存在：纯新建路径，无链接可逃逸
        real = parent
      }
    }
    const realLow = real.toLowerCase()
    if (realLow !== rootLow && !realLow.startsWith(rootLow + sep)) return null
  } catch { /* realpath 异常不阻塞：词法校验已通过 */ }
  return abs
}

/** 字面量替换首个匹配（不走 String.replace 的 $ 模式解释，避免 $&/$1 被当作替换模式） */
function replaceFirstLiteral(text: string, find: string, replace: string): string {
  const i = text.indexOf(find)
  if (i < 0) return text
  return text.slice(0, i) + replace + text.slice(i + find.length)
}

/** 文件此刻是否存在（决定这次算"改"还是"新建"） */
async function existsFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

export interface ToolExecResult {
  ok: boolean
  /** 结果文本：成功时为内容/输出摘要；失败时为拒绝/错误原因（会回传给模型） */
  output: string
  /** write_file 成功时的绝对路径（工作流登记 artifacts 用） */
  writtenPath?: string
  /** 本次改动登记（有检查点时）：界面据此显示 diff 与"能不能回滚" */
  change?: FileChange
  /** 跑过的 Hook 记录（含被否决的原因），界面与模型都能看到 */
  hooks?: HookRun[]
}

/**
 * 命令审批闸门（由调用方注入，主进程 approvals.ts 实现）。
 * rules 用函数取而不是数组：用户点「始终允许」后规则当场变了，
 * 同一条流里后续同类命令应当直接放行，不该还拿着旧快照问第二遍。
 */
export interface CommandApprover {
  rules: () => string[]
  ask: (info: {
    tool: string
    command: string
    reason: string
    uncovered: string[]
    /** 'diff' = 写前预览（界面不显示"始终允许"，覆盖一次算一次） */
    kind?: 'command' | 'diff'
    diff?: string
  }) => Promise<ApprovalDecision>
}

/** 工具执行的外挂：命令审批 + 改动检查点 + 用户 Hook（都由调用方按场景注入） */
export interface ToolHooks {
  approver?: CommandApprover
  /** 检查点 id：有值则在文件改动前备份原件并登记变更，之后可整体回滚 */
  checkpoint?: string
  /** 用户配置的工具前后 Hook（pre 可否决本次调用） */
  userHooks?: import('../shared/types').HookRule[]
  meta?: { agentId?: string; agentName?: string; runId?: string; reqId?: string }
}

/**
 * 工具执行入口：先跑 pre Hook（可否决），再执行沙箱逻辑，最后跑 post Hook。
 * Hook 记录与说明拼进结果文本，模型和界面看到的是同一份，不会一边知道一边不知道。
 */
export async function execTool(
  grant: ToolGrant,
  tool: string,
  argsJson: string,
  signal?: AbortSignal,
  hooks?: ToolHooks
): Promise<ToolExecResult> {
  // 计划态连用户 Hook 都不跑：Hook 是"每次工具调用时代你执行"的任意命令，它自己就能写盘，
  // 而"批准前不产生文件改动"是这一轮唯一的承诺——宁可这一轮不执行你配的命令，
  // 也不让它绕过这道闸。代价如实写在界面上：这一轮 Hook 的否决与审计都不生效。
  const hookCtx = {
    tool,
    argsJson,
    dir: grant.dir,
    ...(hooks?.meta?.agentId ? { agentId: hooks.meta.agentId } : {}),
    ...(hooks?.meta?.agentName ? { agentName: hooks.meta.agentName } : {}),
    ...(hooks?.meta?.runId ? { runId: hooks.meta.runId } : {}),
    ...(hooks?.meta?.reqId ? { reqId: hooks.meta.reqId } : {})
  }
  // post 同样用这份过滤后的表——计划轮一条 Hook 都不跑，pre/post 都算；
  // 只拦 pre 的话每次只读调用后用户 Hook 照跑，写盘口子还开着。
  const userHooks = grant.planMode === true ? [] : hooks?.userHooks
  const pre = await runHooks('pre', userHooks, hookCtx, signal)
  if (pre.blocked) {
    return { ok: false, output: `拒绝：Hook 否决了这次调用。\n${pre.notes.join('\n')}`, ...(pre.runs.length ? { hooks: pre.runs } : {}) }
  }
  const res = await dispatch(grant, tool, argsJson, signal, hooks)
  const post = await runHooks(
    'post',
    userHooks,
    { ...hookCtx, result: { ok: res.ok, output: res.output, ...(res.writtenPath ? { writtenPath: res.writtenPath } : {}) } },
    signal
  )
  const runs = [...pre.runs, ...post.runs]
  if (!runs.length) return res
  // pre 的脚本输出也要带上去：放行不等于无声——审计时"谁跑过、说了什么"要能查到
  const notes = [...pre.notes, ...post.notes]
  return {
    ...res,
    output: `${res.output}${notes.length ? `\n\n${notes.join('\n')}` : ''}`,
    hooks: runs
  }
}

/** 沙箱与审批本体（不含 Hook）：单独拆出来让 Hook 层能包在它外面 */
async function dispatch(
  grant: ToolGrant,
  tool: string,
  argsJson: string,
  signal?: AbortSignal,
  hooks?: ToolHooks
): Promise<ToolExecResult> {
  const approver = hooks?.approver
  const cp = hooks?.checkpoint
  /** 改动前备份：返回"没备份成"的原因（越界/超上限），界面要如实显示。
   *  rel=null 只表示"没有相对工作目录的路径可记"（完全访问模式下的目录外改动，或没开检查点），
   *  调用方不能因此把整条 change 丢掉——unbacked 警示必须随登记到界面；rel 字段用绝对路径占位即可（纯显示字符串）。 */
  const backup = async (abs: string): Promise<{ rel: string | null; unbacked?: string }> => {
    if (!cp) return { rel: null }
    const rel = relativeOf(grant.dir || '.', abs)
    if (rel === null) return { rel: null, unbacked: '完全访问模式下的目录外改动，不进入回滚清单' }
    const b = await cpBefore(cp, abs)
    return { rel, ...(b.backed || !b.reason ? {} : { unbacked: b.reason }) }
  }
  /** 改动后登记（登记失败不影响本次工具结果） */
  const track = (change: FileChange | null) => {
    if (cp && change) cpRecord(cp, change)
  }
  let args: Record<string, unknown> = {}
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    return { ok: false, output: `参数不是合法 JSON：${argsJson.slice(0, 200)}` }
  }
  if (signal?.aborted) return { ok: false, output: '已取消：工具执行被用户停止' }
  // 计划态闸门：一处拦，不在每个 case 里各写一遍（漏一个 case 就是静默放行）。
  // 放在 dispatch 而不是 execTool 开头：用户的 Hook 仍能看见这次"被计划态拒掉"的尝试，审计不缺一段。
  const planGate = planModeVerdict(tool, grant.planMode)
  if (!planGate.allowed) return { ok: false, output: `拒绝：${planGate.reason}` }
  try {
    switch (tool) {
      case 'read_file': {
        const p = sandboxPath(grant, args.path)
        if (!p) return { ok: false, output: `拒绝：路径越界或为空（仅限沙箱目录内）` }
        let text = await fs.readFile(p, 'utf8')
        if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + `\n…（内容超过 ${MAX_READ} 字节，已截断）`
        return { ok: true, output: text || '（空文件）' }
      }
      case 'write_file': {
        const p = sandboxPath(grant, args.path)
        if (!p) return { ok: false, output: `拒绝：路径越界或为空（仅限沙箱目录内）` }
        const content = typeof args.content === 'string' ? args.content : ''
        if (content.length > MAX_WRITE) return { ok: false, output: `拒绝：内容超过 ${MAX_WRITE / 1024}KB 上限` }
        // diff 与备份都必须在写盘之前取，否则备份的是已经改坏的内容、diff 永远为空
        const diff = await diffOfFile(p, content)
        const existed = await existsFile(p)
        if (grant.previewWrites && existed && approver) {
          const d = await approver.ask({
            tool: 'write_file', command: p, uncovered: [], kind: 'diff',
            reason: '这次写入会覆盖已有文件，先看清改了什么', diff: diff ?? undefined
          })
          if (signal?.aborted) return { ok: false, output: '已取消：工具执行被用户停止' }
          if (d === 'deny') return { ok: false, output: '拒绝：用户取消了这次写入（文件保持原样）' }
        }
        const kind: FileChange['kind'] = existed ? 'modified' : 'created'
        const bk = await backup(p)
        await fs.mkdir(dirname(p), { recursive: true })
        await fs.writeFile(p, content, 'utf8')
        // 目录外（完全访问）改动 rel=null 也要登记，rel 用绝对路径占位（纯显示字符串，
        // summarize 的 unbacked 清单按 e.rel 展示正好）——"不进入回滚清单"的警示要能到界面，
        // 整条置 null 就是死代码。回滚语义：这类条目不在 m.backed 里，rollback ①②不会碰它；
        // 唯一例外是 kind='created'——rollback ③ 的 resolvePath(m.dir, 绝对rel) 得回绝对路径，
        // 会删掉目录外新建文件，正是"回到任务开始前"的正确行为；modified 无备份、只列出不可还原，
        // 与 README"完全访问模式下的目录外改动不纳入回滚"的口径对齐（那条讲的是还原，可见这半边由本条补上）。
        // 没开检查点时（rel=null 且无警示）维持不登记，与旧行为一致。
        const change = bk.rel === null && !bk.unbacked ? null : { rel: bk.rel ?? p, path: p, kind, diff, bytes: content.length, ...(bk.unbacked ? { unbacked: bk.unbacked } : {}) }
        track(change)
        return { ok: true, output: `已写入 ${content.length} 字符`, writtenPath: p, ...(change ? { change } : {}) }
      }
      case 'list_dir': {
        const p = sandboxPath(grant, args.path === '' || args.path === undefined ? '.' : args.path)
        if (!p) return { ok: false, output: `拒绝：路径越界（仅限沙箱目录内）` }
        const entries = await fs.readdir(p, { withFileTypes: true })
        const lines: string[] = []
        for (const e of entries.slice(0, MAX_LIST)) {
          if (e.isDirectory()) lines.push(`${e.name}/`)
          else {
            try {
              const st = await fs.stat(resolvePath(p, e.name))
              lines.push(`${e.name} (${st.size}B)`)
            } catch {
              lines.push(e.name)
            }
          }
        }
        if (entries.length > MAX_LIST) lines.push(`…共 ${entries.length} 条，仅显示前 ${MAX_LIST}`)
        return { ok: true, output: lines.join('\n') || '（空目录）' }
      }
      case 'delete_file': {
        const p = sandboxPath(grant, args.path)
        if (!p) return { ok: false, output: `拒绝：路径越界或为空（仅限沙箱目录内）` }
        const bk = await backup(p)
        const { shell } = require('electron') as typeof import('electron')
        await shell.trashItem(p)
        // 同 write_file：目录外删除也登记（rel 绝对路径占位），警示到界面；不在 backed 里、
        // 回滚没有针对 deleted 的分支，只列出、不可还原
        const change = bk.rel === null && !bk.unbacked ? null : { rel: bk.rel ?? p, path: p, kind: 'deleted' as const, diff: null, ...(bk.unbacked ? { unbacked: bk.unbacked } : {}) }
        track(change)
        return { ok: true, output: '已移入回收站', ...(change ? { change } : {}) }
      }
      case 'move': {
        const from = sandboxPath(grant, args.from)
        const to = sandboxPath(grant, args.to)
        if (!from || !to) return { ok: false, output: `拒绝：源或目标路径越界（仅限沙箱目录内）` }
        const bk = await backup(from)
        // 目标已存在时 rename 是静默覆盖（Windows 上带 REPLACE_EXISTING 语义）：被覆盖的目标
        // 原件同样要在改前 copy-on-write 备份，否则它不进检查点、无处恢复——"工具层每次改文件前
        // 备份原件"的承诺对被覆盖方一样成立。diff 拍成"全删"（旧内容 vs 空串），界面能看到丢的是什么。
        const toExisted = await existsFile(to)
        const toDiff = toExisted ? await diffOfFile(to, '') : null
        const toBk = toExisted ? await backup(to) : null
        await fs.mkdir(dirname(to), { recursive: true })
        await fs.rename(from, to)
        const fromRel = relativeOf(grant.dir || '.', from)
        // rel 记目标、from 记来源：回滚按"把目标挪回来源"处理（备份的是来源原件）
        const toRel = relativeOf(grant.dir || '.', to)
        // 目标在目录外（完全访问）也登记，rel 用绝对路径占位：rollback ② 的
        // resolvePath(m.dir, 绝对rel) 得回绝对路径，照样把目标挪回来源（回到任务开始前）；
        // 来源在目录外时 fromRel 为 null、不写 from，② 无从挪回，靠 bk.unbacked 如实警示。
        const change = {
          rel: toRel ?? to, path: to, kind: 'moved' as const, from: fromRel ?? undefined, diff: null,
          ...(bk.unbacked ? { unbacked: bk.unbacked } : {})
        }
        track(change)
        // 被覆盖目标单独登记一条 modified（record 按 path+kind 去重，与 moved 条目共存不互相顶掉；
        // bytes 不适用——写进的字节数属于 moved 那条语义，这里只记"原目标内容没了"，FileChange.bytes
        // 可选、直接省掉，不造假数字）。回滚顺序自证：rollback 先 ②（把 to 挪回 from——此刻 from
        // 空缺、to 存在，前提成立），再 ①（backed 里有 toRel 的原件 → 拷回 to，还原被覆盖前的目标
        // 内容）。若 ① 先行，fromRel 的原件会把 from 提前重建，② 的 !existsSync(from) 失效被跳过——
        // 一旦 to 的备份没成功（超上限），被覆盖原件就永远留在挪不回位置的 to 里；② 在前则位置先归位，
        // 损失只剩目标内容、且已如实标 unbacked。
        if (toBk) track({
          rel: toBk.rel ?? to, path: to, kind: 'modified' as const, diff: toDiff,
          ...(toBk.unbacked ? { unbacked: toBk.unbacked } : {})
        })
        return { ok: true, output: '已移动', change }
      }
      case 'search_files': {
        const pattern = typeof args.pattern === 'string' ? args.pattern : ''
        if (!pattern) return { ok: false, output: '拒绝：搜索内容为空' }
        // 长度上限：模型可控正则 + 大文件是 ReDoS 的温床，超长模式一律拒绝
        if (pattern.length > 200) return { ok: false, output: '拒绝：搜索模式过长（超过 200 字符）' }
        let matcher: RegExp
        try {
          matcher = args.is_regex === true
            ? new RegExp(pattern, 'i')
            : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        } catch (e) {
          return { ok: false, output: `拒绝：非法正则（${(e as Error).message}）` }
        }
        // 灾难性回溯的已知形态直接拒绝：组内带量词再整体带量词、纯交替组后带量词
        // （(a|aa)*b 这类指数回溯）、字符类连缀量词、量词连排——matcher.test 跑在主进程，
        // 一次卡死就是整个应用。启发式仍非完备（嵌套分组包住交替等形态会漏），
        // 线性时间引擎（RE2 类）才是根治，本层先挡已知灾难形态；模式 200 长度上限不变，兜住没认出来的。
        if (args.is_regex === true && /\((?:[^()]*[+*?])[^()]*\)[+*?]|\((?:[^()]*\|[^()]*)\)[+*?]|\[[^\]]+\][+*?]{2,}|[+*?]{3,}/.test(pattern)) {
          return { ok: false, output: '拒绝：正则存在嵌套量词或带量词的交替组（可能灾难性回溯），请拆分为多个简单搜索' }
        }
        const root = resolvePath(grant.dir)
        const gfilter = compileGlob(args.glob)
        if (typeof args.glob === 'string' && args.glob.trim() && !gfilter) {
          return { ok: false, output: `拒绝：glob 模式非法或超过 ${MAX_GLOB_LEN} 字符` }
        }
        const files: string[] = []
        await walkRelPaths(root, root, files)
        const hits: string[] = []
        let scanned = 0
        for (const rel of files) {
          if (hits.length >= MAX_SEARCH_HITS) break
          if (gfilter && !gfilter(rel)) continue
          const abs = resolvePath(root, rel)
          try {
            const st = await fs.stat(abs)
            if (st.size > MAX_READ) continue // 超大文件跳过（避免读爆）
            const text = await fs.readFile(abs, 'utf8')
            scanned += 1
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (hits.length >= MAX_SEARCH_HITS) break
              if (matcher.test(lines[i])) {
                const lineText = lines[i].length > 200 ? lines[i].slice(0, 200) + '…' : lines[i]
                hits.push(`${rel}:${i + 1}: ${lineText.trim()}`)
              }
            }
          } catch { /* 单文件读取失败跳过 */ }
        }
        return {
          ok: true,
          output: hits.length
            ? `${hits.length} 处匹配（扫描 ${scanned} 个文本文件${hits.length >= MAX_SEARCH_HITS ? '，已达上限' : ''}）：\n${hits.join('\n')}`
            : `未找到匹配（扫描 ${scanned} 个文本文件${gfilter ? '，过滤条件 ' + args.glob : ''}）`
        }
      }
      case 'glob_files': {
        const match = compileGlob(args.pattern)
        if (!match) return { ok: false, output: `拒绝：通配符模式为空或超过 ${MAX_GLOB_LEN} 字符` }
        const root = resolvePath(grant.dir)
        const files: string[] = []
        await walkRelPaths(root, root, files)
        const matched = files.filter((f) => match(f))
        const shown = matched.slice(0, MAX_GLOB)
        return {
          ok: true,
          output: shown.length
            ? `${matched.length} 个文件匹配${matched.length > MAX_GLOB ? `（仅显示前 ${MAX_GLOB}）` : ''}：\n${shown.join('\n')}`
            : '没有匹配的文件'
        }
      }
      case 'replace_in_file': {
        const p = sandboxPath(grant, args.path)
        if (!p) return { ok: false, output: '拒绝：路径越界或为空（仅限沙箱目录内）' }
        const find = typeof args.find === 'string' ? args.find : ''
        const replace = typeof args.replace === 'string' ? args.replace : ''
        if (!find) return { ok: false, output: '拒绝：find 为空' }
        let text: string
        try {
          text = await fs.readFile(p, 'utf8')
        } catch {
          return { ok: false, output: `读取失败：文件不存在或不可读` }
        }
        const count = text.split(find).length - 1
        if (count === 0) return { ok: false, output: '未找到要替换的文本（find 在文件中不存在）' }
        if (count > 1 && args.replace_all !== true) {
          return { ok: false, output: `拒绝：目标片段出现 ${count} 次，不唯一。请提供更长上下文使其唯一，或传 replace_all=true 替换全部` }
        }
        const next = args.replace_all === true ? text.split(find).join(replace) : replaceFirstLiteral(text, find, replace)
        if (next.length > MAX_WRITE) return { ok: false, output: `拒绝：替换后内容超过 ${MAX_WRITE / 1024}KB 上限` }
        const previewDiff = diffLines(text, next)
        if (grant.previewWrites && approver) {
          const d = await approver.ask({
            tool: 'replace_in_file', command: p, uncovered: [], kind: 'diff',
            reason: '精准替换会改动已有文件，先看清改了什么', diff: previewDiff || undefined
          })
          if (signal?.aborted) return { ok: false, output: '已取消：工具执行被用户停止' }
          if (d === 'deny') return { ok: false, output: '拒绝：用户取消了这次替换（文件保持原样）' }
        }
        // 旧内容此刻还在内存里，直接算 diff，省一次读盘
        const bk = await backup(p)
        await fs.writeFile(p, next, 'utf8')
        // 同 write_file：目录外改动也登记（rel 绝对路径占位），警示到界面；modified 无备份只列出
        const change = bk.rel === null && !bk.unbacked ? null : { rel: bk.rel ?? p, path: p, kind: 'modified' as const, diff: previewDiff, bytes: next.length, ...(bk.unbacked ? { unbacked: bk.unbacked } : {}) }
        track(change)
        return { ok: true, output: `已替换 ${args.replace_all === true ? count : 1} 处`, writtenPath: p, ...(change ? { change } : {}) }
      }
      case 'web_fetch': {
        if (!grant.allowWeb) return { ok: false, output: '拒绝：该 Agent 未授权联网' }
        const r = await webGet(typeof args.url === 'string' ? args.url : '', signal, 'text/html,application/json,text/plain,*/*')
        if (!r.ok) return { ok: false, output: r.output }
        const raw = r.contentType.includes('html') ? htmlToText(r.text) : r.text
        const body = raw.length > MAX_OUTPUT ? raw.slice(0, MAX_OUTPUT) : raw
        if (!body) return { ok: true, output: '（空内容）' }
        const suffix = r.truncated ? `\n…（响应超过 ${MAX_WEB_BODY / 1024}KB，已停止下载并截断）` : ''
        return { ok: true, output: body + suffix }
      }
      case 'web_search': {
        if (!grant.allowWeb) return { ok: false, output: '拒绝：该 Agent 未授权联网' }
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query) return { ok: false, output: '拒绝：搜索词为空' }
        const r = await webGet('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), signal, 'text/html,*/*')
        if (!r.ok) return { ok: false, output: `搜索失败：${r.output}` }
        const html = r.text
        // DuckDuckGo HTML 版结果解析（非官方接口，稳定性一般——如实标注）。
        // 按结果块切分：标题/链接/摘要取自同一块。旧实现把摘要按出现顺序与结果按位置配对，
        // 页面里插入广告（有链接无摘要）就会整体错位，把 A 的摘要挂到 B 上喂给模型
        const results: string[] = []
        const blocks = html.split(/(?=<a[^>]+class="[^"]*result__a)/i).filter((b) => b.startsWith('<a'))
        for (const block of blocks) {
          if (results.length >= 8) break
          const head = block.match(/^<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
          if (!head) continue
          let target = head[1]
          try {
            if (target.startsWith('//duckduckgo.com/l/?uddg=')) {
              target = decodeURIComponent(target.split('uddg=')[1]?.split('&')[0] ?? target)
            }
          } catch { /* 解析失败用原链 */ }
          const snip = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
          results.push(`${results.length + 1}. ${htmlToText(head[2])}\n   ${target}\n   ${htmlToText(snip?.[1] ?? '').slice(0, 160)}`)
        }
        return {
          ok: true,
          output: results.length
            ? `搜索「${query}」前 ${results.length} 条结果（DuckDuckGo）：\n\n${results.join('\n\n')}`
            : `搜索「${query}」无结果或页面结构变化（DuckDuckGo 非官方接口，可换 web_fetch 直接抓取）`
        }
      }
      case 'run_command': {
        if (!grant.allowCommands) return { ok: false, output: '拒绝：该 Agent 未授权执行命令' }
        const command = typeof args.command === 'string' ? args.command : ''
        if (!command.trim()) return { ok: false, output: '拒绝：命令为空' }
        // 命令审批（默认开）：危险形态或不在白名单的片段都要人确认；
        // 只有把该 Agent 的策略显式设为 auto（旧的一刀切放行）才跳过这一层
        if (grant.commandPolicy !== 'auto') {
          const v = checkCommand(command, approver?.rules() ?? [])
          if (!v.allowed) {
            if (!approver) {
              return {
                ok: false,
                output: `拒绝：${v.reason}（此执行入口没有确认界面，请从工作站/工作流发起，或把该 Agent 的命令策略改为"授权即放行"）`
              }
            }
            const d = await approver.ask({ tool: 'run_command', command, reason: v.reason, uncovered: v.uncovered })
            if (signal?.aborted) return { ok: false, output: '已取消：工具执行被用户停止' }
            if (d === 'deny') return { ok: false, output: `拒绝：用户不批准该命令（${v.reason}）` }
          }
        }
        // 完全访问：命令不限工作目录（dir 仅作默认 cwd，失效时不强制）；沙箱模式：cwd 固定为沙箱根
        const full = grant.access === 'full'
        const cwdRoot = grant.dir?.trim() ? resolvePath(grant.dir) : ''
        if (!full && !cwdRoot) return { ok: false, output: '拒绝：未配置沙箱目录' }
        // 执行统一走 shell.ts：进程树、超时、GBK 这些坑只在一个地方踩一次
        const sh = await runShell(command, { ...(cwdRoot ? { cwd: cwdRoot } : {}), timeoutMs: CMD_TIMEOUT_MS, ...(signal ? { signal } : {}) })
        if (sh.timedOut) return { ok: false, output: `命令超时（${CMD_TIMEOUT_MS / 1000}s）已终止（含子进程）。已产生的输出：\n${sh.output || '（无）'}` }
        if (sh.aborted) return { ok: false, output: `已取消：命令被用户停止（进程树已终止）。已产生的输出：\n${sh.output || '（无）'}` }
        // 没跑起来（目录不存在、exe 缺失、被信号终止）：如实失败，别报成"退出码 null"
        if (sh.code === null && sh.error) return { ok: false, output: `${sh.error}\n${sh.output || ''}`.trim() }
        // 非零退出码不是工具失败：模型要看得到"退出码 1 + 输出"才能自己改，这里与旧行为一致
        return { ok: true, output: `退出码 ${sh.code}\n${sh.output || '（无输出）'}` }
      }
      default:
        return { ok: false, output: `未知工具：${tool}` }
    }
  } catch (e) {
    return { ok: false, output: `执行失败：${(e as Error).message}` }
  }
}

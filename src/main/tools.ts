// 模型 Agent 工具层：沙箱文件操作 + 编辑增强 + 命令执行 + 联网（Agent 级授权制）
// 所有文件路径在沙箱根（ToolGrant.dir）内规范化校验，逃逸即拒绝；
// 命令以沙箱根为工作目录运行，超时与输出有上限，全程记录可追溯。
// 联网工具（web_fetch/web_search）需用户在授权面板单独开启（allowWeb）。
import { promises as fs, realpathSync } from 'node:fs'
import { resolve as resolvePath, dirname, sep, relative } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolGrant } from '../shared/types'

const MAX_READ = 200 * 1024 // 读文件上限
const MAX_WRITE = 1024 * 1024 // 写文件上限
const MAX_LIST = 500 // 列目录条目上限
const MAX_OUTPUT = 100 * 1024 // 命令输出/工具结果上限
export { MAX_OUTPUT }
const CMD_TIMEOUT_MS = 60_000 // 命令超时
const MAX_SEARCH_HITS = 100 // 文本搜索匹配上限
const MAX_GLOB = 200 // 通配符匹配文件上限
const WEB_TIMEOUT_MS = 20_000 // 联网请求超时
const MAX_WEB_BODY = 200 * 1024 // 联网响应体上限
/** 遍历时跳过的目录（对齐常见工程习惯，避免把依赖/版本库翻出来） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'out', 'release'])

/** 简易通配符转正则：支持 **（跨目录）、*（目录内）、?（单字符）；不引入 minimatch 依赖 */
function globToRegex(g: string): RegExp | null {
  if (!g.trim()) return null
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // **/ → 任意层级（含零层）；裸 ** → 任意字符
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  try { return new RegExp(`^${re}$`, 'i') } catch { return null }
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

/** 校验外链 URL：仅 http/https（防 file:// 等本地协议与注入） */
function safeWebUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch { return null }
}

/** OpenAI function calling 工具定义（发给模型的 schema；命令执行与联网仅授权后可见） */
export function toolDefs(allowCommands: boolean, allowWeb: boolean): unknown[] {
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
          description: '抓取一个 http/https 网页并转为纯文本（HTML 会剥离标签；JSON/纯文本原样返回）',
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
  return defs
}

/** 沙箱校验：路径规范化后必须仍在沙箱根内（防 ../ 逃逸与绝对路径注入）；返回原始大小写路径 */
function sandboxPath(grant: ToolGrant, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null
  const abs = resolvePath(grant.dir, rel)
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

/** Windows 杀进程树：taskkill /T /F（含所有孙子进程）；不可用时退回普通 kill */
export function killTree(proc: ChildProcess): void {
  try {
    if (proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch { /* taskkill 缺失时退回普通 kill */ }
  try { proc.kill() } catch { /* noop */ }
}

export interface ToolExecResult {
  ok: boolean
  /** 结果文本：成功时为内容/输出摘要；失败时为拒绝/错误原因（会回传给模型） */
  output: string
  /** write_file 成功时的绝对路径（工作流登记 artifacts 用） */
  writtenPath?: string
}

/** 执行一次工具调用。argsJson 为模型输出的 JSON 字符串（解析失败按参数错误处理）。signal 为外部取消信号（可中断命令/联网）。 */
export async function execTool(
  grant: ToolGrant,
  tool: string,
  argsJson: string,
  signal?: AbortSignal
): Promise<ToolExecResult> {
  let args: Record<string, unknown> = {}
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    return { ok: false, output: `参数不是合法 JSON：${argsJson.slice(0, 200)}` }
  }
  if (signal?.aborted) return { ok: false, output: '已取消：工具执行被用户停止' }
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
        await fs.mkdir(dirname(p), { recursive: true })
        await fs.writeFile(p, content, 'utf8')
        return { ok: true, output: `已写入 ${content.length} 字符`, writtenPath: p }
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
        const { shell } = require('electron') as typeof import('electron')
        await shell.trashItem(p)
        return { ok: true, output: '已移入回收站' }
      }
      case 'move': {
        const from = sandboxPath(grant, args.from)
        const to = sandboxPath(grant, args.to)
        if (!from || !to) return { ok: false, output: `拒绝：源或目标路径越界（仅限沙箱目录内）` }
        await fs.mkdir(dirname(to), { recursive: true })
        await fs.rename(from, to)
        return { ok: true, output: '已移动' }
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
        // 星高 >1 的典型结构（组内带量词、整体再带量词）在长行上会灾难性回溯，直接拒绝
        if (args.is_regex === true && /\((?:[^()]*[+*?])[^()]*\)[+*?]|\[[^\]]+\][+*?]{2,}|[+*?]{3,}/.test(pattern)) {
          return { ok: false, output: '拒绝：正则存在嵌套量词（可能灾难性回溯），请拆分为多个简单搜索' }
        }
        const root = resolvePath(grant.dir)
        const gfilter = typeof args.glob === 'string' && args.glob.trim() ? globToRegex(args.glob) : null
        const files: string[] = []
        await walkRelPaths(root, root, files)
        const hits: string[] = []
        let scanned = 0
        for (const rel of files) {
          if (hits.length >= MAX_SEARCH_HITS) break
          if (gfilter && !gfilter.test(rel)) continue
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
        const re = globToRegex(typeof args.pattern === 'string' ? args.pattern : '')
        if (!re) return { ok: false, output: '拒绝：通配符模式为空或非法' }
        const root = resolvePath(grant.dir)
        const files: string[] = []
        await walkRelPaths(root, root, files)
        const matched = files.filter((f) => re.test(f))
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
        await fs.writeFile(p, next, 'utf8')
        return { ok: true, output: `已替换 ${args.replace_all === true ? count : 1} 处`, writtenPath: p }
      }
      case 'web_fetch': {
        if (!grant.allowWeb) return { ok: false, output: '拒绝：该 Agent 未授权联网' }
        const url = safeWebUrl(args.url)
        if (!url) return { ok: false, output: '拒绝：URL 为空或不是 http/https 链接' }
        const { net } = require('electron') as typeof import('electron')
        // 取消信号联动：外部取消时立即中断进行中的请求
        const fetchSignal = signal ? AbortSignal.any([AbortSignal.timeout(WEB_TIMEOUT_MS), signal]) : AbortSignal.timeout(WEB_TIMEOUT_MS)
        const res = await net.fetch(url, {
          redirect: 'follow',
          signal: fetchSignal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AgentHub/0.2', Accept: 'text/html,application/json,text/plain,*/*' }
        }).catch((e: unknown) => ({ err: e as Error }))
        if ('err' in res && res.err) return { ok: false, output: `请求失败：${res.err.message}` }
        const r = res as Response
        if (!r.ok) return { ok: false, output: `HTTP ${r.status} ${r.statusText}` }
        let body = await r.text()
        if (body.length > MAX_WEB_BODY) body = body.slice(0, MAX_WEB_BODY) + '…（内容超限已截断）'
        const ct = r.headers.get('content-type') ?? ''
        const text = ct.includes('html') ? htmlToText(body) : body
        return { ok: true, output: text ? text.slice(0, MAX_OUTPUT) || '（空内容）' : '（空内容）' }
      }
      case 'web_search': {
        if (!grant.allowWeb) return { ok: false, output: '拒绝：该 Agent 未授权联网' }
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query) return { ok: false, output: '拒绝：搜索词为空' }
        const { net } = require('electron') as typeof import('electron')
        const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
        const fetchSignal = signal ? AbortSignal.any([AbortSignal.timeout(WEB_TIMEOUT_MS), signal]) : AbortSignal.timeout(WEB_TIMEOUT_MS)
        const res = await net.fetch(url, {
          redirect: 'follow',
          signal: fetchSignal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AgentHub/0.2' }
        }).catch((e: unknown) => ({ err: e as Error }))
        if ('err' in res && res.err) return { ok: false, output: `搜索失败：${res.err.message}` }
        const r = res as Response
        if (!r.ok) return { ok: false, output: `搜索失败：HTTP ${r.status}` }
        const html = await r.text()
        // DuckDuckGo HTML 版结果解析（非官方接口，稳定性一般——如实标注）
        const results: string[] = []
        const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
        const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
        const snippets: string[] = []
        let sm: RegExpExecArray | null
        while ((sm = snippetRe.exec(html)) && snippets.length < 8) snippets.push(htmlToText(sm[1]))
        let lm: RegExpExecArray | null
        let rank = 0
        while ((lm = linkRe.exec(html)) && results.length < 8) {
          rank += 1
          const href = lm[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, (m) => m) // 保留原始（可能是跳转链）
          let target = href
          try {
            if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
              target = decodeURIComponent(href.split('uddg=')[1]?.split('&')[0] ?? href)
            }
          } catch { /* 解析失败用原链 */ }
          const title = htmlToText(lm[2])
          const snip = snippets[rank - 1] ?? ''
          results.push(`${rank}. ${title}\n   ${target}\n   ${snip.slice(0, 160)}`)
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
        return await new Promise<ToolExecResult>((res) => {
          const child = spawn(command, {
            shell: true,
            cwd: resolvePath(grant.dir),
            windowsHide: true
            // 注意：不用 spawn 的 timeout 选项——它只终止 cmd.exe 外壳，
            // 外壳启动的孙子进程会继续运行。超时/取消统一走 killTree 杀整棵树。
          })
          let killed = false
          let timedOut = false
          const cleanup = () => {
            clearTimeout(timer)
            if (signal) signal.removeEventListener('abort', onAbort)
          }
          const timer = setTimeout(() => {
            timedOut = true
            killed = true
            killTree(child)
          }, CMD_TIMEOUT_MS)
          const onAbort = () => {
            killed = true
            killTree(child)
          }
          if (signal) {
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          }
          // 输出按 Buffer 收集，结束后统一解码（避免多字节序列被 chunk 边界切断）
          const chunks: Buffer[] = []
          let total = 0
          const append = (b: Buffer | string) => {
            if (typeof b === 'string') { chunks.push(Buffer.from(b, 'utf8')); total += b.length; return }
            if (total < MAX_OUTPUT) { chunks.push(b); total += b.length }
          }
          child.stdout?.on('data', append)
          child.stderr?.on('data', append)
          child.on('error', (e) => { cleanup(); res({ ok: false, output: `启动失败：${e.message}` }) })
          child.on('close', (code, signalName) => {
            cleanup()
            // 中文 Windows 的 cmd 输出为 GBK（代码页 936）：先严格按 UTF-8 解码，失败则回退 GBK
            let out: string
            try {
              out = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
            } catch {
              try { out = new TextDecoder('gbk').decode(Buffer.concat(chunks)) } catch { out = Buffer.concat(chunks).toString('utf8') }
            }
            if (out.length >= MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + '…（输出已截断）'
            if (timedOut) {
              res({ ok: false, output: `命令超时（${CMD_TIMEOUT_MS / 1000}s）已终止（含子进程）。已产生的输出：\n${out || '（无）'}` })
            } else if (killed && signal?.aborted) {
              res({ ok: false, output: `已取消：命令被用户停止（进程树已终止）。已产生的输出：\n${out || '（无）'}` })
            } else if (signalName === 'SIGTERM' || signalName === 'SIGKILL') {
              res({ ok: false, output: `命令被终止。已产生的输出：\n${out || '（无）'}` })
            } else {
              res({ ok: true, output: `退出码 ${code}\n${out || '（无输出）'}` })
            }
          })
        })
      }
      default:
        return { ok: false, output: `未知工具：${tool}` }
    }
  } catch (e) {
    return { ok: false, output: `执行失败：${(e as Error).message}` }
  }
}

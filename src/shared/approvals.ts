// 命令审批的纯规则层（main / renderer / 验证脚本共用；不碰 electron 与磁盘）
//
// 三层判定，顺序固定：
// ① 危险形态（rm -rf / del /s / format / curl|sh 这类）——**白名单不能覆盖**，一律要人确认；
// ② 命令按 cmd 真实语义拆段（&& || ; |、单 &、换行都是边界；引号只认双引号），每一段都要被
//    白名单规则单独覆盖，`npm test && del C:\*` 不能因为"npm test 在白名单里"就整条放行；
// ③ 规则默认整段相等才放行，只有以 `*` 结尾才是前缀放行——想放宽必须显式写通配，不靠猜。
import type { ApprovalDecision, ApprovalRecord, ApprovalRequest } from './types'

export type { ApprovalDecision, ApprovalRecord, ApprovalRequest }

/** 规范化：折叠空白 + 小写（Windows 大小写不敏感，命令与规则同口径才比得准） */
export function normalizeCommand(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 引号感知的命令分段，按 cmd.exe 的真实语义：单 `&` 与换行（\r \n）和 && || ; | 一样都是
 * "另一条命令"的边界；引号区只由 `"` 开启/关闭（cmd 不认单引号，`'` 是普通字符）。
 * 旧版只认 && || ; |、还把 `'` 当引号——`git status & powershell …` 会整段命中 `git *` 前缀
 * 免确认放行，这正是要修的洞。
 * 引号外的 `^` 是 cmd 转义符：下一个字符（若存在）按普通字符并入本段并跳过，`^&` 不拆段；
 * 段文本里 `^` 被剥掉不影响用途（段只用于匹配，不回显原文）。
 * 已知残留：`%VAR%` 展开出分隔符属于 percent-expansion 发生在解析前后的问题，本层看不到
 * 变量内容，只能靠"未覆盖段要人确认"兜底。
 */
export function splitSegments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (q) {
      cur += ch
      if (ch === '"') q = false
      continue
    }
    if (ch === '"') {
      q = true
      cur += ch
      continue
    }
    if (ch === '^') {
      if (i + 1 < command.length) cur += command[i + 1]
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    // 单 & 在 cmd 里是无条件命令分隔符，换行同理（cmd /c 对裸 LF/CRLF 按分隔符处理）
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\r' || ch === '\n') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 规则匹配：以 * 结尾 = 前缀放行，否则整段相等 */
export function ruleMatches(rule: string, segment: string): boolean {
  const r = normalizeCommand(rule)
  const s = normalizeCommand(segment)
  if (!r || !s) return false
  if (r.endsWith('*')) {
    const head = r.slice(0, -1).trimEnd()
    return !!head && (s === head || s.startsWith(head + ' '))
  }
  return s === r
}

/**
 * 危险形态：这些不论白名单里写了什么都必须人工确认。
 * 清单是启发式不是完备集（只收评审点名的形态与常见变体：短旗标、.exe 后缀、长选项、PowerShell
 * 同义命令），未命中的未知命令仍要走逐段确认——本清单只把"明显危险"提前到免确认判定之前。
 * 各条只在自己那一段内扫描：[^&|;]* 不跨段（单 & 现在也是段边界，拆段后天然只剩单段，语义不变）。
 */
const DANGEROUS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+(?:(?:-{1,2}[a-z]+)\s+)*(?:-\w*[rf]\w*|--recursive|--force)\b/i, label: '递归/强制删除（rm -rf）' },
  { re: /\b(del|erase)\s*\/s/i, label: '递归删除（del /s）' },
  { re: /\b(rd|rmdir)\s*\/s/i, label: '递归删除（rd /s）' },
  { re: /\bformat(?:\s+\/[a-z])*\s+[a-z]:/i, label: '格式化磁盘（format）' },
  { re: /\bmkfs\b/i, label: '重建文件系统（mkfs）' },
  { re: /\b(shutdown|reboot|logoff)\b/i, label: '关机/重启' },
  { re: /\bnet\s+user\b/i, label: '改动系统账户（net user）' },
  { re: /\breg(?:\.exe)?\s+(?:delete|add)\b/i, label: '改动注册表（reg）' },
  { re: /\bset-mppreference\b/i, label: '改动 Defender 策略' },
  { re: /\bremove-item\b[^&|;]*\s-?recurse/i, label: '递归删除（Remove-Item -Recurse）' },
  { re: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(?:iex|invoke-expression|(?:sudo\s+)?(?:ba|z)?sh|powershell|cmd)\b/i, label: '网络脚本直接执行（curl | sh / iwr | iex）' },
  { re: /\bpowershell(?:\.exe)?\b[^&|;]*\s-(?:e|enc|encodedcommand)\b/i, label: '编码命令执行（powershell -enc）' },
  { re: /\bgit\s+push\b[^&|;]*\s(?:-{1,2}(?:f|force(?:-with-lease)?))\b/i, label: '强制推送（git push -f/--force）' },
  { re: /\bgit\s+reset\b[^&|;]*\s--hard\b/i, label: '丢弃工作区改动（git reset --hard）' },
  { re: /\bgit\s+clean\b[^&|;]*\s-\w*f\w*/i, label: '丢弃未跟踪文件（git clean -f）' }
]

/** 命中的危险形态名称（没命中返回 null） */
export function dangerousHit(command: string): string | null {
  for (const d of DANGEROUS) if (d.re.test(command)) return d.label
  return null
}

export interface CommandVerdict {
  allowed: boolean
  /** 为什么要问（界面与历史都用它，不另编一套话术） */
  reason: string
  /** 未被覆盖的片段 */
  uncovered: string[]
}

/** 白名单判定：危险形态优先，其次逐段核对 */
export function checkCommand(command: string, rules: string[]): CommandVerdict {
  const hit = dangerousHit(command)
  if (hit) return { allowed: false, reason: `命中危险形态，白名单不放行：${hit}`, uncovered: [command.trim()] }
  const segs = splitSegments(command)
  if (!segs.length) return { allowed: false, reason: '命令为空', uncovered: [] }
  if (!rules.length) return { allowed: false, reason: '尚未配置命令白名单（每条命令都要确认）', uncovered: segs }
  const uncovered = segs.filter((s) => !rules.some((r) => ruleMatches(r, s)))
  if (!uncovered.length) return { allowed: true, reason: '白名单已覆盖', uncovered: [] }
  return { allowed: false, reason: '不在命令白名单内', uncovered }
}

/** 点「始终允许」时该写入哪些规则：只补真正没被覆盖的那几段 */
export function rulesToAdd(uncovered: string[]): string[] {
  return Array.from(new Set(uncovered.map((s) => normalizeCommand(s)).filter(Boolean)))
}

/**
 * 规则⑤ 的实现：`curl -u user:pass@host` 只遮口令，user 与主机留着才认得出这是哪条命令。
 * 旧写法是一条带前后瞻的正则 `([^\s"',;]+:)([^\s"',;@]+)(?=@)`：① 它在"冒号多、@ 少"的串上平方级回溯（实测 500 KB 约 200 秒，轮 2 就是为了让它
 * 不拖住渲染，把**输入**先截到 512——结果 @ 落在截断之外时口令就遮不住，该遮的没遮）；
 * ② 那种截断本身也是错的，脱敏必须看到整条命令。
 * 这里改成线性扫描：旧式的贪婪回溯等价于"从右往左第一个『右边还有 @、且 @ 不紧跟冒号』的冒号位"，
 * 反向一遍扫描即得，没有回溯可言。**落点与旧正则逐字节等价**——fixes-check 里抄了一份旧正则当参照实现，
 * 用 3000 条随机串 + 定点用例做差分钉住（改这条的人若动到语义，那条断言会红）。
 * 一个必须照抄的细节：旧正则在某个起点整体失配时只前进**一个字符**重试，所以 `-u -u a:b@c` 这种
 * "上一个 token 里还藏着下一个 -u"的写法仍会被遮；这里失配时同样把 lastIndex 拨回起点+1（差分实测就是这个形态）。
 */
function redactUserinfoPassword(s: string): string {
  const re = /(\s-{1,2}u(?:ser)?[ \t]+["']?)([^\s"',;]+)/gi
  let out = ''
  let copied = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const token = m[2]
    let nextAt = -1
    let colon = -1
    let at = -1
    for (let i = token.length - 1; i >= 0; i--) {
      const c = token[i]
      if (c === '@') { nextAt = i; continue }
      if (colon < 0 && c === ':' && nextAt > i + 1) { colon = i; at = nextAt }
    }
    if (colon < 1) {
      re.lastIndex = m.index + 1
      continue
    }
    const headEnd = m.index + m[1].length
    out += s.slice(copied, headEnd + colon + 1) + '***'
    copied = headEnd + at
    re.lastIndex = copied
  }
  return out + s.slice(copied)
}

/**
 * 遮掉看起来像凭据的片段。**只服务显示回显这一半**：指纹对 normalizeCommand 之后的命令原文计算，不经过本函数
 * （见 fingerprintCommand），显示回显请走 redactCommandForDisplay()。
 * Hook 命令常有人直接写凭据，旁边回显什么就都看得见，显示前必须脱敏——这是"那行输入框万一改成
 * type=password"式的纵深防御，不是保密承诺（命令原文本来就明文存在用户配置里）。
 * 覆盖面（评审点名、旧实现漏掉的写法都补上了）：
 * - 关键词后跟 = 或 :（允许两侧留白与引号）：--api-key=xxx、X-Api-Token: xxx、aws_access_key_id=AKIA…
 *   （裸 key/token/secret/password… 均在列，关键词尾巴允许 _id、2 这类标识符后缀）；
 * - 强关键词后跟空格加一个"看着不像路径/URL"的值：PASSWORD hunter2（文件名里的下划线/点造不出这个边界）；
 * - Authorization: <任意 scheme> <值>（不止 Bearer）、独立的 Bearer <值>；
 * - curl -u user:pass@host 遮口令、留 user 便于认行。
 * 值的长度下限是 3（--api-key=abc 也是凭据；旧实现下限 4 会把短值明文显示出去）。
 * 已知误伤：node secret helper.js 会被遮——`secret<空格>词` 与 `PASSWORD hunter2` 同形，无法廉价区分，
 * 裁决接受（只损可读性，Hook 执行的仍是原始命令）；python token_counter.py 不误遮（下划线接不出边界）。
 * 成本：**整条链是线性的**，输入多长都不改写多少字符的平方——① 规则⑤ 改成上面的线性扫描；
 * ② 规则② 的负向前瞻用 `(?=(…))\3` 把值段锁成一次匹配（原子化）：那一条在原写法下会"值段每退一个字符、
 * 就把后面到下一个空白之间的整段重扫一遍"（实测 200 KB 单段 + 结尾一个 @ 要 10 秒），而事实上
 * "最长的那次尝试不成立 ⇒ 所有更短的也不成立"（值段里没有空白，缩短只会让后缀多含几个字符），
 * 所以退避是纯浪费，锁成一次匹配后行为逐字节不变、成本变线性（同上，fixes-check 里做差分）。
 * 本函数**不截输入**：脱敏必须看到整条命令，截断会删掉前后瞻的判断上下文（轮 2 的教训）。
 * 数据那一侧的长度界在 shared/hooks.ts 的 HOOK_COMMAND_MAX_LENGTH（保存时拒绝），不是靠这里裁。
 */
export function redactSecrets(s: string): string {
  return redactUserinfoPassword((s ?? '')
    // ① 关键词 + [=:] 边界 + 值。边界必须是 = 或 :——token_counter.py 里 token 后面是下划线，
    //    造不出这个边界，所以文件名整体不误伤。
    .replace(/((?:api[_-]?key|access[_-]?key|key|token|secret|password|passwd|pwd|credential)([a-z0-9_]{0,16})([ \t]*[=:][ \t]*)(["']?))[^\s"',;]{3,}/gi, '$1***')
    // ② 关键词 + 空格 + 值（PASSWORD hunter2、--api-key xxxx 这类分隔写法）。
    //    值里含 : 或 @ 的多半是 URL/路径（postgres://、a:b@c），遮了只剩噪音，放过。
    //    `(?=([^\s"',;@]{3,}))\3` ＝把值段取成"最长那一次且只试一次"（旧写法的退避全是白做的，见上面 JSDoc）。
    .replace(/((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd|credential)[ \t]+)(["']?)(?=([^\s"',;@]{3,}))\3(?![^ \t]*[@:])/gi, '$1$2***')
    // ③ Authorization 头：任意认证方案（Basic/Digest/自定义），遮掉值本体、方案名留着。
    .replace(/((?:Proxy-)?Authorization[ \t]*:[ \t]*(?:[A-Za-z][A-Za-z0-9+.-]*[ \t]+)?(["']?))[^\s"',;]{3,}/gi, '$1$2***')
    // ④ 脱离 Authorization 前单独出现的 Bearer <值>。
    .replace(/(Bearer[ \t]+)(["']?)[^\s"',;]{3,}/gi, '$1$2***'))
}

/** 显示回显只看得下 160 个字符——这是那一半的宽度（在**脱敏之后**取，绝不在这之前取） */
export const REDACT_VISIBLE_LIMIT = 160

/**
 * Hook / 命令显示回显的入口：把**整条**命令交给 redactSecrets，再取可见的 160 个字符。
 * 顺序只有一种：先脱敏、后截可见宽度。轮 2 反过来做过（先截到 512 再脱敏），那是错的——
 * 规则②/⑤ 的前后瞻需要看到凭据段后面的 `@`/`:`，截断把那个上下文删掉，于是长口令段
 * 原样显示出来（实测 541 字符的 `curl -u alice:<512+>@host` 在前 160 个字符里剩 135 个明文凭据字符）。
 * 渲染的成本界由 redactSecrets 自身的线性 + 数据侧的 HOOK_COMMAND_MAX_LENGTH 提供，
 * 这里不再对输入设任何界。
 */
export function redactCommandForDisplay(s: string): string {
  return redactSecrets(s ?? '').slice(0, REDACT_VISIBLE_LIMIT)
}

/**
 * 12 位指纹：输入是 normalizeCommand(s ?? '')（折叠连续空白 + 转小写 + trim），对它逐字散列命令原文。
 * 口径要说准，别写成"改任意字符都变"这种过头话：改任意一个字符（大小写与多余空白的写法除外——那几种会被
 * normalizeCommand 归一化掉，实测 NODE x.js / node  x.js / ' node x.js ' 与 node x.js 同指纹，
 * --api-key=ABC 与 --api-key=abc 也同指纹）指纹就会变——包括改动落在显示时被遮成 *** 的凭据值上
 * （AAAA1111 → BBBB2222 实测是两个指纹）。它只用于肉眼确认「这条命令是不是我原来那条」，永远不参与放行判定。
 * 为什么保留归一化（而不是给散列单独去掉它）：白名单判定 ruleMatches 用的就是同一个 normalizeCommand——
 * 同一命令的两种大小写/空白写法在放行上完全等价，指纹却把它们显示成两个不同值，等于让人以为"这是两条不同
 * 规则"，那是另一种误导。裁决＝把折叠从文案里"除外"出去，而不是改散列的输入。
 * 为什么哈希原文、而不是旧版的"先脱敏再哈希"：用户最常见的编辑就是换 key，旧构造把 key 值全遮成
 * 同一个 *** 后再散列——实测 5000 个互不相同的 api-key 值并成同一个指纹，恰好在最该看出来的改动上
 * 失明，等于虚假宣传。
 * 为什么哈希原文不算多泄露：Hook 命令本来就明文存在用户配置里（src/main/store.ts 的 setHooks
 * 写进 config.json），设置页就在输入框里不脱敏地显示全文；一个 12 位仅显示用散列，对一个已持有
 * 那份配置/那个界面的人来说不含任何新信息。想靠指纹防泄露是用错了工具——那是加密的事，
 * 而 shared 层不许动 crypto（纯 node 与渲染两端同构可用），所以这里只是 Math.imul 显示件，
 * 绝不是安全原语；src/main/** 与 src/shared/**（approvals.ts 之外）引用它都会被 fixes-check 的
 * 源码绊线拦下——那两条是漂移绊线、不是数据流证明。
 * undefined/null：`s ?? ''` 是承重线，脏入参归到与空串同一个指纹（'' = ztntfp9zloz0），不抛异常。
 */
export function fingerprintCommand(s: string): string {
  const base = normalizeCommand(s ?? '')
  // 与项目里其它 id 生成同思路：不用 crypto（shared 层要在纯 node 与浏览器两端同构可用）
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < base.length; i++) {
    h1 = (h1 ^ base.charCodeAt(i)) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ base.charCodeAt(i), 0x85ebca6b)) >>> 0
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12).padEnd(12, '0')
}

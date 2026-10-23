/**
 * 命令串 → argv（MCP server 启动用；不碰 electron，逻辑层可直接测）。
 *
 * 为什么自己切而不是 shell:true：整条命令交 cmd 解析，等于把"配置里写什么就跑什么"变成
 * 任意 shell 语法。切完存成数组，起进程时不再经过 shell 的解释。
 * 为什么留 comspec 一条路：argv 那条路只认真正的 exe。Windows 上 CreateProcess 会把
 * `node` 补成 `node.exe`，但 PATH 上的 npx/npm/pnpm/yarn 真身是 .CMD（没有同名 .exe），
 * 对它们硬走 shell:false 只会 ENOENT —— 所以 .cmd/.bat 家族和 npm 系裸启动器一律包一层
 * comspec，其余（node、node.exe、带路径的可执行文件）继续走 argv 直传。
 */

/** 一个命令的可执行文件 + 参数 + 是否需要包一层 comspec */
export interface LaunchPlan {
  file: string
  args: string[]
  comspec: boolean
}

/** 引号感知按空白切分：引号内的空格是参数内容，不是分隔符 */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  let started = false
  const push = () => {
    if (started) out.push(cur)
    cur = ''
    started = false
  }
  for (let i = 0; i < (command ?? '').length; i++) {
    const ch = command[i]
    if (q) {
      // 引号内：原样收下，遇到同种引号结束（不认转义，Windows 路径里没有可靠的转义规则）
      if (ch === q) q = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      q = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    cur += ch
    started = true
  }
  // 引号不成对：把已读内容原样作为一段交出去（用户能立刻在预览里看到切错了）
  push()
  return out
}

/** .cmd / .bat 家族，以及 npm 系裸启动器：这些必须经 comspec 才起得来 */
export function needsComspec(bin: string): boolean {
  const b = (bin ?? '').trim()
  if (/\.(cmd|bat)$/i.test(b)) return true
  // npx/npm/pnpm/yarn 的真身是 .CMD，PATH 上没有同名 .exe；shell:false 直接 spawn 会 ENOENT。
  // node / node.exe / 带路径的可执行文件仍走 argv 直传。
  return !/[/\\]/.test(b) && /^(npx|npm|pnpm|yarn)$/i.test(b)
}

/** 由命令串算出启动计划；切不出可执行文件时返回 null，由调用方如实报错（不起空进程） */
export function toLaunchPlan(command: string): LaunchPlan | null {
  const parts = tokenizeCommand(command)
  if (!parts.length) return null
  const [file, ...args] = parts
  if (!file.trim()) return null // 空引号（"" / " "）切得出空 token，不能当可执行文件交出去
  return { file, args, comspec: needsComspec(file) }
}

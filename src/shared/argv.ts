/**
 * 命令串 → argv（MCP server 启动用；不碰 electron，逻辑层可直接测）。
 *
 * 为什么自己切而不是 shell:true：整条命令交 cmd 解析，等于把"配置里写什么就跑什么"变成
 * 任意 shell 语法。切完存成数组，起进程时不再经过 shell 的解释。
 * 为什么留 comspec 一条路：Windows 上 npx/npm 的真身是 .CMD，Node 对 .bat/.cmd
 * 在非 shell 启动下有专门限制，硬撑"纯 shell:false"只会让用户用不了最常见的 MCP server。
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

/** .cmd / .bat 家族：这些必须经 comspec 才起得来 */
export function needsComspec(bin: string): boolean {
  return /\.(cmd|bat)$/i.test((bin ?? '').trim())
}

/** 由命令串算出启动计划；切不出可执行文件时返回 null，由调用方如实报错 */
export function toLaunchPlan(command: string): LaunchPlan | null {
  const parts = tokenizeCommand(command)
  if (!parts.length) return null
  const [file, ...args] = parts
  return { file, args, comspec: needsComspec(file) }
}

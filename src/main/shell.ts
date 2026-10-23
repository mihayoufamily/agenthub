/**
 * 一条 shell 命令的安全执行：杀进程树、超时有界、输出按字节封顶且解码不误伤多字节。
 * 从工具层抽出来给两处共用（模型的工具调用 / 用户自己配的 Hook），
 * 免得同一段 GBK 与进程树的坑在两个地方各踩一次。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'

const MAX_OUTPUT = 100 * 1024

/**
 * Windows 杀进程树：taskkill /T /F 连孙子进程一起端掉。
 * 不能顺手再 proc.kill()——外壳先死会让 taskkill 找不到父进程（实测 code=128），
 * 结果孙子进程带着管道继续活，超时"截住"了却还要干等到它自然结束。
 * 所以只在 taskkill 真的失败时才退回 proc.kill()。
 */
export function killTree(proc: ChildProcess): void {
  const fallback = () => {
    try { proc.kill() } catch { /* noop */ }
  }
  try {
    if (!proc.pid) {
      fallback()
      return
    }
    const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    tk.once('error', fallback)
    tk.once('close', (code) => {
      if (code !== 0) fallback()
    })
  } catch {
    fallback()
  }
}

export interface ShellResult {
  ok: boolean
  code: number | null
  output: string
  timedOut: boolean
  aborted: boolean
  error?: string
}

/**
 * cwd 不存在时先尝试创建（Windows 上 spawn 一个不存在的 cwd 会 ENOENT，
 * 而 Node 报的错误信息指向 exe，看着像"程序找不到"，实测骗过一次排查）。
 * 建不出来就如实失败，不悄悄换目录。
 */
export async function runShell(
  command: string,
  opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }
): Promise<ShellResult> {
  let cwd = opts.cwd?.trim() ? opts.cwd : undefined
  if (cwd) {
    try {
      await fs.stat(cwd)
    } catch {
      try {
        await fs.mkdir(cwd, { recursive: true })
      } catch {
        return { ok: false, code: null, output: '', timedOut: false, aborted: false, error: `工作目录不存在且无法创建：${cwd}` }
      }
    }
  }
  return new Promise<ShellResult>((res) => {
    const child = spawn(command, { shell: true, ...(cwd ? { cwd } : {}), windowsHide: true, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) })
    let killed = false
    let timedOut = false
    const cleanup = () => {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killed = true
      killTree(child)
    }, opts.timeoutMs)
    const onAbort = () => {
      killed = true
      killTree(child)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    const onSpawnError = (e: NodeJS.ErrnoException) => {
      cleanup()
      const cwdMissing = e.code === 'ENOENT' && !!cwd
      res({ ok: false, code: null, output: '', timedOut: false, aborted: false, error: cwdMissing ? `工作目录不存在，进程无法启动：${cwd}` : `启动失败：${e.message}` })
    }
    child.once('error', onSpawnError)
    // 输出按 Buffer 收集，结束后统一解码（避免多字节序列被 chunk 边界切断）
    const chunks: Buffer[] = []
    let total = 0
    // 字节上限是"丢数据"而非"切字符"：记录是否丢过，截断必须如实标注（静默截断会骗模型）
    let capped = false
    const append = (b: Buffer | string) => {
      if (typeof b === 'string') { chunks.push(Buffer.from(b, 'utf8')); total += b.length; return }
      if (total < MAX_OUTPUT) { chunks.push(b); total += b.length } else capped = true
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('close', (code, signalName) => {
      cleanup()
      // 中文 Windows 的 cmd 输出为 GBK（代码页 936）：先严格按 UTF-8 解码，失败则回退 GBK。
      // 按字节截断可能切碎末尾多字节字符：严格解码失败时先回退最多 3 字节重试，
      // 成功说明是截断边界问题而非 GBK，避免整段 UTF-8 被按 GBK 误解码成乱码
      const buf = Buffer.concat(chunks)
      const strict = new TextDecoder('utf-8', { fatal: true })
      let out: string | null = null
      try {
        out = strict.decode(buf)
      } catch {
        for (let cut = 1; cut <= 3 && out === null; cut++) {
          try { out = strict.decode(buf.subarray(0, buf.length - cut)) } catch { /* 继续回退 */ }
        }
      }
      if (out === null) {
        try { out = new TextDecoder('gbk').decode(buf) } catch { out = buf.toString('utf8') }
      }
      if (capped || out.length >= MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + '…（输出已截断）'
      if (timedOut) res({ ok: false, code, output: out, timedOut: true, aborted: false })
      else if (killed && opts.signal?.aborted) res({ ok: false, code, output: out, timedOut: false, aborted: true })
      else res({ ok: code === 0, code, output: out, timedOut: false, aborted: false, ...(signalName ? { error: `命令被信号终止（${signalName}）` } : {}) })
    })
  })
}

export { MAX_OUTPUT }

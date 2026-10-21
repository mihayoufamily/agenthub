import { spawn } from 'node:child_process'
import type { ScanResultItem, CliName } from '../shared/types'
import { resolveCliTarget } from './adapters/cli'

/**
 * 扫描本机已安装的 Agent CLI。
 * 扫描范围严格限定：
 *  - 已内置适配器的 CLI：走适配层自己的定位逻辑（PATH + 已知安装位置 + 盘符浅扫描），
 *    因此 WorkBuddy 内置的 CodeBuddy、DeepSeek Harness、Codex 应用这类非 PATH 安装也能被发现；
 *  - 其余未适配的 CLI：只在 PATH 上 where，仅检测存在性，不读取任何软件的配置文件或密钥。
 * 发现 ≠ 接入：只有已内置适配器的才标注"可接入"，其余如实标注"仅发现"。
 */
const SUPPORTED: { name: CliName; note: string }[] = [
  { name: 'arkcli', note: '已内置执行适配器（本机实测：真实流式调用）' },
  { name: 'codex', note: '已内置执行适配器（本机实测：exec --json 事件流）' },
  { name: 'codebuddy', note: '已内置执行适配器（CodeBuddy Code，本机实测：官方 npm 安装优先，WorkBuddy 内置版兜底）' },
  { name: 'dsh', note: '已内置执行适配器（DeepSeek Harness headless，本机实测：需模型凭据，输出为纯文本非流式）' },
  { name: 'claude', note: '已内置适配器（按官方 CLI 规范实现，本机未安装实测）' }
]

const DISCOVER_ONLY: string[] = ['gemini', 'qwen', 'aider', 'cursor-agent', 'goose', 'opencode']

function where(name: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      const proc = spawn('where.exe', [name], { windowsHide: true })
      let out = ''
      proc.stdout.on('data', (d) => (out += d.toString()))
      proc.on('error', () => resolvePromise(null))
      proc.on('close', (code) => resolvePromise(code === 0 ? out.split('\r\n')[0].trim() || null : null))
      // 超时保护
      setTimeout(() => {
        try { proc.kill() } catch { /* noop */ }
        resolvePromise(null)
      }, 4000)
    } catch {
      resolvePromise(null)
    }
  })
}

export async function scanAgents(): Promise<ScanResultItem[]> {
  const results: ScanResultItem[] = []
  const supported = await Promise.all(
    SUPPORTED.map(async (cli) => {
      const target = await resolveCliTarget(cli.name).catch(() => null)
      return target ? { cli, target } : null
    })
  )
  for (const item of supported) {
    if (!item) continue
    results.push({
      name: item.cli.name,
      path: item.target.label,
      status: 'discovered',
      supportNote: item.cli.note
    })
  }
  const onlyFound = await Promise.all(DISCOVER_ONLY.map(async (name) => ({ name, path: await where(name) })))
  for (const item of onlyFound) {
    if (!item.path) continue
    // 已适配的 CLI 已在上面出现时，不重复列出
    if (results.some((d) => d.name === item.name)) continue
    results.push({ name: item.name, path: item.path, status: 'discovered', supportNote: '未内置执行适配器，仅发现' })
  }
  return results
}

/** 校验用户手动指定的路径存在性 */
export async function checkManualPath(p: string): Promise<boolean> {
  try {
    const st = await where(p)
    return st !== null
  } catch {
    return false
  }
}

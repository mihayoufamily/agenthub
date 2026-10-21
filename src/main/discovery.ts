import { spawn } from 'node:child_process'
import type { ScanResultItem } from '../shared/types'

/**
 * 扫描本机已安装的 Agent CLI。
 * 扫描范围严格限定：
 *  - PATH 上的常见可执行命令（where 查询）
 *  - 只检测存在性，不读取任何软件的配置文件或密钥
 * 发现 ≠ 接入：仅 arkcli / claude / codex 内置执行适配器（其中 claude/codex 未在本机实测），其余如实标注"仅发现"。
 */
const KNOWN_CLIS: { name: string; note: string }[] = [
  { name: 'arkcli', note: '已内置执行适配器（本机实测：真实流式调用）' },
  { name: 'claude', note: '已内置适配器（按官方 CLI 规范实现，未在本机实测）' },
  { name: 'codex', note: '已内置适配器（按官方 CLI 规范实现，未在本机实测）' },
  { name: 'gemini', note: '未内置执行适配器，仅发现' },
  { name: 'qwen', note: '未内置执行适配器，仅发现' },
  { name: 'aider', note: '未内置执行适配器，仅发现' },
  { name: 'cursor-agent', note: '未内置执行适配器，仅发现' },
  { name: 'goose', note: '未内置执行适配器，仅发现' },
  { name: 'opencode', note: '未内置执行适配器，仅发现' }
]

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
  const found = await Promise.all(
    KNOWN_CLIS.map(async (cli) => ({ cli, path: await where(cli.name) }))
  )
  for (const f of found) {
    if (f.path) {
      results.push({
        name: f.cli.name,
        path: f.path,
        status: 'discovered',
        supportNote: f.cli.note
      })
    }
  }
  return results
}

/** 校验用户手动指定的路径存在性 */
export async function checkManualPath(p: string): Promise<boolean> {
  try {
    const fs = await import('node:fs')
    return fs.existsSync(p)
  } catch {
    return false
  }
}

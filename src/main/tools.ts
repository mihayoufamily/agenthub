// 模型 Agent 工具层：沙箱文件操作 + 命令执行（Agent 级授权制）
// 所有文件路径在沙箱根（ToolGrant.dir）内规范化校验，逃逸即拒绝；
// 命令以沙箱根为工作目录运行，超时与输出有上限，全程记录可追溯。
import { promises as fs } from 'node:fs'
import { resolve as resolvePath, dirname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolGrant } from '../shared/types'

const MAX_READ = 200 * 1024 // 读文件上限
const MAX_WRITE = 1024 * 1024 // 写文件上限
const MAX_LIST = 500 // 列目录条目上限
const MAX_OUTPUT = 100 * 1024 // 命令输出/工具结果上限
export { MAX_OUTPUT }
const CMD_TIMEOUT_MS = 60_000 // 命令超时

/** OpenAI function calling 工具定义（发给模型的 schema；命令执行仅授权后可见） */
export function toolDefs(allowCommands: boolean): unknown[] {
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
    }
  ]
  if (allowCommands) {
    defs.push({
      type: 'function',
      function: {
        name: 'run_command',
        description: '在沙箱目录内执行一条 shell 命令（工作目录为沙箱根；超时 60 秒）。用于构建、测试产物等',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '完整命令行' } },
          required: ['command']
        }
      }
    })
  }
  return defs
}

/** 沙箱校验：路径规范化后必须仍在沙箱根内（防 ../ 逃逸与绝对路径注入） */
function sandboxPath(grant: ToolGrant, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null
  const root = resolvePath(grant.dir).toLowerCase()
  const abs = resolvePath(grant.dir, rel).toLowerCase()
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

export interface ToolExecResult {
  ok: boolean
  /** 结果文本：成功时为内容/输出摘要；失败时为拒绝/错误原因（会回传给模型） */
  output: string
  /** write_file 成功时的绝对路径（工作流登记 artifacts 用） */
  writtenPath?: string
}

/** 执行一次工具调用。argsJson 为模型输出的 JSON 字符串（解析失败按参数错误处理）。 */
export async function execTool(
  grant: ToolGrant,
  tool: string,
  argsJson: string
): Promise<ToolExecResult> {
  let args: Record<string, unknown> = {}
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    return { ok: false, output: `参数不是合法 JSON：${argsJson.slice(0, 200)}` }
  }
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
      case 'run_command': {
        if (!grant.allowCommands) return { ok: false, output: '拒绝：该 Agent 未授权执行命令' }
        const command = typeof args.command === 'string' ? args.command : ''
        if (!command.trim()) return { ok: false, output: '拒绝：命令为空' }
        return await new Promise<ToolExecResult>((res) => {
          const child = spawn(command, {
            shell: true,
            cwd: resolvePath(grant.dir),
            windowsHide: true,
            timeout: CMD_TIMEOUT_MS
          })
          let out = ''
          const append = (b: Buffer | string) => {
            if (out.length < MAX_OUTPUT) out += b.toString()
          }
          child.stdout?.on('data', append)
          child.stderr?.on('data', append)
          child.on('error', (e) => res({ ok: false, output: `启动失败：${e.message}` }))
          child.on('close', (code, signal) => {
            if (out.length >= MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + '…（输出已截断）'
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
              res({ ok: false, output: `命令超时（${CMD_TIMEOUT_MS / 1000}s）被终止。已产生的输出：\n${out || '（无）'}` })
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

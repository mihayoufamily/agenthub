// 项目约定自动读取：进入工作目录时把 AGENTS.md / CLAUDE.md 原文取出来注入上下文，
// 用户不必把手抄一遍塞进 Agent 常驻提示词。只读约定文件本身，不递归、不跟随目录。
import { promises as fs } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { ConventionFile } from '../shared/types'
import { CONVENTION_FILES } from '../shared/conventions'

export { CONVENTION_FILES, renderConventionsBlock } from '../shared/conventions'

const MAX_PER_FILE = 16 * 1024 // 单文件注入上限
const MAX_TOTAL = 32 * 1024 // 整块注入上限

/**
 * 读取 dir 下的项目约定文件。dir 为空或目录不存在返回空数组（不报错、不创建目录）。
 * 读不到的单个文件跳过（没这个文件是常态，不是异常）。
 */
export async function readConventions(dir?: string): Promise<ConventionFile[]> {
  const root = dir?.trim()
  if (!root) return []
  const out: ConventionFile[] = []
  let total = 0
  for (const name of CONVENTION_FILES) {
    const p = resolvePath(root, name)
    try {
      const st = await fs.stat(p)
      if (!st.isFile()) continue
      const raw = await fs.readFile(p, 'utf8')
      if (!raw.trim()) continue
      const capped = raw.length > MAX_PER_FILE
      const content = capped ? raw.slice(0, MAX_PER_FILE) : raw
      if (total + content.length > MAX_TOTAL) break
      total += content.length
      out.push({ name, path: p, content, ...(capped ? { truncated: true } : {}) })
    } catch {
      continue // 文件不存在 / 无权限：如实跳过
    }
  }
  return out
}

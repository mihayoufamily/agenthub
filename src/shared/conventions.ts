// 项目约定的纯文本拼装（main / renderer 共用；不放 node 依赖，渲染层要直接 import）
import type { ConventionFile } from './types'

/** 依次尝试的文件名（同一目录里多个并存时全部注入，按此顺序） */
export const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md']

/**
 * 拼成注入用的提示词段落。文件名如实标出——注入的是仓库里的文字，
 * 不是 AgentHub 自己的要求，模型和用户都要能看出这段话从哪来。
 */
export function renderConventionsBlock(files: ConventionFile[]): string {
  if (!files.length) return ''
  const head = `【项目约定（AgentHub 自动读取自工作目录下的 ${files.map((f) => f.name).join('、')}，请遵守其中对本机工作的要求）】`
  const body = files
    .map((f) => `--- ${f.name} ---\n${f.content}${f.truncated ? '\n…（该文件超长，已截断）' : ''}`)
    .join('\n\n')
  return `${head}\n${body}`
}

// repo map 的读盘层：扫工作目录，抽每个源码文件的顶层符号。
// 目的很具体：大项目里没有概览时，模型只能靠 grep 摸黑找入口，一次任务能把上下文烧光。
// 这份地图是猜的（没有 AST/LSP），所以提示词里必须带着"别当事实用"那句话。
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { RepoMapFile } from '../shared/types'
import { extractSymbols, renderRepoMap } from '../shared/repomap'
import { listDirFiles } from './checkpoints'

const MAX_FILES = 400 // 最多看多少个源文件
const MAX_BYTES = 200 * 1024 // 单文件超过这个大小不抽符号（大文件多半不是入口）
const MAX_TEXT_BYTES = 60 * 1024 // 单文件最多读多少
const MAP_MAX_CHARS = 6000 // 概览总长上限
/** 只给这些后缀建图：配置、锁文件、图片之类列出来只是噪音 */
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|h|hpp|cc|cpp|rb|php|swift|vue|svelte|sql|proto)$/i

export interface RepoMap {
  text: string
  files: number
  scanned: number
  omitted: number
  truncated: boolean
}

export const EMPTY_REPO_MAP: RepoMap = { text: '', files: 0, scanned: 0, omitted: 0, truncated: false }

/**
 * 生成某目录的概览。目录不存在/读不动一律返回空（不报错、不创建目录）——
 * 没有地图不影响干活，只是模型要多花几次搜索。
 */
export async function buildRepoMap(dir?: string): Promise<RepoMap> {
  const root = dir?.trim()
  if (!root) return EMPTY_REPO_MAP
  const { files, truncated } = await listDirFiles(root, 5000)
  const code = files.filter((f) => CODE_EXT.test(f))
  if (!code.length) return { ...EMPTY_REPO_MAP, files: files.length, truncated }
  const picked = code.slice(0, MAX_FILES)
  const entries: RepoMapFile[] = []
  for (const rel of picked) {
    try {
      const st = await fs.stat(join(root, rel))
      if (!st.isFile() || st.size > MAX_BYTES) continue
      const raw = await fs.readFile(join(root, rel), 'utf8')
      entries.push({ rel, bytes: st.size, symbols: extractSymbols(rel, raw.slice(0, MAX_TEXT_BYTES)) })
    } catch {
      continue // 单个文件读不动不该毁掉整张图
    }
  }
  const rendered = renderRepoMap(entries, MAP_MAX_CHARS, code.length)
  return {
    text: rendered.text,
    files: files.length,
    scanned: entries.length,
    omitted: rendered.omitted + Math.max(0, code.length - picked.length),
    truncated: rendered.truncated || truncated
  }
}

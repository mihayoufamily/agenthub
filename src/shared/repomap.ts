// repo map 的纯提取层：从源码文本里抽出"这个文件对外给了什么"。
// 没有 AST 也没有 LSP（刻意不引：性价比不合），用的是各语言里足够稳的顶层声明正则。
// 因此这份概览会漏、会错——界面与提示词都必须说清它是"猜的概览"，
// 让模型把它当地图用，别当事实用。
import type { RepoMapFile } from './types'

const MAX_SYMBOLS_PER_FILE = 14
const MAX_SYMBOL_LEN = 60

/** 各语言的顶层导出/声明（只认行首，避免把函数体内的局部变量当符号） */
/**
 * 各语言的顶层声明。一律只认行首（第 0 列）：没有 AST 时允许缩进，
 * 就会把函数体里的 `const inner = () => {}` 当成顶层符号，概览噪声盖过主干。
 * 漏掉几个缩进的顶层声明，远比塞进一堆局部变量好。
 */
const PATTERNS: { re: RegExp; test: RegExp }[] = [
  // JS / TS / JSX：export 与顶层 function/class/const/interface/type/enum
  {
    test: /\.(ts|tsx|js|jsx|mjs|cjs)$/i,
    re: /^(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()|(?:abstract\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*))/gm
  },
  // Python（模块级 def/class）
  { test: /\.py$/i, re: /^(?:async\s+)?(?:def\s+([A-Za-z_]\w*)|class\s+([A-Za-z_]\w*))/gm },
  // Go
  { test: /\.go$/i, re: /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/gm },
  // Rust
  { test: /\.rs$/i, re: /^(?:pub\s+)?(?:fn\s+([A-Za-z_]\w*)|struct\s+([A-Za-z_]\w*)|enum\s+([A-Za-z_]\w*)|trait\s+([A-Za-z_]\w*))/gm },
  // C / C++ 的类与结构体
  { test: /\.(h|hpp|c|cc|cpp)$/i, re: /^(?:class|struct)\s+([A-Za-z_]\w*)/gm }
]

/** 从单个文件内容里抽符号（去重、限数量、限长度） */
export function extractSymbols(path: string, text: string): string[] {
  const hit = PATTERNS.find((p) => p.test.test(path))
  if (!hit || !text) return []
  // 注释里的声明不算符号（行注释与块注释都先剥掉）
  const body = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n')
  const out: string[] = []
  const seen = new Set<string>()
  hit.re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = hit.re.exec(body)) !== null) {
    const name = (m.slice(1).find((g) => !!g) ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name.slice(0, MAX_SYMBOL_LEN))
    if (out.length >= MAX_SYMBOLS_PER_FILE) break
  }
  return out
}

/**
 * 拼成注入用的概览：按目录分组，每行 "相对路径 — 符号列表"。
 * 两个上限都要如实标出来，否则模型会以为这就是整个库。
 */
export function renderRepoMap(files: RepoMapFile[], maxChars: number, totalFiles: number): { text: string; omitted: number; truncated: boolean } {
  let used = 0
  const lines: string[] = []
  let omitted = 0
  for (const f of files) {
    const syms = f.symbols.length ? f.symbols.join(', ') : '（未识别到顶层符号）'
    const line = `- ${f.rel}${f.bytes != null ? ` (${(f.bytes / 1024).toFixed(1)}KB)` : ''} — ${syms}`
    if (used + line.length > maxChars) {
      omitted++
      continue
    }
    used += line.length + 1
    lines.push(line)
  }
  const truncated = omitted > 0 || files.length < totalFiles
  const head = `【代码库概览（AgentHub 按行首声明正则扫出来的，不是 AST/LSP，会漏会错；当地图用，别当事实用）】`
  const body = lines.join('\n')
  const tail = truncated
    ? `\n…（概览装不下：另有 ${omitted} 个文件未列出，目录共 ${totalFiles} 个文件。需要看具体实现请直接用文件工具读）`
    : ''
  return { text: lines.length ? `${head}\n${body}${tail}` : '', omitted, truncated }
}

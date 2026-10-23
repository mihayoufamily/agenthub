// 验收项↔文件映射的匹配规则（纯函数，main / renderer / 验证脚本共用）
// 角色报上来的文件名不可信：可能是 "./src/a.ts"、"src\\a.ts"、"a.ts" 甚至根本没这个文件。
// 这里只负责"怎么把引用对上真实路径"，判定结果由界面如实显示，不替模型兜底。

/** 规范化引用：反斜杠转正斜杠、去掉 ./ 与开头的 /，转小写 */
export function normalizeRef(s: string): string {
  return s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim().toLowerCase()
}

export interface FileRefMatch {
  found: boolean
  /** 命中的真实相对路径（找不到时为 null） */
  rel: string | null
  /** 命中方式：整路径相等，或只有文件名相同（后者要提示"路径可能不精确"） */
  by?: 'path' | 'name'
}

/**
 * 把一条文件引用对到目录清单上：先按整相对路径匹配，再退到文件名唯一匹配
 * （文件名撞车时不猜，直接算没找到，让界面去问人）。
 */
export function matchFileRef(ref: string, files: string[]): FileRefMatch {
  const want = normalizeRef(ref)
  if (!want) return { found: false, rel: null }
  for (const f of files) if (normalizeRef(f) === want) return { found: true, rel: f, by: 'path' }
  const base = want.split('/').pop() ?? ''
  const hits = files.filter((f) => (normalizeRef(f).split('/').pop() ?? '') === base)
  if (hits.length === 1) return { found: true, rel: hits[0], by: 'name' }
  return { found: false, rel: null }
}

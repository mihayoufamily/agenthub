/**
 * 计划轮结束后，把"开工前的目录清单"与"现在的清单"折成差集。
 *
 * CLI 角色的写盘与命令由它自己的子进程执行，AgentHub 拦不到——只能事后如实列出来
 * （spec 批次 F / 决策记录 A6）。所以这里只算路径集合，不读内容、不判对错、更不删任何东西。
 */

/** 归一成一个比较用的键：反斜杠当斜杠、大小写不敏感（Windows 真盘上同一文件两种写法） */
const key = (s: unknown): string => (typeof s === 'string' ? s.trim().replace(/\\/g, '/').toLowerCase() : '')

/**
 * before / after 是两次目录清单。任一侧不是数组就按空表处理：
 * 这份数据来自 IPC，宁可报"看不出来"也不许在确认门渲染前抛掉整扇门。
 */
export function dirDelta(before: unknown, after: unknown): { added: string[]; removed: string[] } {
  const b = (Array.isArray(before) ? before : []).map(key).filter(Boolean)
  const a = (Array.isArray(after) ? after : []).map(key).filter(Boolean)
  const bs = new Set(b)
  const as = new Set(a)
  return { added: a.filter((x) => !bs.has(x)).sort(), removed: b.filter((x) => !as.has(x)).sort() }
}

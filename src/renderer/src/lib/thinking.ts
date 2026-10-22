// 思考过程摘要：按段落打分挑出"重要"的思考，其余默认收起（思考过长时正文会被淹没）
// 只做展示层筛选，不修改模型原文——展开后仍是完整思考内容。

/** 高信号词（决定/结论/因果/风险/验证）：命中越多越像"要看的那段" */
const SIGNAL: [RegExp, number][] = [
  [/因此|所以|于是|结论|总结|最终|决定|选择|改为|改用|采用/g, 3],
  [/需要|必须|应该|应当|方案|计划|接下来|下一步/g, 2],
  [/风险|问题|错误|失败|原因|因为|由于|注意|避免|导致/g, 2],
  [/验证|测试|检查|确认|运行|构建|部署|对比/g, 1],
  [/实现|代码|文件|函数|接口|配置|目录|修复|新增/g, 1]
]

/** 低信号开头（"让我看看"式的过场思考） */
const FILLER = /^(让我|我先|首先，?我|现在我|接下来我|好的|嗯+|首先我看)/

/** 超过这个长度还没有分段迹象的思考，按换行/句子强行分段 */
const LONG_UNFORMATTED = 600

/**
 * 切段：先按空行；模型不给空行时按换行；连换行都没有（一坨长文）时按句断，
 * 否则长思考永远切不出段，"只保留重点"就形同不存在。
 */
function splitParagraphs(text: string): string[] {
  const clean = text.trim()
  if (!clean) return []
  let paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paras.length <= 2 && clean.length > LONG_UNFORMATTED) {
    paras = clean.split(/\n+/).map((p) => p.trim()).filter(Boolean)
  }
  if (paras.length <= 2 && clean.length > LONG_UNFORMATTED) {
    const units = clean.split(/(?<=[。！？；?!;])/).map((s) => s.trim()).filter(Boolean)
    const chunks: string[] = []
    let buf = ''
    for (const u of units) {
      buf += u
      if (buf.length >= 200) {
        chunks.push(buf.trim())
        buf = ''
      }
    }
    if (buf.trim()) chunks.push(buf.trim())
    if (chunks.length > 2) paras = chunks
  }
  return paras
}

function scoreParagraph(p: string): number {
  let score = 0
  for (const [re, w] of SIGNAL) {
    const m = p.match(re)
    if (m) score += w * Math.min(m.length, 3)
  }
  if (FILLER.test(p)) score -= 2
  if (/```/.test(p) || /^\s*(?:[-*]|\d+[.)])\s/m.test(p)) score += 1 // 含代码或清单通常是行动方案
  if (p.length > 1200) score -= 1 // 超长独白多为重复铺陈
  return score
}

export interface ThinkingDigest {
  /** 重要段落拼成的展示文本 */
  keepText: string
  /** 被默认收起的段数 */
  restCount: number
  /** 总段数 */
  total: number
}

/**
 * ≤2 段的短思考不裁剪（裁了反而丢信息）；长思考按分数取前 5 段并保持原文顺序。
 * 全段都低分时保底保留最后两段——结论一般在末尾。
 */
export function digestThinking(text: string): ThinkingDigest {
  const paras = splitParagraphs(text)
  if (paras.length <= 2) return { keepText: text.trim(), restCount: 0, total: paras.length }
  const scored = paras.map((p, i) => ({ p, i, s: scoreParagraph(p) }))
  const strong = scored.filter((x) => x.s >= 3)
  const picked = (strong.length > 0 ? strong : scored.slice(-2))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .sort((a, b) => a.i - b.i)
  const keepSet = new Set(picked.map((x) => x.i))
  return {
    keepText: picked.map((x) => x.p).join('\n\n'),
    restCount: paras.length - keepSet.size,
    total: paras.length
  }
}

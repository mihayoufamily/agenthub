// 模型回复里的图片语法解析（shared 纯函数，零依赖）：
// 渲染层 MessageBody 用它把回复切成 文本/代码块/图片 三种段；主进程 image:fetch
// 通道复用 isValidImageSrc / isRemoteImageSrc 做入参校验（同一份判定，不许漂移）。
// 纯函数、无任何 import：shared 层要在纯 node 与渲染两端同构可用（禁引清单见 fixes-check）。

/** 一个消息段：文本段 / 代码块段（content 已剥语言行）/ 图片段 */
export interface MsgSegment {
  kind: 'text' | 'code' | 'image'
  /** text/code 段为该段正文；image 段为命中的原文（保真，不重排） */
  content: string
  /** image 段：alt 文本，允许为空（`![](url)` 很常见） */
  alt?: string
  /** image 段：图片地址（已去两端空白） */
  src?: string
  /** image 段：data = 内嵌 data URL（直接渲染）；remote = http(s)，需走主进程代理下载 */
  origin?: 'data' | 'remote'
}

/**
 * 图片地址合法性：仅接受 data:image/* 与 http(s) 两种来源。
 * 这是"防误伤"闸：`![x](ftp://…)`、`![x](/local/path)` 都不是图片，
 * 整段按原文保留——模型偶尔输出链接语法变体，错把它当图渲染会吃掉原文。
 */
export function isValidImageSrc(src: string): boolean {
  if (typeof src !== 'string') return false
  const s = src.trim().toLowerCase()
  return s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://')
}

/** 是否远程图片（仅 http(s)）：主进程 image:fetch 通道只代理这类地址；data: 图不需要下载 */
export function isRemoteImageSrc(src: string): boolean {
  if (typeof src !== 'string') return false
  const s = src.trim().toLowerCase()
  return s.startsWith('http://') || s.startsWith('https://')
}

/**
 * 标准 markdown 图片语法：alt 允许为空；src 不含空白与括号（两端空白容忍）。
 * 有意不用更宽的正则：src 里带括号/空白的"图片"极罕见，宽松匹配会吞掉正常文本；
 * 解析不出完整语法（流式中间态常见的 `![...](…` 残缺）自然落不进 match，按原文保留。
 */
const IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g

/**
 * 把模型回复切成分段（与 MessageBody 原有 split(/```/g) 结构同构）：
 * - 奇数段是代码围栏 → kind 'code'，剥掉语言行（保持 MessageBody 现行行为）；
 * - 偶数段是文本 → 段内解析图片语法。**围栏内的图片语法一律不解析**：
 *   代码块里的 `![x](…)` 是示例代码不是图，把它渲染成 <img> 会改写代码语义。
 * - 文本里只有完整命中 IMAGE_RE 且 src 过了 isValidImageSrc 的才算图片；
 *   其余（残缺语法、非图片协议）随所在文本段原样保留。
 * 脏输入安全：null/非字符串/空串 → 空数组，不抛（消息文本来自接口流，形状不作保证）。
 */
export function parseMessageSegments(text: string): MsgSegment[] {
  if (typeof text !== 'string' || !text) return []
  const segs: MsgSegment[] = []
  const parts = text.split(/```/g)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // 与 MessageBody 原实现同一句剥语言行：复制按钮与屏幕显示才能用同一份文本
      segs.push({ kind: 'code', content: parts[i].replace(/^\w*\n/, '') })
      continue
    }
    pushTextWithImages(segs, parts[i])
  }
  return segs
}

/** 文本段内解析图片：命中即插入 image 段，未命中（协议不合法）原样留在文本流里 */
function pushTextWithImages(segs: MsgSegment[], text: string): void {
  let last = 0
  for (const m of text.matchAll(IMAGE_RE)) {
    const src = m[2].trim()
    if (!isValidImageSrc(src)) continue
    const at = m.index ?? 0
    if (at > last) segs.push({ kind: 'text', content: text.slice(last, at) })
    segs.push({
      kind: 'image',
      content: m[0],
      alt: m[1],
      src,
      origin: src.startsWith('data:') ? 'data' : 'remote'
    })
    last = at + m[0].length
  }
  const rest = text.slice(last)
  if (rest) segs.push({ kind: 'text', content: rest })
}

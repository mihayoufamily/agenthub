// 流式揭示边缘的逐字淡入：只把最后 N 个字符包成动画 span，其余走纯文本（性能——
// 整段逐字 span 在千字消息上是每帧重建上千个节点，边缘 14 个是"看得见动效"与"不拖累渲染"的平衡点）
import React from 'react'

export function FadeTail({ text, enabled, tail = 14 }: { text: string; enabled?: boolean; tail?: number }) {
  if (!enabled || text.length === 0) return <>{text}</>
  const arr = Array.from(text)
  const cut = Math.min(tail, arr.length)
  const head = arr.slice(0, arr.length - cut).join('')
  const chars = arr.slice(arr.length - cut)
  // key 用绝对下标：追加式文本里同一个字符的 span 跨帧稳定存在，动画只在挂载那刻播一次。
  // 换行符不包 span：inline-block 内的 \n 会把盒子撑成两行高的空块（pre-wrap 下渲染为强制断行
  // 的空行框），在思考流式边缘顶出一条条垂直空白（2026-10-26 用户实测"大面积空白"的次级来源）
  return (
    <>
      {head}
      {chars.map((c, i) =>
        c === '\n' ? (
          c
        ) : (
          <span key={arr.length - cut + i} className="ch-fade" data-ch={c}>
            {c}
          </span>
        )
      )}
    </>
  )
}

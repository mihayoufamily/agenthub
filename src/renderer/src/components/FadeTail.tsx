// 流式揭示边缘的逐字淡入：只把最后 N 个字符包成动画 span，其余走纯文本（性能——
// 整段逐字 span 在千字消息上是每帧重建上千个节点，边缘 14 个是"看得见动效"与"不拖累渲染"的平衡点）
import React from 'react'

export function FadeTail({ text, enabled, tail = 14 }: { text: string; enabled?: boolean; tail?: number }) {
  if (!enabled || text.length === 0) return <>{text}</>
  const arr = Array.from(text)
  const cut = Math.min(tail, arr.length)
  const head = arr.slice(0, arr.length - cut).join('')
  const chars = arr.slice(arr.length - cut)
  // key 用绝对下标：追加式文本里同一个字符的 span 跨帧稳定存在，动画只在挂载那刻播一次
  return (
    <>
      {head}
      {chars.map((c, i) => (
        <span key={arr.length - cut + i} className="ch-fade" data-ch={c}>
          {c}
        </span>
      ))}
    </>
  )
}

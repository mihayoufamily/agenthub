// AgentHub 原始临时标识（可整体替换）：暗色圆角底板 + 黄色节点连线构成"上升三角/A"意象
// 替换方式：换掉本组件返回的 SVG 即可，调用方尺寸不变
import React from 'react'

export function Logo({ size }: { size?: number }) {
  const s = size ?? ('100%' as unknown as number)
  return (
    <svg width={s} height={s} viewBox="0 0 64 64" fill="none" aria-label="AgentHub logo" style={{ display: 'block' }}>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="#0b0b0c" stroke="rgba(247,242,232,0.25)" strokeWidth="1.5" />
      <path d="M32 20 L21 43" stroke="#e8a33d" strokeWidth="3" strokeLinecap="round" />
      <path d="M32 20 L43 43" stroke="#e8a33d" strokeWidth="3" strokeLinecap="round" />
      <path d="M26 35 L38 35" stroke="#f7f2e8" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="32" cy="19" r="4.2" fill="#e8a33d" />
      <circle cx="20" cy="44" r="4.2" fill="#f7f2e8" />
      <circle cx="44" cy="44" r="4.2" fill="#f7f2e8" />
    </svg>
  )
}

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="var(--brand-ink)" stroke="rgba(247,242,232,0.2)" strokeWidth="2" />
      <path d="M32 20 L21 43" stroke="#e8a33d" strokeWidth="4" strokeLinecap="round" />
      <path d="M32 20 L43 43" stroke="#e8a33d" strokeWidth="4" strokeLinecap="round" />
      <path d="M26 35 L38 35" stroke="#f7f2e8" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  )
}

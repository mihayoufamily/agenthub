// 兼容模式常驻徽章：只在"实际已降级"时出现。沙箱关闭不是可以藏在设置页里的事实。
import { useEffect, useState } from 'react'
import { bridge } from '../lib/ipc'
import { compatBadgeText } from '@shared/compat'
import type { CompatState } from '@shared/compat'

export function CompatBadge() {
  const [state, setState] = useState<CompatState | null>(null)
  useEffect(() => {
    void bridge.app.compat().then(setState).catch(() => setState(null))
  }, [])
  // 措辞由共享纯函数按**事实**算：读不到状态、或什么都没关，就不渲染（不常驻当噪音）
  const text = compatBadgeText(state)
  if (!text || !state) return null
  return (
    <span
      className="full-access-badge"
      data-compat-badge={state.reason}
      title={`兼容模式：${text.replace('兼容模式 · ', '')}（策略 ${state.policy}）。设置 → 关于 可改。`}
      style={{ background: 'var(--warn-bg)', color: 'var(--warn)', borderColor: 'var(--warn)' }}
    >
      {text}
    </span>
  )
}

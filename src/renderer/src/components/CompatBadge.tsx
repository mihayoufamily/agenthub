// 兼容模式常驻徽章：只在"实际已降级"时出现。沙箱关闭不是可以藏在设置页里的事实。
// 挂载点只有一个（Task 6 评审 finding 3）：Shell——工作站/工作流两种模式都经过它。
// 没降级时本组件返回 null，不渲染任何东西，连占位容器都不留。
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
      style={{
        // 脱离各顶栏的浮动定位（单挂 Shell 后不再属于任何一条 topbar）：顶部居中，
        // 三种顶栏（.wb-topbar 空状态/ChatView、.wf-topbar）的中段都是空白区，不与动作按钮重叠
        position: 'absolute',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 30,
        background: 'var(--warn-bg)',
        color: 'var(--warn)',
        borderColor: 'var(--warn)'
      }}
    >
      {text}
    </span>
  )
}

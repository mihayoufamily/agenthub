// 兼容模式常驻徽章：只在"实际已降级"时出现。沙箱关闭不是可以藏在设置页里的事实。
// 挂载点只有一个（Task 6 评审 finding 3 / Ruling M）：Shell——工作站/工作流两种模式都经过它。
// 没降级时本组件返回 null，不渲染任何东西，连占位容器都不留。
import { useEffect, useState } from 'react'
import { bridge } from '../lib/ipc'
import { useUi } from '../stores/ui'
import { compatBadgeText } from '@shared/compat'
import type { CompatState } from '@shared/compat'

/**
 * 「发现新版本」横幅在时，徽章要下移到它之下——这个数是**实测**出来的，不是拍的：
 * .update-banner 是 position:fixed; top:14（components.css），真机上量到 height 43.3 → bottom 57.3；
 * 徽章高 20。取 68 留出约 10px 间隙（verify/approval-shot.mjs [12b] 断言两个 rect 不相交）。
 * 横幅改了 padding/字号就要跟着改这里，所以两处都写死同一个事实。
 */
const BADGE_TOP = 10
const BADGE_TOP_UNDER_BANNER = 68

export function CompatBadge() {
  const [state, setState] = useState<CompatState | null>(null)
  // 横幅由启动时的静默更新检查置位（App.tsx，3 天节流），所以"版本落后的用户 + 兼容模式"是常态而不是边角
  const updateBanner = useUi((s) => s.updateBanner)
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
        // .update-banner 是 position:fixed; top:14; z-index:900，与徽章原来的 top:10 + zIndex:30
        // **完全重叠**——横幅会把徽章整个盖住，A4 承诺的"常驻可见"就静默失效了。
        // 横幅在就把徽章下移到它之下；**不是**"横幅在就隐藏徽章"，那正是把可见性承诺删掉。
        top: updateBanner ? BADGE_TOP_UNDER_BANNER : BADGE_TOP,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 30,
        // 徽章是纯指示物，不该接走它压在下面的顶栏点击（ChatView 的 chip 簇、.wf-topbar .goal）。
        // 它绝对定位在顶栏中段，窗口窄/顶栏内容长时就会压到可点元素上。
        pointerEvents: 'none',
        background: 'var(--warn-bg)',
        color: 'var(--warn)',
        borderColor: 'var(--warn)'
      }}
    >
      {text}
    </span>
  )
}

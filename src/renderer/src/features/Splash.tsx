// 开屏与欢迎页（同一连续场景）：
// 黑底 -> Logo 淡入 -> "agenthub" 上移淡入 -> 背景过渡奶白 + Logo 上移 -> "开始"按钮浮现
// 每次启动均播放完整动画（用户要求，2026-10-21 定稿）；
// 点"开始"后固定进入品牌首页（"今天要构建什么"，模式用户自选）；支持 Esc 跳过动画、减少动态效果
import React, { useEffect } from 'react'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { Logo } from '../components/Logo'

export function Splash({ onRestore }: { onRestore: () => void }) {
  const stage = useUi((s) => s.splashStage)
  const setStage = useUi((s) => s.setSplashStage)
  const prefs = useSettings((s) => s.prefs)
  const patchPrefs = useSettings((s) => s.patchPrefs)
  const toast = useUi((s) => s.toast)

  useEffect(() => {
    // 减少动态效果：直接进入最终稳定态（仍有"开始"按钮，仅跳过过渡动画）
    const reduced = prefs?.reducedMotion || prefs?.animations === false
    if (reduced) {
      setStage('stable')
      return
    }

    // 完整时间线（规格 §3 初始调校值）——每次启动播放
    setStage('black')
    const timers = [
      setTimeout(() => setStage('logo'), 250),
      setTimeout(() => setStage('word'), 500),
      setTimeout(() => setStage('cream'), 900),
      setTimeout(() => setStage('ready'), 1300)
    ]
    const skip = () => {
      timers.forEach(clearTimeout)
      setStage('stable')
    }
    window.addEventListener('keydown', skip, { once: true })
    return () => {
      timers.forEach(clearTimeout)
      window.removeEventListener('keydown', skip)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onStart = () => {
    // 点击后立即响应，防重复触发由 CSS pointer-events 保证
    patchPrefs({ firstRunDone: true })
    toast('欢迎使用 AgentHub', 'ok')
    // 进入品牌首页（"今天要构建什么"）；运行中任务由 onRestore 后台恢复
    onRestore()
  }

  return (
    <div
      className="splash"
      data-stage={stage}
      role="presentation"
    >
      <div className="splash-inner">
        <div className="splash-logo">
          <Logo />
        </div>
        <div className="splash-word">agenthub</div>
      </div>
      <div className="splash-start-wrap">
        <button className="btn-start" onClick={onStart}>
          开始
        </button>
      </div>
      {stage !== 'stable' && (
        <button className="splash-skip" onClick={() => setStage('stable')}>
          跳过（Esc）
        </button>
      )}
    </div>
  )
}

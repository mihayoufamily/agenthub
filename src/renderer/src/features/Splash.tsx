// 开屏与欢迎页（同一连续场景）：
// 黑底 -> Logo 淡入 -> "agenthub" 上移淡入 -> 背景过渡奶白 + Logo 上移 -> "开始"按钮浮现
// 支持：跳过（Esc/点击）、减少动态效果、首次完整展示、后续启动恢复上次工作区
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

  const firstRun = !prefs?.firstRunDone
  const replay = !!prefs?.replayWelcome
  const playWelcome = firstRun || replay

  useEffect(() => {
    // 跳过/减少动态效果：直接进入最终稳定态
    const reduced = prefs?.reducedMotion || prefs?.animations === false
    if (reduced) {
      if (playWelcome) {
        setStage('stable')
      } else {
        const t = setTimeout(onRestore, 250)
        return () => clearTimeout(t)
      }
      return
    }

    if (!playWelcome) {
      // 后续启动：短开屏后直接恢复上次工作区（不卡开屏、可跳过）
      setStage('black')
      const t = setTimeout(onRestore, 800)
      const skip = () => {
        clearTimeout(t)
        onRestore()
      }
      window.addEventListener('keydown', skip, { once: true })
      window.addEventListener('mousedown', skip, { once: true })
      return () => {
        clearTimeout(t)
        window.removeEventListener('keydown', skip)
        window.removeEventListener('mousedown', skip)
      }
    }

    // 完整时间线（规格 §3 初始调校值）
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
    patchPrefs({ firstRunDone: true, replayWelcome: false })
    toast('欢迎使用 AgentHub', 'ok')
    useUi.getState().setScreen('brand')
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

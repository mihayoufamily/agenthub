// 流式文本的柔和输出（打字机层）：底层 text 不管一块一块到得多快，显示层按恒定速率逐字揭示。
// 只做显示层，不碰模型数据流——消息原文始终是完整收到的，历史消息不受影响。
import { useEffect, useRef, useState } from 'react'

/**
 * @param full    底层完整文本（随流式 delta 增长）
 * @param enabled 仅对流式中的消息开启；关闭时直接返回全文（流结束/减少动态效果/历史消息）
 * @returns 当前应显示的文本切片
 *
 * 速率设计：基础 10 字/秒（用户拍定的"一秒10个字"），落后越多转越快
 * （保证缓冲既不无限堆积、也不突然整段蹦出），上限 700 字/秒——
 * 即使网络一次吐一大段，追平过程仍然连续可读。揭示边缘的逐字淡入由 FadeTail 组件负责（本 hook 只管节奏）。
 * rAF 循环读 ref 而不是依赖重跑：delta 每个 chunk 到达都会变 full，依赖数组若含 full 会
 * 每块重启一次循环；ref 方式下循环只在 enabled 翻转时启停，帧内永远读最新值。
 */
export function useSmoothText(full: string, enabled: boolean): string {
  const [shown, setShown] = useState(() => (enabled ? '' : full))
  const shownRef = useRef(enabled ? 0 : full.length)
  const fullRef = useRef(full)
  fullRef.current = full

  useEffect(() => {
    // 关闭（流结束/减少动态效果）且没有积压：立即补满。
    // 有积压时**继续播完**——CLI 类 harness（如 CodeBuddy）的正文是结束前一整块到达的，
    // 若只认 streaming 窗口，动画窗口和文本存在的时间窗完全不重叠，打字机永远瞬弹
    // （2026-10-25 用户实测"几十个字还是一瞬间弹出来"的真实根因）。
    if (!enabled && shownRef.current >= fullRef.current.length) {
      shownRef.current = fullRef.current.length
      setShown(fullRef.current)
      return
    }
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(now - last, 200) // 后台标签页/窗口遮挡时 rAF 被钳到秒级，限幅防大跳
      last = now
      const target = fullRef.current.length
      const behind = target - shownRef.current
      if (behind > 0) {
        const speed = Math.min(10 + behind * 1.5, 700)
        shownRef.current = Math.min(target, shownRef.current + (speed * dt) / 1000)
        setShown(fullRef.current.slice(0, Math.floor(shownRef.current)))
      }
      // 只要 enabled 就持续转（delta 到达只更新 fullRef，没人会重启循环）；
      // enabled 关掉后把积压播完再停——停的条件是"追平且已关闭"
      if (behind > 0 || enabled) raf = requestAnimationFrame(tick)
      else {
        shownRef.current = target
        setShown(fullRef.current)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  return enabled ? shown : full
}

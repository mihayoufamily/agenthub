// 流式文本的柔和输出（打字机层）：底层 text 不管一块一块到得多快，显示层按恒定速率逐字揭示。
// 只做显示层，不碰模型数据流——消息原文始终是完整收到的，历史消息不受影响。
import { useEffect, useRef, useState } from 'react'

/**
 * @param full    底层完整文本（随流式 delta 增长）
 * @param enabled 流式进行中（动画主窗口）。**流结束后积压仍会播完**——CLI 类 harness
 *                （如 CodeBuddy）的正文是结束前一整块到达的，若动画窗口绑死在 streaming
 *                标志上，窗口与文本存在的时间窗完全不重叠，打字机永远瞬弹
 *                （2026-10-25 用户三轮实测的叠加根因）。排空期的"淡入边缘"由调用方用
 *                `shown.length < full.length` 推导（本 hook 返回值就是 shown）。
 * @returns 当前应显示的文本切片
 *
 * 生命周期：effect 依赖 [enabled]——流式中循环常转（delta 只更新 ref，无需重启）；
 * 流结束（enabled 翻 false）时若仍有积压，循环继续把积压播完再自停；
 * 追平自停后，下一个 delta 靠 enabled 翻转（流开始）拉起新循环。
 * 速率：基础 10 字/秒（用户拍定），落后越多越快（上限 700），缓冲永不无限堆积。
 */
export function useSmoothText(full: string, enabled: boolean): string {
  const [shown, setShown] = useState(() => (enabled ? '' : full))
  const shownRef = useRef(enabled ? 0 : full.length)
  const fullRef = useRef(full)
  fullRef.current = full

  useEffect(() => {
    // 关闭且没有积压：无事可做（shown 已是全文）
    if (!enabled && shownRef.current >= fullRef.current.length) {
      if (shownRef.current !== fullRef.current.length) {
        shownRef.current = fullRef.current.length
        setShown(fullRef.current)
      }
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
      // enabled 中常转（delta 随时可能到达）；关闭后把积压播完再自停。
      // "追平就停"只允许发生在 enabled=false 的分支——enabled 中自停会让后续 delta
      // 无人拉起循环（2026-10-25 卡死事故的根因）
      if (behind > 0 || enabled) raf = requestAnimationFrame(tick)
      else {
        shownRef.current = target
        setShown(fullRef.current)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  // 返回 shown（永远不是 full 直通）：排空期间 enabled 已是 false，
  // 若这里切回 full 就瞬弹。shown 的同步由 effect 全权负责。
  return shown
}

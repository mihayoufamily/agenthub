// 思考内容展示：长思考默认只呈现重要段落，其余一键展开（原文不改，只改默认可见范围）
import React, { useMemo, useState } from 'react'
import { digestThinking } from '../lib/thinking'
import { useSmoothText } from '../lib/smoothText'
import { useSettings } from '../stores/settings'

export function ThinkingText({ text, streaming }: { text: string; streaming?: boolean }) {
  const [showRest, setShowRest] = useState(false)
  const reducedMotion = useSettings((s) => s.prefs?.reducedMotion === true)
  // 流式期间柔和逐字揭示（与聊天气泡同一节奏）；"减少动态效果"用户直接看原文
  const shown = useSmoothText(text, streaming === true && !reducedMotion)
  const d = useMemo(() => digestThinking(text), [text])
  // 流式期间不过筛：用户正在看它实时生长，裁剪会造成"内容跳变"
  const filtered = !streaming && d.restCount > 0 && !showRest
  return (
    <div className="thinking-view">
      <div className="tv-body">{filtered ? d.keepText : shown}</div>
      {d.restCount > 0 && !streaming && (
        <button className="link-btn" onClick={() => setShowRest((v) => !v)}>
          {showRest ? '收起其余思考' : `展开其余 ${d.restCount} 段思考`}
        </button>
      )}
    </div>
  )
}

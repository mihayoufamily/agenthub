// 可折叠过程区：运行中展开实时输出；完成后默认折叠突出结果；用户展开过的不再自动收起
import React, { useEffect, useRef, useState } from 'react'
import type { ProcessEvent } from '@shared/types'
import { Icon } from './Icons'
import { ThinkingText } from './Thinking'
import { cls } from '../lib/utils'

export function Collapse({
  title,
  events,
  streaming,
  demo
}: {
  title: string
  events: ProcessEvent[]
  streaming: boolean
  demo?: boolean
}) {
  const [open, setOpen] = useState(false)
  const touchedRef = useRef(false)

  // 运行中跟随展开（直播）；完成时若用户没有手动操作过则收起
  useEffect(() => {
    if (streaming) setOpen(true)
    else if (!touchedRef.current) setOpen(false)
  }, [streaming])

  const toggle = () => {
    touchedRef.current = true
    setOpen((o) => !o)
  }

  return (
    <div>
      <button className="collapse-toggle" data-open={open} onClick={toggle} aria-expanded={open}>
        <span className="collapse-arrow">
          <Icon name="chevron" size={13} />
        </span>
        {title}
        {demo && <span className="demo-badge" style={{ marginLeft: 4 }}>演示</span>}
      </button>
      {open && (
        <div className="collapse-body">
          {events.map((ev, i) => (
            <div key={i} className={cls('ev', ev.kind)}>
              <span className="k">{ev.kind === 'tool' ? '工具' : ev.kind === 'log' ? '日志' : ev.kind === 'summary' ? '摘要' : '思考'}</span>
              <span className="t">{new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              {ev.kind === 'thinking' ? <ThinkingText text={ev.text} streaming={streaming} /> : <span>{ev.text}</span>}
            </div>
          ))}
          {events.length === 0 && <div className="ev"><span>暂无过程记录</span></div>}
        </div>
      )}
    </div>
  )
}

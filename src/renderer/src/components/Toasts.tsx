// Toast 宿主：轻量通知；必须处理的关键错误不放 Toast（用模态框或就地提示）
import React from 'react'
import { useUi } from '../stores/ui'
import { cls } from '../lib/utils'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', t.kind === 'error' && 'error', t.kind === 'warn' && 'warn')}>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

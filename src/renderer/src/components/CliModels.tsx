// CLI 的模型清单：能枚举时列出可点选项（点击回填到输入框），否则只给一句说明
// 清单由主进程适配层提供（CodeBuddy 解析 --help、Codex 读 catalog），不可枚举的 CLI 如实说明
import { useEffect, useState } from 'react'
import type { CliName } from '@shared/types'
import { bridge } from '../lib/ipc'

const hintStyle = { fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 8 } as const

export function CliModelOptions({
  cli,
  current,
  onPick
}: {
  cli: CliName
  /** 当前输入框里的值，用于高亮 */
  current: string
  onPick: (model: string) => void
}) {
  const [state, setState] = useState<{ loading: boolean; models?: string[]; message?: string; source?: string }>({ loading: true })

  useEffect(() => {
    let alive = true
    setState({ loading: true })
    void bridge.cli
      .models(cli)
      .then((r) => {
        if (alive) setState({ loading: false, models: r.models, message: r.message, source: r.source })
      })
      .catch(() => {
        if (alive) setState({ loading: false, message: '读取模型清单失败，请手动填写' })
      })
    return () => {
      alive = false
    }
  }, [cli])

  if (state.loading) return <div style={hintStyle}>正在读取该 CLI 的模型清单…</div>
  if (!state.models || state.models.length === 0) {
    return <div style={hintStyle}>{state.message ?? '该 CLI 未提供可枚举的模型清单，请手动填写模型 ID'}</div>
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 168, overflowY: 'auto', marginBottom: 8 }}>
      {state.models.map((m) => {
        const on = m === current
        return (
          <button
            key={m}
            type="button"
            title={m}
            onClick={() => onPick(m)}
            style={{
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.6,
              padding: '3px 9px',
              borderRadius: 999,
              cursor: 'pointer',
              border: on ? '1px solid var(--accent, #b45309)' : '1px solid var(--border, rgba(120,120,120,.3))',
              background: on ? 'rgba(180,83,9,.12)' : 'transparent',
              color: on ? 'var(--accent-strong, #b45309)' : 'inherit'
            }}
          >
            {m}
          </button>
        )
      })}
    </div>
  )
}

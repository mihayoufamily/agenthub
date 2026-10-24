import React from 'react'
import type { LedgerUsageRow } from '@shared/types'
import { buildRings, donutPath, type RingSlice } from '@shared/usage-rings'

const PALETTE = ['#b45309', '#0f766e', '#7c3aed', '#b91c1c', '#1d4ed8', '#15803d', '#a16207', '#475569']

/**
 * 零依赖手写 SVG 环（不引图表库）。
 * - `double`：用量统计页，内圈按接入方（harness）、外圈按模型。
 * - `mini`：对话栏底部那个单环（按接入方分色），尺寸小到不放环心数字。
 *
 * 分母只是 **ledger 可见调用**（账本只留最近 2000 条、CLI 多数不上报 usage），
 * 所以未上报的那些按次数单列一格，不折算成 token。
 */
export function DonutRings({ rows, mode = 'double', size = 168, onPickSlice }: {
  rows: LedgerUsageRow[]
  mode?: 'double' | 'mini'
  size?: number
  onPickSlice?: (key: string) => void
}) {
  const { inner, outer, totalTokens, unreportedCalls } = buildRings(rows)
  const c = size / 2
  const arc = (list: RingSlice[], rOut: number, rIn: number, ring: 'inner' | 'outer'): React.ReactElement[] => {
    let a = -Math.PI / 2
    return list
      .filter((s) => s.share > 0)
      .map((s, i) => {
        const a0 = a
        const a1 = a + s.share * Math.PI * 2
        a = a1
        return (
          <path
            key={`${ring}-${s.key}`}
            d={donutPath(c, c, rOut, rIn, a0, a1)}
            fill={PALETTE[i % PALETTE.length]}
            data-ring={ring}
            data-slice={s.key}
            onClick={onPickSlice ? () => onPickSlice(s.key) : undefined}
            style={{ cursor: onPickSlice ? 'pointer' : 'default' }}
          >
            <title>{`${s.label}：${s.tokens.toLocaleString()} token（${Math.round(s.share * 100)}%）· ${s.calls} 次`}</title>
          </path>
        )
      })
  }
  return (
    <div className="usage-rings" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="token 用量占比">
        {mode === 'double' ? (
          <>
            {arc(inner, c * 0.62, c * 0.34, 'inner')}
            {arc(outer, c * 0.98, c * 0.7, 'outer')}
          </>
        ) : (
          arc(inner, c * 0.98, c * 0.6, 'inner')
        )}
        {mode !== 'mini' && (
          <text x={c} y={c + 4} textAnchor="middle" style={{ fontSize: 13, fill: 'var(--text-2)' }}>
            {totalTokens.toLocaleString()}
          </text>
        )}
      </svg>
      {mode !== 'mini' && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
          <div>合计 {totalTokens.toLocaleString()} token（仅账本可见调用）</div>
          <div data-unreported={unreportedCalls}>未上报 usage：{unreportedCalls} 次（按次数计，不估算 token）</div>
        </div>
      )}
    </div>
  )
}

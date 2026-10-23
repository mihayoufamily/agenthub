// 用量统计与最近调用：数据源是主进程的调用账本（只含元数据，不含正文与凭据）。
// 设置页与对话栏的快捷入口共用这一份实现，避免两处口径不一致。
import React, { useEffect, useState } from 'react'
import type { LedgerEntry, LedgerUsageRow, PriceOverride } from '@shared/types'
import { PRICING_AS_OF, validatePriceOverride, configurePriceOverrides, pricingFreshness } from '@shared/pricing'
import { bridge } from '../lib/ipc'
import { useUi } from '../stores/ui'
import { Button, Spinner } from './primitives'
import { Icon } from './Icons'
import { cls, fmtTokens } from '../lib/utils'

const RANGES = [
  { key: 7, label: '近 7 天' },
  { key: 30, label: '近 30 天' },
  { key: 0, label: '全部' }
]

const fmtYuan = (n: number) => (n > 0 ? `¥${n.toFixed(n < 1 ? 4 : 2)}` : '—')

/** 金额是按哪份价算的要写在金额下面：手抄快照与你自己填的价，可靠性不是一回事 */
function freshness(model: string): string {
  const f = pricingFreshness(model)
  if (f.source === 'override') return `自填价${f.asOf ? ` · ${f.asOf}` : ''}`
  if (f.source === 'builtin') return '内置表快照'
  return '无单价'
}
const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`)
const fmtAt = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

/** agentId 传入时只统计该 Agent（对话栏快捷入口用）；不传 = 全部 */
export function UsagePanel({ agentId, compact }: { agentId?: string; compact?: boolean }) {
  const [days, setDays] = useState(30)
  const [rows, setRows] = useState<LedgerUsageRow[] | null>(null)
  const [recent, setRecent] = useState<LedgerEntry[]>([])
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    setBusy(true)
    try {
      const since = days ? Date.now() - days * 86400_000 : 0
      const all = await bridge.ledger.list(100000)
      const mine = agentId ? all.filter((e) => e.agentId === agentId) : all
      setRecent([...mine].reverse().slice(0, compact ? 8 : 30))
      // 聚合复用主进程口径：把过滤后的条目原样回传会绕一圈，这里直接在前端按同一规则聚合
      setRows(rollup(mine.filter((e) => !since || e.ts >= since)))
    } catch {
      setRows([])
      useUi.getState().toast('读取调用账本失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [days, agentId])

  return (
    <div className="usage-panel">
      <div className="usage-head">
        <div className="seg" role="tablist" aria-label="统计范围">
          {RANGES.map((r) => (
            <button key={r.key} role="tab" aria-selected={days === r.key} className={cls('seg-btn', days === r.key && 'on')} onClick={() => setDays(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="usage-note">
          账本只记元数据（耗时 / token / 错误信息），不记请求与响应正文，也不含任何凭据{agentId ? '；当前只统计本 Agent' : ''}。
        </span>
        <span className="usage-acts">
          <Button variant="ghost" style={{ height: 26 }} onClick={() => void bridge.ledger.export().then((r) => { if (r.ok) useUi.getState().toast(`已导出：${r.message}`, 'ok'); else if ((r.message ?? '') !== '已取消') useUi.getState().toast(r.message ?? '导出失败', 'error') })}>
            <Icon name="download" size={13} /> 导出
          </Button>
          <Button
            variant="ghost"
            style={{ height: 26, color: 'var(--danger)' }}
            onClick={async () => {
              if (!window.confirm('清空调用账本？历史用量统计会一起丢失（不影响会话与任务记录）。')) return
              await bridge.ledger.clear()
              useUi.getState().toast('调用账本已清空', 'ok')
              void reload()
            }}
          >
            清空
          </Button>
        </span>
      </div>

      {busy && rows === null && <Spinner />}
      {rows && rows.length === 0 && <div className="usage-empty">这段时间还没有真实调用记录。发一条消息或跑一次工作流后回来看。</div>}
      {rows && rows.length > 0 && (
        <table className="usage-table">
          <thead>
            <tr>
              <th>接入方</th>
              <th>模型</th>
              <th className="num">调用</th>
              <th className="num">失败</th>
              <th className="num">Token（入/出）</th>
              <th className="num">费用</th>
              <th className="num">均耗时</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.harness}|${r.model}`}>
                <td>{r.harness}</td>
                <td className="mono">{r.model}</td>
                <td className="num">{r.calls}</td>
                <td className="num" style={r.failed ? { color: 'var(--danger)' } : undefined}>{r.failed || '—'}</td>
                <td className="num">
                  {fmtTokens(r.tokens)}
                  {r.prompt || r.completion ? <span className="usage-split">（{fmtTokens(r.prompt)}/{fmtTokens(r.completion)}）</span> : ''}
                  {r.noUsage > 0 && <span className="usage-split" title="该接入方未返回 usage，这些调用没有可核对的 token 数"> · {r.noUsage} 次未上报</span>}
                </td>
                <td className="num" data-cost-cell={r.model}>
                  {fmtYuan(r.cost)}
                  {r.cost > 0 && <div className="cost-src" title={freshness(r.model)}>{freshness(r.model)}</div>}
                </td>
                <td className="num">{r.calls ? fmtMs(r.ms / r.calls) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="usage-foot" data-pricing-asof>
        <span className="usage-note">
          内置单价是手写快照（时点：{PRICING_AS_OF}），价格变了或在表里查不到的模型，可在下方自填单价；
          查不到单价的调用<b>只显示 token、不折算金额</b>，所以金额合计是<b>下界</b>而不是总账。
        </span>
        {!compact && <PriceEditor />}
      </div>

      {recent.length > 0 && (
        <div className="usage-recent">
          <div className="usage-subtitle">最近调用</div>
          {recent.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="usage-row" title={e.error ? `${e.harness} · ${e.model ?? ''}\n${e.error}` : `${e.harness} · ${e.model ?? ''}${e.workflow ? ' · 工作流' : ''}`}>
              <span className="t">{fmtAt(e.ts)}</span>
              <span className={cls('st', e.ok ? 'ok' : 'bad')}>{e.ok ? '成功' : '失败'}</span>
              <span className="h">{e.channel === 'cli' ? 'CLI' : '模型'} · {e.harness}</span>
              <span className="m txt-ellipsis">{e.model ?? '—'}</span>
              <span className="n">{e.tokens ? `${fmtTokens(e.tokens)} tk` : e.prompt ? `${fmtTokens((e.prompt ?? 0) + (e.completion ?? 0))} tk` : '—'}</span>
              <span className="n">{e.cost ? fmtYuan(e.cost) : '—'}</span>
              <span className="n">{e.ms ? fmtMs(e.ms) : '—'}</span>
              {e.workflow && <span className="tag">工作流</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 自定义单价覆盖：内置表是手写快照，价格变了或不收录的模型由你填，带填写日期一起显示 */
function PriceEditor() {
  const [list, setList] = useState<PriceOverride[]>([])
  const [pattern, setPattern] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void bridge.prices.get().then(setList)
  }, [])

  const save = async (next: PriceOverride[]) => {
    const r = await bridge.prices.set(next)
    // 主进程落盘 + 本进程立即生效：否则刚填的价要等重启才起作用
    configurePriceOverrides(r.list)
    setList(r.list)
    useUi.getState().toast('单价已更新，后续费用折算按新价计算', 'ok')
  }

  const add = async () => {
    const v = validatePriceOverride({ pattern, input, output })
    if (!v.ok) {
      setErr(v.message ?? '单价不合法')
      return
    }
    setErr('')
    await save([
      ...list,
      { pattern: pattern.trim(), input: Number(input), output: Number(output), asOf: new Date().toISOString().slice(0, 10) }
    ])
    setPattern('')
    setInput('')
    setOutput('')
  }

  return (
    <div className="price-editor" data-price-editor>
      <div className="usage-subtitle">自定义单价（元 / 1M tokens）</div>
      {list.length === 0 && <div className="usage-empty">还没有自填单价：内置表没收录的模型，金额一律显示"—"。</div>}
      {list.map((o, i) => (
        <div key={`${o.pattern}-${i}`} className="usage-row">
          <span className="m mono" title={o.pattern}>{o.pattern}</span>
          <span className="n">入 {o.input}</span>
          <span className="n">出 {o.output}</span>
          <span className="tag">填写于 {o.asOf || '（未填日期）'}</span>
          <button className="link-btn" onClick={() => void save(list.filter((_, n) => n !== i))}>删除</button>
        </div>
      ))}
      <div className="price-add">
        <input placeholder="匹配规则（正则，如 /kimi|qwen-max/i 里的 kimi）" value={pattern} onChange={(e) => setPattern(e.target.value)} style={{ flex: 2 }} />
        <input placeholder="输入价" value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: 1 }} inputMode="decimal" />
        <input placeholder="输出价" value={output} onChange={(e) => setOutput(e.target.value)} style={{ flex: 1 }} inputMode="decimal" />
        <Button variant="secondary" onClick={() => void add()}>添加</Button>
      </div>
      {err && <div className="price-err" data-price-err>{err}</div>}
    </div>
  )
}

/** 与主进程 aggregate 同口径的前端聚合（按 Agent 过滤只能在渲染层做，故不复用主进程结果） */
function rollup(entries: LedgerEntry[]): LedgerUsageRow[] {
  const map = new Map<string, LedgerUsageRow>()
  for (const e of entries) {
    const model = e.model || '（未上报模型名）'
    const key = `${e.harness}|${model}`
    let row = map.get(key)
    if (!row) {
      row = { harness: e.harness, model, calls: 0, ok: 0, failed: 0, tokens: 0, prompt: 0, completion: 0, cost: 0, noUsage: 0, ms: 0 }
      map.set(key, row)
    }
    row.calls++
    if (e.ok) row.ok++
    else row.failed++
    if (!(e.tokens ?? 0) && !(e.prompt ?? 0) && !(e.completion ?? 0)) row.noUsage++
    row.tokens += e.tokens ?? 0
    row.prompt += e.prompt ?? 0
    row.completion += e.completion ?? 0
    row.cost += e.cost ?? 0
    row.ms += e.ms ?? 0
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || b.calls - a.calls)
}

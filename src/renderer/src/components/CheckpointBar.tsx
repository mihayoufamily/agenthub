// 改动检查点条：列出本次任务改过哪些文件（含行级 diff），并提供"回到开始前"。
// 口径必须诚实：只有 AgentHub 工具层的文件操作在清单里，run_command 与 CLI 自己写的文件
// 不在这条链上——所以这里从不声称"撤销一切"，只说"撤销清单里的改动"。
import { useEffect, useState } from 'react'
import type { CheckpointDelta, CheckpointManifest } from '@shared/types'
import { bridge } from '../lib/ipc'
import { useUi } from '../stores/ui'
import { Icon } from './Icons'
import { Button } from './primitives'

const KIND_TEXT = { created: '新建', modified: '修改', deleted: '删除', moved: '移动' } as const

export function CheckpointBar({ id, title }: { id: string; title?: string }) {
  const [manifest, setManifest] = useState<CheckpointManifest | null>(null)
  const [delta, setDelta] = useState<CheckpointDelta | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showDiff, setShowDiff] = useState<string | null>(null)

  const load = () => {
    void bridge.checkpoint.manifest(id).then((r) => {
      setManifest(r.manifest)
      setDelta(r.delta)
    })
  }
  useEffect(load, [id])

  const entries = manifest?.entries ?? []
  const changed = (delta?.added.length ?? 0) + (delta?.removed.length ?? 0)
  // 工具层没改文件但目录确实变了（命令/CLI 干的）也要露出来，不然"看不到"会变成"以为没动过"
  if (!manifest || (entries.length === 0 && changed === 0)) return null
  const count = (k: keyof typeof KIND_TEXT) => entries.filter((e) => e.kind === k).length
  const unbacked = entries.filter((e) => e.unbacked)

  const doRollback = async () => {
    setBusy(true)
    const r = await bridge.checkpoint.rollback(id)
    setBusy(false)
    setConfirming(false)
    useUi.getState().toast(r.ok ? r.message ?? '已回滚' : `回滚未完全成功：${r.message ?? ''}`, r.ok ? 'ok' : 'warn')
    load()
  }

  return (
    <div className="cp-bar" data-checkpoint={id}>
      <div className="cp-head">
        <button type="button" className="cp-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'down' : 'chevron'} size={13} />
          <span>
            {title ?? '本次改动'}：
            {entries.length > 0
              ? `${entries.length} 个文件${count('created') ? ` · 新建 ${count('created')}` : ''}${count('modified') ? ` · 修改 ${count('modified')}` : ''}${count('deleted') ? ` · 删除 ${count('deleted')}` : ''}${count('moved') ? ` · 移动 ${count('moved')}` : ''}`
              : `工具层没改文件，但目录有 ${changed} 处变化（命令或 CLI 产生的，回滚覆盖不到）`}
          </span>
        </button>
        {entries.length === 0 ? null : confirming ? (
          <span className="cp-confirm">
            回滚到开始前？
            <Button variant="ghost" onClick={doRollback} disabled={busy}>确认回滚</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
          </span>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)} data-cp-rollback>
            回滚这些改动
          </Button>
        )}
      </div>
      {open && (
        <div className="cp-list">
          {entries.map((e) => (
            <div key={`${e.kind}:${e.rel}`} className="cp-item">
              <div className="cp-line">
                <span className={`cp-kind cp-${e.kind}`}>{KIND_TEXT[e.kind]}</span>
                <code title={e.path}>{e.rel}</code>
                {e.from && <code className="cp-from">← {e.from}</code>}
                {e.diff ? (
                  <button type="button" className="cp-diff-btn" onClick={() => setShowDiff(showDiff === e.rel ? null : e.rel)}>
                    {showDiff === e.rel ? '收起 diff' : '看 diff'}
                  </button>
                ) : (
                  <span className="cp-nodiff">（无行级 diff）</span>
                )}
              </div>
              {e.unbacked && <div className="cp-warn">未纳入回滚：{e.unbacked}</div>}
              {showDiff === e.rel && <pre className="cp-diff">{e.diff}</pre>}
            </div>
          ))}
          {unbacked.length > 0 && <div className="cp-warn">有 {unbacked.length} 个改动不能回滚，上面已逐条标出原因</div>}
          {delta && (
            <div className="cp-delta" data-checkpoint-delta>
              <div className="cp-delta-title">
                目录对照（开工前 {delta.baseline} 个文件）：新增 {delta.added.length} · 消失 {delta.removed.length}
                {delta.truncated ? ' · 清单过大已截断，只是部分对照' : ''}
              </div>
              {[...delta.added.map((f) => ['新增', f] as const), ...delta.removed.map((f) => ['消失', f] as const)].slice(0, 40).map(([k, f]) => (
                <div key={`${k}:${f}`} className="cp-delta-row">
                  <span className={`cp-kind ${k === '新增' ? 'cp-created' : 'cp-deleted'}`}>{k}</span>
                  <code>{f}</code>
                </div>
              ))}
              {delta.added.length + delta.removed.length > 40 && (
                <div className="cp-note">另有 {delta.added.length + delta.removed.length - 40} 条未列出（只列前 40 条）</div>
              )}
              <div className="cp-note">
                对照看的是整个目录的实际变化，包含模型执行命令与 CLI Agent 自己造成的改动；
                这些不在上面那份回滚清单里的部分，<b>回滚不会处理</b>。
              </div>
            </div>
          )}
          {!delta && <div className="cp-note">目录对照不可用（开工前没拍到基线，通常因为目录当时不存在）。</div>}
          <div className="cp-note">
            清单只覆盖 AgentHub 工具层的文件操作；模型执行命令（run_command）与 CLI Agent 自己写的文件不在这里，
            回滚不会撤销它们。
          </div>
        </div>
      )}
    </div>
  )
}

// 命令审批弹窗：把要跑的 Commands 原样摊在人面前，并说清"为什么要问"。
// 默认焦点在「拒绝」上——手按回车不该等于放行一条没看过的命令。
import { useEffect, useRef } from 'react'
import { useApprovals } from '../stores/approvals'
import { Icon } from './Icons'

export function ApprovalModal() {
  const pending = useApprovals((s) => s.pending)
  const decide = useApprovals((s) => s.decide)
  const req = pending[0]
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (req) denyRef.current?.focus()
  }, [req?.id])

  if (!req) return null
  const more = pending.length - 1

  return (
    <div className="modal-overlay" data-testid="approval-modal">
      <div className="modal warning" role="alertdialog" aria-modal="true" aria-label="命令等待确认" data-approval-modal>
        <div className="modal-head">
          <Icon name="shield" size={18} />
          <span>命令等待确认{more > 0 ? `（还有 ${more} 条排队）` : ''}</span>
        </div>
        <div className="modal-body">
          <pre className="approval-cmd" data-approval-cmd>{req.command}</pre>
          <div className="approval-meta">
            <div><b>发起者</b>{req.agentName ?? '（未知）'}</div>
            <div><b>执行目录</b><span title={req.dir}>{req.dir || '（未设）'}</span></div>
            <div><b>为什么要问</b>{req.reason}</div>
            {req.uncovered?.length ? <div><b>没被白名单覆盖</b>{req.uncovered.join(' ｜ ')}</div> : null}
          </div>
          <div className="approval-note">
            超时（180 秒）没人确认会按<b>拒绝</b>收场，不会替你放行。
            「始终允许」只把上面这些片段写进该 Agent 的白名单；危险形态（rm -rf、format、curl | sh 等）
            即便写进白名单也照样每次确认。
          </div>
        </div>
        <div className="modal-foot">
          <button ref={denyRef} className="btn" data-approval-deny onClick={() => void decide(req.id, 'deny')}>拒绝</button>
          <button className="btn" data-approval-once onClick={() => void decide(req.id, 'once')}>本次允许</button>
          <button className="btn primary" data-approval-always onClick={() => void decide(req.id, 'always')}>始终允许（写入白名单）</button>
        </div>
      </div>
    </div>
  )
}

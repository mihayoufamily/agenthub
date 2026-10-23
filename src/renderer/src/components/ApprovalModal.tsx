// 确认弹窗：命令审批 / 写前 diff 预览 / MCP server 首次连接，三种请求共用一条通道。
// 默认焦点在「拒绝」上——手按回车不该等于放行一条没看过的东西。
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
  const isDiff = req.kind === 'diff'
  const isMcp = req.kind === 'mcp'
  const title = isMcp ? 'MCP server 首次连接' : isDiff ? '写入前确认' : '命令等待确认'

  return (
    <div className="modal-overlay" data-testid="approval-modal">
      <div
        className="modal warning"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-approval-modal
        data-approval-kind={req.kind ?? 'command'}
      >
        <div className="modal-head">
          <Icon name={isMcp ? 'scan' : isDiff ? 'edit' : 'shield'} size={18} />
          <span>{title}{more > 0 ? `（还有 ${more} 条排队）` : ''}</span>
        </div>
        <div className="modal-body">
          <pre className="approval-cmd" data-approval-cmd>{req.command}</pre>
          {isDiff && req.diff && <pre className="approval-cmd cp-diff" data-approval-diff>{req.diff}</pre>}
          {isMcp && (
            <div className="approval-tools" data-approval-mcp-tools>
              <div className="approval-tools-title">它提供 {req.mcpTools?.length ?? 0} 个工具（放行后模型可以直接调用，不再逐个确认）</div>
              {(req.mcpTools ?? []).map((t) => (
                <div key={t.name} className="approval-tool">
                  <code>{t.name}</code>
                  {t.description && <span>{t.description}</span>}
                </div>
              ))}
              {!req.mcpTools?.length && <div className="approval-note">（一个工具都没列到：建议先拒绝，去设置页用"连接并查看工具"排查）</div>}
            </div>
          )}
          <div className="approval-meta">
            {!isMcp && <div><b>{isDiff ? '发起写入' : '发起者'}</b>{req.agentName ?? '（未知）'}</div>}
            <div><b>{isDiff ? '所在目录' : isMcp ? '可用目录' : '执行目录'}</b><span title={req.dir}>{req.dir || '（未设）'}</span></div>
            <div><b>为什么要问</b>{req.reason}</div>
            {!isDiff && !isMcp && req.uncovered?.length ? <div><b>没被白名单覆盖</b>{req.uncovered.join(' ｜ ')}</div> : null}
          </div>
          <div className="approval-note">
            {isMcp
              ? '「始终信任」= 这个 server 以后整组放行，不再逐个确认（设置页可随时撤销）。它的工具会以这条命令的权限在本机执行——只放行你完全信任的 server。拒绝 = 本次不连它，其它工具不受影响。'
              : isDiff
                ? '拒绝=这个文件保持原样，模型会收到"用户取消了这次写入"，不会留下半成品。超时（180 秒）同样按拒绝处理。'
                : '超时（180 秒）没人确认会按拒绝收场，不会替你放行。「始终允许」只把上面这些片段写进该 Agent 的白名单；危险形态（rm -rf、format、curl | sh 等）即便写进白名单也照样每次确认。'}
          </div>
        </div>
        <div className="modal-foot">
          <button ref={denyRef} className="btn" data-approval-deny onClick={() => void decide(req.id, 'deny')}>拒绝</button>
          <button className="btn" data-approval-once onClick={() => void decide(req.id, 'once')}>本次允许</button>
          {!isDiff && (
            <button className="btn primary" data-approval-always onClick={() => void decide(req.id, 'always')}>
              {isMcp ? '始终信任这个 server' : '始终允许（写入白名单）'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

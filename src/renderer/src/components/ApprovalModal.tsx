// 确认弹窗：命令审批 / 写前 diff 预览 / MCP server 首次连接 / 模型提问（ask_user），四种请求共用一条通道。
// 默认焦点在「拒绝」上——手按回车不该等于放行一条没看过的东西；提问形态焦点在输入框。
import { useEffect, useRef, useState } from 'react'
import { useApprovals } from '../stores/approvals'
import { Icon } from './Icons'

export function ApprovalModal() {
  const pending = useApprovals((s) => s.pending)
  const decide = useApprovals((s) => s.decide)
  const answer = useApprovals((s) => s.answer)
  const req = pending[0]
  const denyRef = useRef<HTMLButtonElement>(null)
  const ansRef = useRef<HTMLTextAreaElement>(null)
  const [ans, setAns] = useState('')

  useEffect(() => {
    if (req?.kind === 'question') {
      setAns('')
      ansRef.current?.focus()
    } else if (req) denyRef.current?.focus()
  }, [req?.id])

  if (!req) return null
  const more = pending.length - 1
  const isDiff = req.kind === 'diff'
  const isMcp = req.kind === 'mcp'
  const isQuestion = req.kind === 'question'
  const title = isMcp ? 'MCP server 首次连接' : isDiff ? '写入前确认' : isQuestion ? 'Agent 提问' : '命令等待确认'

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
          <Icon name={isMcp ? 'scan' : isDiff ? 'edit' : isQuestion ? 'info' : 'shield'} size={18} />
          <span>{title}{more > 0 ? `（还有 ${more} 条排队）` : ''}</span>
        </div>
        <div className="modal-body">
          <pre className="approval-cmd" data-approval-cmd>{isQuestion ? (req.question ?? req.command) : req.command}</pre>
          {isQuestion && req.detail && <pre className="approval-cmd" data-approval-detail>{req.detail}</pre>}
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
            {!isMcp && <div><b>{isDiff ? '发起写入' : isQuestion ? '提问的 Agent' : '发起者'}</b>{req.agentName ?? '（未知）'}</div>}
            <div><b>{isDiff ? '所在目录' : isMcp ? '可用目录' : '执行目录'}</b><span title={req.dir}>{req.dir || '（未设）'}</span></div>
            <div><b>为什么要问</b>{req.reason}</div>
            {!isDiff && !isMcp && !isQuestion && req.uncovered?.length ? <div><b>没被白名单覆盖</b>{req.uncovered.join(' ｜ ')}</div> : null}
          </div>
          {isQuestion && (
            <textarea
              ref={ansRef}
              value={ans}
              onChange={(e) => setAns(e.target.value)}
              placeholder="输入你的回答（模型会原文收到，回答后它继续干活）…"
              data-testid="approval-answer-input"
              style={{ width: '100%', minHeight: 84, padding: '8px 10px', fontFamily: 'inherit', fontSize: 13, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', resize: 'vertical', marginBottom: 8 }}
            />
          )}
          <div className="approval-note">
            {isMcp
              ? '「始终信任」= 这个 server 以后整组放行，不再逐个确认（设置页可随时撤销）。它的工具会以这条命令的权限在本机执行——只放行你完全信任的 server。拒绝 = 本次不连它，其它工具不受影响。'
              : isDiff
                ? '拒绝=这个文件保持原样，模型会收到"用户取消了这次写入"，不会留下半成品。超时（180 秒）同样按拒绝处理。'
                : isQuestion
                  ? '「跳过」或超时（180 秒）都会如实告诉模型"用户没有回答"，它会基于现有信息继续并说明假设——不会编造你的回答。'
                  : '超时（180 秒）没人确认会按拒绝收场，不会替你放行。「始终允许」只把上面这些片段写进该 Agent 的白名单；危险形态（rm -rf、format、curl | sh 等）即便写进白名单也照样每次确认。'}
          </div>
        </div>
        <div className="modal-foot">
          {isQuestion ? (
            <>
              <button className="btn" data-approval-skip onClick={() => void answer(req.id, '')}>跳过</button>
              <button className="btn primary" data-approval-answer disabled={!ans.trim()} onClick={() => void answer(req.id, ans)}>回答</button>
            </>
          ) : (
            <>
              <button ref={denyRef} className="btn" data-approval-deny onClick={() => void decide(req.id, 'deny')}>拒绝</button>
              <button className="btn" data-approval-once onClick={() => void decide(req.id, 'once')}>本次允许</button>
              {!isDiff && (
                <button className="btn primary" data-approval-always onClick={() => void decide(req.id, 'always')}>
                  {isMcp ? '始终信任这个 server' : '始终允许（写入白名单）'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Agent 编辑配置弹窗（仅自定义模型类）：名称 / Base URL / 模型 ID / API Key（覆盖式）。
// 与「添加 → 自定义模型」同一套口径：改了连接三元组之一就先真实测连接，通过才写入，
// 失败不保存（旧配置原样保留）。Key 是覆盖式编辑——safeStorage 设计上读不回明文，
// 界面只显示"已配置/未配置"状态，留空 = 沿用已存 Key（主进程侧回退，渲染层不经手）。
import React, { useState } from 'react'
import type { AgentConfig } from '@shared/types'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { Modal } from '../components/Modal'
import { Button } from '../components/primitives'

export function AgentEditModal({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const cfg = agent.modelConfig
  const [name, setName] = useState(cfg?.provider ?? '')
  const [baseUrl, setBaseUrl] = useState(cfg?.baseUrl ?? '')
  const [modelId, setModelId] = useState(cfg?.modelId ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 清除 Key 的两步确认：第一击变"确认清除？"，再击才真删——误点一次不至于断线
  const [confirmClear, setConfirmClear] = useState(false)

  if (!cfg) return null
  const hasKey = cfg.hasKey !== false
  const canSubmit = baseUrl.trim() && modelId.trim() && (hasKey || apiKey.trim()) && !saving

  const save = async () => {
    setSaving(true)
    setErr(null)
    const r = await useAgents.getState().updateModelAgent(agent.id, { name, baseUrl, modelId }, apiKey.trim() || undefined)
    setSaving(false)
    if (r.ok) {
      useUi.getState().toast(`「${name.trim() || agent.name}」配置已更新（${r.message}）`, 'ok')
      onClose()
    } else {
      setErr(r.message)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`编辑配置 —「${agent.name}」`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} disabled={!canSubmit} onClick={() => void save()}>
            {apiKey.trim() || baseUrl.trim() !== cfg.baseUrl || modelId.trim() !== cfg.modelId ? '测试连接并保存' : '保存'}
          </Button>
        </>
      }
    >
      <div style={{ paddingBottom: 8 }}>
        <div className="form-row">
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="显示在侧栏的 Agent 名称" />
          <span className="help">与侧栏「重命名」改的是同一个字段，两处任改即同步</span>
        </div>
        <div className="form-row">
          <label>Base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
          <span className="help">OpenAI 兼容接口地址</span>
        </div>
        <div className="form-row">
          <label>模型 ID</label>
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="如 gpt-4o-mini / deepseek-chat" />
        </div>
        <div className="form-row">
          <label>API Key</label>
          <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setConfirmClear(false) }} placeholder={hasKey ? '留空 = 保持现有 Key 不变' : 'sk-…（未配置，必填）'} />
          <span className="help">
            {hasKey ? '已配置 ✓ · 加密保存在系统凭据存储，读不回明文，换 Key 请直接输入新的覆盖' : '尚未配置 Key，填写后才能对话'}
          </span>
        </div>
        {hasKey && (
          <div style={{ margin: '-4px 0 10px', display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="ghost"
              style={{ height: 24, fontSize: 12, color: confirmClear ? 'var(--danger)' : undefined }}
              title="删除加密存储的 API Key（断开连接，会话历史保留）"
              onClick={async () => {
                if (!confirmClear) { setConfirmClear(true); return }
                await useAgents.getState().clearModelKey(agent.id)
                useUi.getState().toast('已清除该 Agent 的 API Key（连接已断开）', 'ok')
                onClose()
              }}
            >
              {confirmClear ? '确认清除？（再点一次生效）' : '清除已存 Key…'}
            </Button>
          </div>
        )}
        {err && <div className="err" style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 10, lineHeight: 1.5 }}>{err}</div>}
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
          修改 Base URL / 模型 ID / Key 后保存前会先真实请求该服务验证，失败则不保存（现有配置原样保留）。
        </div>
      </div>
    </Modal>
  )
}

import React, { useEffect, useState } from 'react'
import type { Skill } from '@shared/types'
import { bridge } from '../lib/ipc'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'

/**
 * 侧栏 ⋯ 展开的 Agent 管理卡片：常驻提示词 + Skill 绑定 + 原有的重命名/移除。
 *
 * 定为**唯一**编辑入口（spec 批次 D）——同一个字段两处可写必然漂移，所以模型管理弹窗那边
 * 已改成只读摘要 + 指回这里。Skill 注入方式只有 `auto`（每次调用注入正文）与
 * `reference`（只进可引用清单）两档；停用的 Skill 即使绑了也不注入（与 `skills-union` 同口径）。
 */
export function AgentManageCard({ agentId, onRename, onRemove }: { agentId: string; onRename: () => void; onRemove: () => void }) {
  const agent = useAgents((s) => s.agents.find((a) => a.id === agentId))
  const updateAgent = useAgents((s) => s.updateAgent)
  const [skills, setSkills] = useState<Skill[]>([])
  useEffect(() => {
    void bridge.skills
      .list()
      .then((l) => setSkills(l ?? []))
      .catch(() => setSkills([]))
  }, [])
  if (!agent) return null
  const picked = agent.skillIds ?? []
  const mode = agent.skillMode === 'auto' ? 'auto' : 'reference'
  const toggle = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]
    updateAgent(agent.id, { skillIds: next.length ? next : undefined })
  }
  return (
    <div data-agent-card className="agent-card">
      <label className="ac-label">常驻提示词（每次调用自动注入）</label>
      <textarea
        defaultValue={agent.systemPrompt ?? ''}
        rows={3}
        placeholder="例如：始终用中文回答；改代码前先跑测试。"
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (v === (agent.systemPrompt ?? '').trim()) return
          updateAgent(agent.id, { systemPrompt: v || undefined })
          useUi.getState().toast(v ? '常驻提示词已保存（工作站对话与工作流角色都会注入）' : '已清空常驻提示词', 'ok')
        }}
      />
      <label className="ac-label">Skill 注入方式</label>
      <div data-skill-mode className="ac-seg">
        <button type="button" className={mode === 'reference' ? 'on' : ''} onClick={() => updateAgent(agent.id, { skillMode: 'reference' })}>
          仅可引用
        </button>
        <button type="button" className={mode === 'auto' ? 'on' : ''} onClick={() => updateAgent(agent.id, { skillMode: 'auto' })}>
          自动注入
        </button>
      </div>
      <div className="ac-note">
        {mode === 'auto' ? '每次真实调用都注入这些 Skill 正文（工作站每轮、工作流每角色）。' : '只进可引用清单，不自动注入正文。'}
        停用的 Skill 即使绑了也不注入。
      </div>
      <div data-skill-pick className="ac-skills">
        {skills.length === 0 && <span className="ac-empty">本机还没有 Skill，可先去设置页添加。</span>}
        {skills.map((s) => (
          <label key={s.id} className={s.enabled === false ? 'off' : ''}>
            <input type="checkbox" checked={picked.includes(s.id)} disabled={s.enabled === false} onChange={() => toggle(s.id)} />
            <span>{s.name}</span>
          </label>
        ))}
      </div>
      <button className="foot-btn" onClick={onRename}>
        重命名
      </button>
      <button className="foot-btn danger" onClick={onRemove}>
        移除…
      </button>
    </div>
  )
}

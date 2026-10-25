import React, { useEffect, useRef, useState } from 'react'
import type { Skill } from '@shared/types'
import { bridge } from '../lib/ipc'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
// 契约符号：纯函数与文案常量统一在 shared（逻辑层有防漂移绊线，不许渲染层手抄）
import { SKILL_MODE_HINTS, SKILL_TIMING_NOTE, SKILL_SOURCE_LABELS } from '@shared/skill-usages'
import { StatusDot, statusText } from './primitives'
import { cls } from '../lib/utils'

/**
 * 侧栏 ⋯ 展开的 Agent 管理卡片：头部（身份）+ 常驻提示词 + 技能 + 操作，四段分区。
 *
 * 定为**唯一**编辑入口（spec 批次 D）——同一个字段两处可写必然漂移，所以模型管理弹窗那边
 * 已改成只读摘要 + 指回这里。Skill 注入方式只有 `auto`（每次调用注入正文）与
 * `reference`（只进可引用清单）两档；停用的 Skill 即使绑了也不注入（与 `skills-union` 同口径）。
 * 改造（2026-10-25）：之前四个异质元素平铺没有分区、保存不可见、技能项只有名字——
 * 分区 + 徽章 + 保存状态让每个元素自己会说话。
 */
export function AgentManageCard({
  agentId,
  onRename,
  onRemove,
  onOpenSkillCenter
}: {
  agentId: string
  onRename: () => void
  onRemove: () => void
  onOpenSkillCenter: () => void
}) {
  const agent = useAgents((s) => s.agents.find((a) => a.id === agentId))
  const updateAgent = useAgents((s) => s.updateAgent)
  const [skills, setSkills] = useState<Skill[]>([])
  // 保存可见化：blur 保存成功后"已保存 ✓"亮 2 秒；未保存改动期间标题旁亮"未保存"。
  // textarea 是 defaultValue 非受控（见 Sidebar 的 key 说明），字数与 dirty 用 onChange 同步。
  const [savedFlash, setSavedFlash] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [chars, setChars] = useState(0)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    void bridge.skills
      .list()
      .then((l) => setSkills(l ?? []))
      .catch(() => setSkills([]))
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [])
  if (!agent) return null
  const picked = agent.skillIds ?? []
  const boundCount = picked.length
  const mode = agent.skillMode === 'auto' ? 'auto' : 'reference'
  const toggle = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]
    updateAgent(agent.id, { skillIds: next.length ? next : undefined })
  }
  const summary = agent.isDemo
    ? '演示 Agent · 回复为脚本内容'
    : agent.kind === 'cli'
      ? 'CLI Agent · 模型与凭据由接入方管理'
      : agent.model || '未配置模型'
  return (
    <div data-agent-card className="agent-card">
      {/* 头部：点开 ⋯ 先知道在改谁（此前卡片里没有任何身份信息） */}
      <div data-agent-card-head className="ac-head">
        <StatusDot status={agent.status} />
        <div className="ac-head-text">
          <div className="ac-head-name">{agent.name}</div>
          <div className="ac-head-sub">
            {summary} · {statusText(agent.status)}
          </div>
        </div>
      </div>

      <div className="ac-sec" data-sec-prompt>
        <div className="ac-sec-title">
          常驻提示词
          <span className="ac-sec-extra">
            {savedFlash ? (
              <span className="ac-badge ac-saved">已保存 ✓</span>
            ) : dirty ? (
              <span className="ac-badge">未保存</span>
            ) : null}
          </span>
        </div>
        <textarea
          defaultValue={agent.systemPrompt ?? ''}
          rows={5}
          placeholder="例如：始终用中文回答；改代码前先跑测试。"
          onChange={(e) => {
            setDirty(true)
            setChars(e.target.value.length)
          }}
          onBlur={(e) => {
            const v = e.target.value.trim()
            setChars(e.target.value.length)
            if (v === (agent.systemPrompt ?? '').trim()) {
              setDirty(false)
              return
            }
            updateAgent(agent.id, { systemPrompt: v || undefined })
            setDirty(false)
            setSavedFlash(true)
            if (flashTimer.current) clearTimeout(flashTimer.current)
            flashTimer.current = setTimeout(() => setSavedFlash(false), 2000)
            useUi.getState().toast(v ? '常驻提示词已保存（工作站对话与工作流角色都会注入）' : '已清空常驻提示词', 'ok')
          }}
        />
        <div className="ac-sec-note">
          <span>留空 = 不注入 · 改完失焦即存；工作站对话与工作流角色都会带</span>
          <span className="ac-charcount">{chars} 字</span>
        </div>
      </div>

      <div className="ac-sec" data-sec-skills>
        <div className="ac-sec-title">
          技能
          <span className="ac-sec-extra">
            {boundCount > 0 && <span className="ac-badge">已绑 {boundCount}</span>}
          </span>
        </div>
        <label className="ac-label">注入方式</label>
        <div data-skill-mode className="ac-seg">
          {/* hover 提示按"点了会切到哪档"给：常驻的 ac-note 只描述当前档，两处口径同源于 SKILL_MODE_HINTS */}
          <button
            type="button"
            className={mode === 'reference' ? 'on' : ''}
            title={SKILL_MODE_HINTS.reference}
            onClick={() => updateAgent(agent.id, { skillMode: 'reference' })}
          >
            仅可引用
          </button>
          <button
            type="button"
            className={mode === 'auto' ? 'on' : ''}
            title={SKILL_MODE_HINTS.auto}
            onClick={() => updateAgent(agent.id, { skillMode: 'auto' })}
          >
            自动注入
          </button>
        </div>
        <div className="ac-note">
          {mode === 'auto' ? '每次真实调用都注入这些 Skill 正文（工作站每轮、工作流每角色）。' : '只进可引用清单，不自动注入正文。'}
          停用的 Skill 即使绑了也不注入。
        </div>
        <div data-skill-pick className="ac-skills">
          {skills.length === 0 && (
            <span className="ac-empty">本机还没有技能。</span>
          )}
          {skills.map((s) => {
            const off = s.enabled === false
            return (
              <label key={s.id} className={cls('ac-skill-item', off && 'off')}>
                <input
                  type="checkbox"
                  checked={picked.includes(s.id)}
                  disabled={off}
                  onChange={() => toggle(s.id)}
                />
                <span className="ac-skill-name">{s.name}</span>
                {s.source && (
                  <span className={cls('skill-src-badge', `src-${s.source}`)}>{SKILL_SOURCE_LABELS[s.source] ?? s.source}</span>
                )}
                {s.version && <span className="ac-skill-ver">v{s.version}</span>}
                {off && <span className="ac-skill-off" title="技能已停用：去技能中心开启后才能绑定">⚠ 已停用</span>}
              </label>
            )
          })}
        </div>
        {/* 绑定区收尾的"何时生效"：用户在这里勾完最想知道的就是"什么时候开始算数" */}
        <div className="skill-usage-note">{SKILL_TIMING_NOTE}</div>
        <button type="button" className="ac-open-skillcenter" onClick={onOpenSkillCenter}>
          → 打开技能中心{skills.length === 0 ? '安装第一个技能' : '管理/安装更多'}
        </button>
      </div>

      <div className="ac-sec ac-actions" data-sec-actions>
        <button className="foot-btn" onClick={onRename}>
          重命名
        </button>
        <button className="foot-btn danger" onClick={onRemove}>
          移除…
        </button>
      </div>
    </div>
  )
}

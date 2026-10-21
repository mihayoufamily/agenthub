// 角色配置浮层：悬停 200ms 打开 / 点击固定；Agent 选择 + 模型联动（角色级覆盖真实生效）
// 模型列表来自真实接口（model:list）；CLI 手填 --model；演示 Agent 如实标注不支持切换
import React, { useEffect, useRef, useState } from 'react'
import type { AgentConfig } from '@shared/types'
import { useAgents } from '../stores/agents'
import { useWorkflow } from '../stores/workflow'
import { bridge } from '../lib/ipc'
import { Avatar, StatusDot, statusText } from '../components/primitives'
import { Icon } from '../components/Icons'
import { cls } from '../lib/utils'

export type RoleKey = 'planner' | 'executor' | 'reviewer'
const ROLE_TEXT: Record<RoleKey, string> = { planner: '规划', executor: '执行', reviewer: '审核' }
const KIND_TEXT: Record<string, string> = { demo: '演示', model: '模型', cli: 'CLI' }

export function RolePicker({ role, onEnter, onLeave }: {
  role: RoleKey
  /** 鼠标移入浮层：取消关闭计时 */
  onEnter: () => void
  /** 鼠标离开浮层：启动关闭计时（固定打开时无效，由父级判断） */
  onLeave: () => void
}) {
  const agents = useAgents((s) => s.agents)
  const config = useWorkflow((s) => s.config)
  const patchConfig = useWorkflow((s) => s.patchConfig)
  const roleCfg = config[role]
  const selected = agents.find((a) => a.id === roleCfg.agentId) ?? null
  const [flip, setFlip] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 空间不足时向上翻转（默认向下展开）
  useEffect(() => {
    const anchor = ref.current?.parentElement
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    setFlip(window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom)
  }, [role])

  const pickAgent = (a: AgentConfig) => {
    // 切换 Agent：清除旧模型覆盖（文档要求：不静默保留无效配置）
    patchConfig({ [role]: { agentId: a.id, agentName: a.name, model: a.model } } as never)
  }

  return (
    <div
      ref={ref}
      className="cfg-pop card-enter"
      style={flip ? { top: 'auto', bottom: 'calc(100% + 8px)' } : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="cp-head">
        <span className={`role-tag ${role}`}>{ROLE_TEXT[role]}角色</span>
        <span className="cp-hint">{selected ? '选择 Agent 或调整模型' : '选择 Agent'}</span>
      </div>
      <div className="cp-agents">
        {agents.length === 0 && (
          <div className="cp-empty">暂无 Agent。请先在工作站添加（演示 / 自定义模型 / 本机 CLI）。</div>
        )}
        {agents.map((a) => {
          const cur = a.id === roleCfg.agentId
          return (
            <button key={a.id} className={cls('cp-agent', cur && 'cur')} onClick={() => pickAgent(a)}>
              <Avatar name={a.name} color={useAgents.getState().colorOf(a.id)} size={22} />
              <span className="name">{a.name}</span>
              <span className="kind">{KIND_TEXT[a.kind] ?? a.kind}</span>
              <StatusDot status={a.status} />
              {cur && <Icon name="check" size={13} />}
            </button>
          )
        })}
      </div>
      {selected && <ModelSection role={role} agent={selected} />}
    </div>
  )
}

/** 模型区：按 Agent 类型真实联动（接口拉取 / CLI 手填 / 演示如实限制） */
function ModelSection({ role, agent }: { role: RoleKey; agent: AgentConfig }) {
  const config = useWorkflow((s) => s.config)
  const patchConfig = useWorkflow((s) => s.patchConfig)
  const override = config[role].modelOverride
  const [models, setModels] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState(override ?? '')

  const load = async () => {
    if (!agent.modelConfig) return
    setLoading(true)
    setErr(null)
    const r = await bridge.models.list(agent.modelConfig)
    setLoading(false)
    if (r.ok && r.models) setModels(r.models)
    else setErr(r.message ?? '获取模型列表失败')
  }

  useEffect(() => {
    setModels(null)
    setErr(null)
    setManual(config[role].modelOverride ?? '')
    if (agent.kind === 'model' && agent.modelConfig) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id])

  if (agent.kind === 'demo') {
    return (
      <div className="cp-models">
        <div className="cp-m-title">模型</div>
        <div className="cp-empty">演示 Agent 使用固定的演示模型（{agent.model}），不支持切换。</div>
      </div>
    )
  }

  if (agent.kind === 'cli' && agent.cliConfig) {
    return (
      <div className="cp-models">
        <div className="cp-m-title">模型参数（CLI）</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="cp-input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="留空使用 CLI 默认模型"
          />
          <button
            className="btn btn-secondary"
            style={{ height: 30, fontSize: 12 }}
            onClick={() => {
              const v = manual.trim()
              patchConfig({ [role]: { agentId: agent.id, agentName: agent.name, model: v || agent.model, ...(v ? { modelOverride: v } : {}) } } as never)
            }}
          >
            应用
          </button>
        </div>
        <div className="cp-note">作为 --model 参数传给 CLI；各 CLI 无统一查询接口，请参考其官方文档填写。</div>
      </div>
    )
  }

  if (!agent.modelConfig) return null
  const current = override ?? agent.modelConfig.modelId
  return (
    <div className="cp-models">
      <div className="cp-m-title">模型（来自该连接的真实接口）</div>
      {loading && <div className="cp-empty">正在获取模型列表…</div>}
      {err && (
        <div className="cp-err">
          {err}
          <button className="btn btn-ghost" style={{ height: 24, fontSize: 12 }} onClick={() => void load()}>重试</button>
        </div>
      )}
      {models && (
        <div className="cp-model-list">
          {models.map((m) => (
            <button
              key={m}
              className={cls('cp-model', m === current && 'cur')}
              disabled={m === current}
              onClick={() => patchConfig({ [role]: { agentId: agent.id, agentName: agent.name, model: m, modelOverride: m } } as never)}
            >
              {m} {m === current && '· 当前'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

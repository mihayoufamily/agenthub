// Agent 相关弹窗集合：添加（扫描/演示/自定义模型/CLI）、管理顺序（拖拽+上下移）、交接
import React, { useRef, useState } from 'react'
import type { ScanResultItem, CliName } from '@shared/types'
import { useAgents, CLI_META } from '../stores/agents'
import { useSessions } from '../stores/sessions'
import { useUi } from '../stores/ui'
import { Modal } from '../components/Modal'
import { Button, Avatar, Spinner } from '../components/primitives'
import { Icon } from '../components/Icons'
import { bridge } from '../lib/ipc'
import { CliCandidatesTab } from './CliCandidates'

export type AgentModalKind = null | 'add' | 'order' | 'handoff'

export function AgentModals({ kind, onClose }: { kind: AgentModalKind; onClose: () => void }) {
  if (kind === 'add') return <AddAgentModal onClose={onClose} />
  if (kind === 'order') return <OrderModal onClose={onClose} />
  if (kind === 'handoff') return <HandoffModal onClose={onClose} />
  return null
}

/* ---------------- 添加 Agent ---------------- */
function AddAgentModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'cand' | 'demo' | 'cli' | 'model' | 'scan'>('cand')
  /** 候选列表 → 自定义模型预填（provider/baseUrl） */
  const [modelPrefill, setModelPrefill] = useState<{ provider: string; baseUrl: string } | null>(null)
  return (
    <Modal open onClose={onClose} title="添加 Agent" width={520}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {([
          ['cand', '候选列表'],
          ['demo', '演示 Agent'],
          ['cli', '本机 CLI'],
          ['model', '自定义模型'],
          ['scan', '扫描本机']
        ] as const).map(([k, label]) => (
          <button
            key={k}
            className={tab === k ? 'btn btn-primary' : 'btn btn-ghost'}
            style={{ height: 28, fontSize: 12.5 }}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'cand' && (
        <CliCandidatesTab
          onClose={onClose}
          onUseApi={(p) => {
            setModelPrefill(p)
            setTab('model')
          }}
        />
      )}
      {tab === 'demo' && <DemoTab onClose={onClose} />}
      {tab === 'cli' && <CliTab onClose={onClose} />}
      {tab === 'model' && <ModelTab key={modelPrefill?.baseUrl ?? 'blank'} prefill={modelPrefill ?? undefined} onClose={onClose} />}
      {tab === 'scan' && <ScanTab onClose={onClose} />}
    </Modal>
  )
}

function DemoTab({ onClose }: { onClose: () => void }) {
  const addDemo = useAgents((s) => s.addDemoAgent)
  return (
    <div style={{ paddingBottom: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 12 }}>
        演示 Agent 使用脚本化回复，用于在<b>不配置任何真实 Agent / API Key</b> 的情况下体验完整界面与交互。
        所有演示内容都会清晰标注，不伪装成真实执行。
      </div>
      <Button
        variant="primary"
        onClick={() => {
          const a = addDemo()
          useAgents.getState().select(a.id)
          useUi.getState().toast(`已添加 ${a.name}（演示）`, 'ok')
          onClose()
        }}
      >
        <Icon name="plus" size={14} /> 添加演示 Agent
      </Button>
    </div>
  )
}

/* ---------------- 本机 CLI Agent ---------------- */
const SUPPORTED_CLIS: CliName[] = ['arkcli', 'claude', 'codex']

function CliTab({ onClose }: { onClose: () => void }) {
  const addCliAgent = useAgents((s) => s.addCliAgent)
  const [model, setModel] = useState('')
  const [tests, setTests] = useState<Partial<Record<CliName, { ok: boolean; message: string; version?: string; exePath?: string }>>>({})
  const [testing, setTesting] = useState<CliName | null>(null)
  const [adding, setAdding] = useState<CliName | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const test = async (cli: CliName) => {
    setTesting(cli)
    setErr(null)
    const r = await bridge.cli.test(cli)
    setTests((t) => ({ ...t, [cli]: r }))
    setTesting(null)
  }

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 10 }}>
        接入本机已安装的 Agent CLI（规格 §10"接入现成 Agent"）：执行与凭据完全由 CLI 自身完成，
        <b>AgentHub 不读取其配置、不保存任何密钥</b>。仅支持原生 .exe 安装形态（npm 的 .cmd shim 无法安全执行）。
      </div>
      <div className="form-row">
        <label>覆盖模型（可选）</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="不填则使用 CLI 自身默认模型" />
        <span className="help">如 arkcli 当前 profile 的默认模型；仅在本次添加的 Agent 上生效</span>
      </div>
      {SUPPORTED_CLIS.map((cli) => {
        const t = tests[cli]
        return (
          <div key={cli} className="agent-manage-row">
            <div className="info">
              <div className="nm">{CLI_META[cli].display}</div>
              <div style={{ fontSize: 11, color: t?.ok ? 'var(--ok, #1f9d6d)' : 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                {t
                  ? t.ok
                    ? `可用 · ${t.version ?? ''} · ${t.exePath ?? ''}`
                    : t.message
                  : CLI_META[cli].note}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant="secondary" style={{ height: 28 }} loading={testing === cli} onClick={() => void test(cli)}>
                测试
              </Button>
              <Button
                variant="primary"
                style={{ height: 28 }}
                disabled={!t?.ok || adding !== null}
                loading={adding === cli}
                onClick={async () => {
                  setAdding(cli)
                  setErr(null)
                  const r = await addCliAgent(cli, model)
                  setAdding(null)
                  if (r.ok && r.agent) {
                    useAgents.getState().select(r.agent.id)
                    useUi.getState().toast(`已添加 ${r.agent.name}（${r.message}）`, 'ok')
                    onClose()
                  } else {
                    setErr(r.message)
                  }
                }}
              >
                添加
              </Button>
            </div>
          </div>
        )
      })}
      {err && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>{err}</div>}
    </div>
  )
}

function ModelTab({ onClose, prefill }: { onClose: () => void; prefill?: { provider: string; baseUrl: string } }) {
  const addCustom = useAgents((s) => s.addCustomModelAgent)
  const [provider, setProvider] = useState(prefill?.provider ?? 'OpenAI 兼容服务')
  const [baseUrl, setBaseUrl] = useState(prefill?.baseUrl ?? '')
  const [modelId, setModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const canSubmit = baseUrl.trim() && modelId.trim() && apiKey.trim() && !testing

  return (
    <div style={{ paddingBottom: 8 }}>
      <div className="form-row">
        <label>服务商名称</label>
        <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="如：DeepSeek / 本地 Ollama" />
        <span className="help">仅用于显示，可随意填写</span>
      </div>
      <div className="form-row">
        <label>Base URL</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
        <span className="help">OpenAI 兼容接口地址；Key 将加密保存在系统凭据存储，不写入仓库或导出</span>
      </div>
      <div className="form-row">
        <label>模型 ID</label>
        <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="如 gpt-4o-mini / deepseek-chat" />
      </div>
      <div className="form-row">
        <label>API Key</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
      </div>
      {err && <div className="err" style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 10, lineHeight: 1.5 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="primary"
          loading={testing}
          disabled={!canSubmit}
          onClick={async () => {
            setTesting(true)
            setErr(null)
            const r = await addCustom(
              { provider, baseUrl: baseUrl.trim().replace(/\/+$/, ''), modelId: modelId.trim() },
              apiKey
            )
            setTesting(false)
            if (r.ok && r.agent) {
              useAgents.getState().select(r.agent.id)
              useUi.getState().toast(`连接成功：${r.message}`, 'ok')
              onClose()
            } else {
              setErr(r.message)
            }
          }}
        >
          测试连接并添加
        </Button>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', alignSelf: 'center' }}>
          添加前会先真实请求 /models 验证，失败则不保存
        </span>
      </div>
    </div>
  )
}

function ScanTab({ onClose }: { onClose: () => void }) {
  const scanning = useAgents((s) => s.scanning)
  const scan = useAgents((s) => s.scan)
  const discovered = useAgents((s) => s.discovered)
  const addDiscovered = useAgents((s) => s.addDiscoveredAgent)
  const addCliAgent = useAgents((s) => s.addCliAgent)

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 10 }}>
        扫描范围：PATH 上的常见 Agent CLI 命令。不扫描整块磁盘、不读取任何软件的配置或密钥。
        <b>检测到安装 ≠ 已接入</b>：arkcli / claude / codex 已内置执行适配器（其中 claude / codex 未在本机实测），其余仅加入候选并如实标注。
      </div>
      <Button variant="secondary" loading={scanning} onClick={() => void scan()} style={{ marginBottom: 12 }}>
        <Icon name="scan" size={14} /> {scanning ? '扫描中…' : '扫描本机 Agent'}
      </Button>
      {discovered.map((d: ScanResultItem) => {
        const supported = (['arkcli', 'claude', 'codex'] as const).includes(d.name as 'arkcli')
        return (
          <div key={d.path} className="agent-manage-row">
            <div className="info">
              <div className="nm">{d.name}</div>
              <div className="md txt-ellipsis">{d.path}</div>
              <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 3 }}>{d.supportNote}</div>
            </div>
            {supported ? (
              <Button
                variant="primary"
                style={{ height: 28 }}
                onClick={async () => {
                  const r = await addCliAgent(d.name as CliName)
                  if (r.ok && r.agent) {
                    useAgents.getState().select(r.agent.id)
                    useUi.getState().toast(`已添加 ${r.agent.name}（${r.message}）`, 'ok')
                    onClose()
                  } else {
                    useUi.getState().toast(`添加失败：${r.message}`, 'error')
                  }
                }}
              >
                连接并添加
              </Button>
            ) : (
              <Button
                variant="secondary"
                style={{ height: 28 }}
                onClick={() => {
                  const a = addDiscovered(d.name, d.path)
                  useUi.getState().toast(`已加入候选列表（${a.name}，待连接）`, 'ok')
                }}
              >
                加入候选
              </Button>
            )}
          </div>
        )
      })}
      {!scanning && discovered.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '8px 0' }}>尚未扫描或未发现已知 CLI。可点上方按钮重新扫描。</div>
      )}
    </div>
  )
}

/* ---------------- 管理顺序 ---------------- */
function OrderModal({ onClose }: { onClose: () => void }) {
  const agents = useAgents((s) => s.agents)
  const reorder = useAgents((s) => s.reorder)
  const moveBy = useAgents((s) => s.moveBy)
  const selectedId = useAgents((s) => s.selectedId)
  const [list, setList] = useState(agents.map((a) => a.id))
  const dragIdx = useRef<number | null>(null)

  const move = (id: string, delta: number) => {
    const i = list.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    setList(next)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="管理 Agent 顺序"
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              reorder(list) // 保存后持久化；当前选中不置顶、不重排
              useUi.getState().toast('顺序已保存', 'ok')
              onClose()
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div style={{ paddingBottom: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
          拖拽或使用 ↑/↓ 调整。顺序仅在此处改变——切换、选中、任务完成都不会自动重排。
        </div>
        {list.map((id, i) => {
          const a = agents.find((x) => x.id === id)
          if (!a) return null
          return (
            <div
              key={id}
              className="order-row"
              draggable
              onDragStart={() => (dragIdx.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragIdx.current
                if (from === null || from === i) return
                const next = [...list]
                const [moved] = next.splice(from, 1)
                next.splice(i, 0, moved)
                setList(next)
                dragIdx.current = null
              }}
              style={selectedId === id ? { borderColor: 'var(--brand-yellow)' } : undefined}
            >
              <span className="grip"><Icon name="grip" size={14} /></span>
              <span className="idx">{i + 1}</span>
              <Avatar name={a.name} color={useAgents.getState().colorOf(id)} size={24} />
              <div className="info">
                <div className="nm">{a.name} {a.isDemo && <span className="demo-badge">演示</span>}</div>
                <div className="md">{a.model}</div>
              </div>
              <div className="mv">
                <button className="icon-btn" title="上移" disabled={i === 0} onClick={() => move(id, -1)}>
                  <Icon name="up" size={14} />
                </button>
                <button className="icon-btn" title="下移" disabled={i === list.length - 1} onClick={() => move(id, 1)}>
                  <Icon name="down" size={14} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

/* ---------------- 交接 ---------------- */
const EMPTY_MSGS: import('@shared/types').ChatMessage[] = []
function HandoffModal({ onClose }: { onClose: () => void }) {
  const agents = useAgents((s) => s.agents)
  const selectedId = useAgents((s) => s.selectedId)
  const handoff = useSessions((s) => s.handoff)
  // 直接订阅数据（函数引用订阅不会随 sessions 变化触发重渲染）；多会话取活跃会话消息
  const msgs = useSessions((s) => {
    if (!selectedId) return EMPTY_MSGS
    const list = s.sessions[selectedId]
    const act = list?.find((x) => x.id === s.activeOf[selectedId]) ?? list?.[list.length - 1]
    return act?.messages ?? EMPTY_MSGS
  })
  const others = agents.filter((a) => a.id !== selectedId)
  const [targetId, setTargetId] = useState(others[0]?.id ?? '')
  const source = agents.find((a) => a.id === selectedId)
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')

  return (
    <Modal
      open
      onClose={onClose}
      title="交给其他 Agent"
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!targetId}
            onClick={() => {
              if (selectedId && targetId) handoff(selectedId, targetId)
              onClose()
            }}
          >
            确认交接
          </Button>
        </>
      }
    >
      <div style={{ paddingBottom: 6 }}>
        <div className="form-row">
          <label>接收 Agent</label>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ height: 34 }}>
            {others.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {others.length === 0 && <span className="err">没有其他 Agent 可接收，请先添加</span>}
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 10, fontSize: 12.5, lineHeight: 1.6 }}>
          <b>交接预览</b>
          <div style={{ color: 'var(--text-3)', marginTop: 4 }}>
            来源：{source?.name} → 接收：{agents.find((a) => a.id === targetId)?.name ?? '—'}
          </div>
          <div style={{ color: 'var(--text-2)', marginTop: 6 }}>
            交接摘要（最近结论）：
            {lastAssistant ? (lastAssistant.text.length > 160 ? lastAssistant.text.slice(0, 160) + '…' : lastAssistant.text) : '（暂无结论，将仅交接目标说明）'}
          </div>
          <div style={{ color: 'var(--text-3)', marginTop: 6 }}>
            不会把完整对话发送给接收方，只创建带来源标记的交接消息。
          </div>
        </div>
      </div>
    </Modal>
  )
}

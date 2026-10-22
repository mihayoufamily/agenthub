// 工作流固定配置面板：三角色 Agent/模型、审核方式、每轮确认、返工上限、超时、产物目录
import React, { useEffect, useState } from 'react'
import { useWorkflow } from '../stores/workflow'
import { useAgents } from '../stores/agents'
import { useUi } from '../stores/ui'
import { Modal } from '../components/Modal'
import { Button, Switch } from '../components/primitives'
import { bridge } from '../lib/ipc'

export function ConfigPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useWorkflow((s) => s.config)
  const patchConfig = useWorkflow((s) => s.patchConfig)
  const agents = useAgents((s) => s.agents)
  // 生效目录（未设置时为主进程默认值）：留空也要让用户看到实际落盘位置
  const [effDir, setEffDir] = useState('')
  useEffect(() => {
    if (open) void bridge.artifacts.dir().then(setEffDir)
  }, [open])

  const roleSelect = (key: 'planner' | 'executor' | 'reviewer', label: string) => {
    const cur = config[key]
    const usable = (id: string) => {
      const a = agents.find((x) => x.id === id)
      return !a || a.isDemo === true || (a.kind === 'model' && a.status === 'available')
    }
    return (
      <div className="form-row">
        <label>{label}</label>
        <select
          value={cur.agentId}
          onChange={(e) => {
            const a = agents.find((x) => x.id === e.target.value)
            patchConfig({
              [key]: { agentId: e.target.value, agentName: a?.name ?? '', model: a?.model ?? '' }
            } as never)
          }}
          style={{ height: 34 }}
        >
          <option value="">— 选择 Agent —</option>
          {agents.map((a) => {
            const ok = usable(a.id)
            return (
              <option key={a.id} value={a.id} disabled={!ok}>
                {a.name} · {a.model}{ok ? '' : '（不可用：未连接）'}
              </option>
            )
          })}
          {agents.length === 0 && <option value="" disabled>尚无 Agent，请先在"工作站 → 添加 Agent"中添加</option>}
        </select>
        <span className="help">
          {cur.agentId
            ? `Agent：${cur.agentName || '—'} · 模型：${cur.model || '—'}${agents.find((a) => a.id === cur.agentId)?.isDemo ? ' · 演示' : ''}`
            : '未配置'}
        </span>
      </div>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="工作流设置"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              patchConfig({})
              useWorkflow.getState().resolveRoles()
              useUi.getState().toast('配置已保存', 'ok')
              onClose()
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div style={{ paddingBottom: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.6 }}>
          三种角色可以使用同一个 Agent 或模型，但<b>会话与角色指令相互隔离</b>。
          「接入现成 Agent」使用其自身执行能力；「接入模型 API」由 AgentHub 提供工具调用与任务循环——只有文本能力的模型接口不会被当作可执行系统任务的 Agent。
        </div>
        {roleSelect('planner', '规划 Agent（拆解需求、维护验收标准、判断完成）')}
        {roleSelect('executor', '执行 Agent（产出产物与验证记录）')}
        {roleSelect('reviewer', '审核 Agent（对照标准检查、输出返工建议）')}

        <div className="form-row">
          <label>产物目录</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
            <input
              value={config.outputDir ?? ''}
              placeholder={effDir || '（默认：文档目录/AgentHub-artifacts）'}
              onChange={(e) => patchConfig({ outputDir: e.target.value })}
              style={{ flex: 1, height: 30, minWidth: 0 }}
            />
            <Button
              variant="ghost"
              onClick={async () => {
                const dir = await bridge.tools.pickDir()
                if (dir) patchConfig({ outputDir: dir })
              }}
            >
              选择文件夹
            </Button>
            {!!config.outputDir && (
              <Button variant="ghost" onClick={() => patchConfig({ outputDir: '' })}>
                恢复默认
              </Button>
            )}
          </div>
          <span className="help">
            本次工作流成果的落盘位置。执行 Agent 已授权文件工具时，其工作根目录在本次任务中临时改为该目录（只换目录，不提升访问级别）；
            未授权工具时由 AgentHub 把执行成果写成文本产物。留空 = {effDir || '文档目录下的 AgentHub-artifacts'}
          </span>
        </div>

        <div className="form-row">
          <label>审核方式</label>
          <div className="seg">
            <button
              className={config.reviewMode === 'auto' ? 'active' : ''}
              onClick={() => patchConfig({ reviewMode: 'auto' })}
            >
              自动审核
            </button>
            <button
              className={config.reviewMode === 'human' ? 'active' : ''}
              onClick={() => patchConfig({ reviewMode: 'human' })}
            >
              人工确认
            </button>
          </div>
          <span className="help">人工确认默认在最终交付前生效；开启"每轮确认"后每轮审核都等待你的决定。运行中修改在下一检查点生效。</span>
        </div>

        <div className="set-row">
          <div>
            <div className="lbl">每轮审核后人工确认</div>
            <div className="desc">关闭时仅在最终交付前确认</div>
          </div>
          <Switch
            label="每轮确认"
            on={config.confirmEveryRound}
            onChange={(v) => patchConfig({ confirmEveryRound: v })}
          />
        </div>

        <div className="form-row" style={{ marginTop: 10 }}>
          <label>最大返工轮数</label>
          <input
            type="number"
            min={1}
            max={10}
            value={config.maxRounds}
            onChange={(e) => patchConfig({ maxRounds: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
            style={{ width: 100 }}
          />
          <span className="help">达到上限后保留成果并说明未完成项，等待你的决定</span>
        </div>

        <div className="form-row">
          <label>任务超时（分钟）</label>
          <input
            type="number"
            min={1}
            max={720}
            value={config.timeoutMin}
            onChange={(e) => patchConfig({ timeoutMin: Math.max(1, Math.min(720, Number(e.target.value) || 30)) })}
            style={{ width: 100 }}
          />
          <span className="help">超时视为停止条件：任务停止、记录与产物引用保留</span>
        </div>

        <div className="form-row" style={{ marginTop: 10 }}>
          <label>Token 上限（累计）</label>
          <input
            type="number"
            min={0}
            step={10000}
            value={config.maxTokens}
            onChange={(e) => patchConfig({ maxTokens: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            style={{ width: 100 }}
          />
          <span className="help">整个任务真实调用累计消耗 Token 达到上限后自动停止（0 = 不限制）；已完成卡片与记录保留</span>
        </div>
      </div>
    </Modal>
  )
}

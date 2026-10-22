// 工作流产物目录入口：与工作站「目录」chip 同一形态，改的是整套工作流的落盘位置。
// 口径与主进程一致：执行角色的文件工具沙箱根、CLI 工作目录、AgentHub 兜底文本产物、
// 导出的任务记录都写在这里；配置留空 = 文档目录下的 AgentHub-artifacts。
import React, { useEffect, useState } from 'react'
import { bridge } from '../lib/ipc'
import { useWorkflow } from '../stores/workflow'
import { useUi } from '../stores/ui'
import { Modal } from './Modal'
import { Icon } from './Icons'
import { Button } from './primitives'

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** 当前生效目录 + 配置里填的目录（留空表示用默认） */
export function useArtifactDir() {
  const saved = useWorkflow((s) => s.config.outputDir ?? '')
  const [eff, setEff] = useState('')
  useEffect(() => {
    void bridge.artifacts.dir().then((d) => setEff(typeof d === 'string' ? d : ''))
  }, [saved])
  return { saved, eff, label: saved ? baseName(saved) : eff ? `${baseName(eff)}（默认）` : '默认' }
}

export function OutputDirModal({ onClose }: { onClose: () => void }) {
  const patchConfig = useWorkflow((s) => s.patchConfig)
  const { saved, eff } = useArtifactDir()
  const [dir, setDir] = useState(saved || eff)

  const apply = (v: string, note: string) => {
    patchConfig({ outputDir: v })
    setDir(v)
    useUi.getState().toast(note, 'ok')
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="工作流产物目录"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            onClick={() => {
              const v = dir.trim()
              apply(v, v ? `产物目录已设置：${v}` : '已恢复默认（文档目录下的 AgentHub-artifacts）')
              onClose()
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 6 }}>
        <div className="form-row">
          <label>所有产物写入这个文件夹</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="留空使用默认目录" style={{ flex: 1 }} />
            <Button
              variant="secondary"
              onClick={async () => {
                const p = await bridge.tools.pickDir()
                if (p) setDir(p)
              }}
            >
              选择…
            </Button>
          </div>
        </div>
        <div className="wf-dir-note">
          生效范围：执行角色的文件工具沙箱根、CLI 角色的工作目录、由 AgentHub 保存的文本成果、导出的任务记录。
          对已授权工具的 Agent 只**换目录**，不会因此多给任何权限；没授权工具的 Agent 由 AgentHub 把成果写成文件。
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" onClick={() => apply('', '已恢复默认产物目录')}>恢复默认</Button>
          <Button
            variant="ghost"
            onClick={async () => {
              const d = await bridge.artifacts.dir()
              if (!d) return useUi.getState().toast('产物目录不可用（系统文档目录读取失败）', 'warn')
              const r = await bridge.app.openPath(d)
              if (!r.ok) useUi.getState().toast(r.message ?? '打开失败', 'error')
            }}
          >
            <Icon name="folder" size={13} /> 打开当前产物文件夹
          </Button>
        </div>
        <div className="wf-dir-cur">当前生效：{eff || '（读取失败）'}</div>
      </div>
    </Modal>
  )
}

/** 配置条/顶栏上的入口 chip：点开 OutputDirModal */
export function OutputDirChip({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const { label, eff } = useArtifactDir()
  return (
    <>
      <button
        className={className ?? 'cfg-chip'}
        title={`工作流产物目录：${eff || '默认'}（执行方写盘、AgentHub 文本成果与导出记录都写在这里）`}
        onClick={() => setOpen(true)}
      >
        <Icon name="folder" size={13} /> 产物：<b>{label}</b>
      </button>
      {open && <OutputDirModal onClose={() => setOpen(false)} />}
    </>
  )
}

// 演示模式内容生成器
// 纪律：所有内容均标注"演示"，不伪造真实工具调用/真实思考链/真实产物落盘
import type { ChecklistItem, ProcessEvent, ArtifactRef } from '@shared/types'
import { uid } from './utils'

export function demoChatReply(userText: string, agentName: string): string {
  const t = userText.length > 60 ? userText.slice(0, 60) + '…' : userText
  return (
    `【演示回复 · ${agentName}】\n\n` +
    `收到你的消息："${t}"。\n\n` +
    `这是演示模式中的脚本化回复，用于展示界面与交互：流式输出、卡片折叠、草稿保留等均为真实实现，` +
    `但本条内容不是任何真实模型的输出，也不会对本机执行任何操作。\n\n` +
    `要接入真实模型，请在"添加 Agent → 自定义模型"中填写 Base URL、模型 ID 与 API Key，完成连接测试后即可真实对话。`
  )
}

export function demoHandoffNote(fromName: string, toName: string, summary: string): string {
  return (
    `【交接 · 演示】\n\n来源：${fromName} → 接收：${toName}\n\n交接摘要：\n${summary.slice(0, 300)}\n\n` +
    `（交接消息由 AgentHub 创建；演示模式下不发送给任何真实 Agent）`
  )
}

export function demoPlanConclusion(goal: string, round: number): string {
  if (round === 1) {
    return (
      `【演示 · 规划阶段】\n\n针对目标"${goal}"，我把任务拆解为 4 个步骤并给出验收标准。` +
      `第 3 步与实际产物存在已知差异，审核阶段会指出并进入返工（演示完整返工循环）。\n\n` +
      `说明：以上为演示脚本生成的内容，不代表真实 Agent 的推理。`
    )
  }
  return (
    `【演示 · 规划阶段 · 第 ${round} 轮返工】\n\n根据审核报告，本轮聚焦修复"样式细节与验收标准不符"的问题。` +
    `已按审核建议调整执行清单，其余步骤维持第 1 轮结论不变。`
  )
}

export function demoPlanChecklist(goal: string, round: number): ChecklistItem[] {
  const base: ChecklistItem[] = [
    { text: '明确目标与约束：' + (goal.length > 40 ? goal.slice(0, 40) + '…' : goal), done: true },
    { text: '任务拆解为可执行步骤', done: true },
    { text: '每步给出可检查的验收标准', done: true },
    { text: '向执行角色交接清单与上下文', done: true }
  ]
  if (round > 1) {
    base.push({ text: '纳入审核返工建议（修正样式细节）', done: true })
  }
  return base
}

export function demoExecuteConclusion(round: number): string {
  if (round === 1) {
    return (
      `【演示 · 执行阶段】\n\n按清单完成 4 个步骤，产出 2 个演示产物引用。` +
      `其中样式细节部分与验收标准存在偏差（未使用统一 token），将在审核阶段被指出。\n\n` +
      `注意：演示产物不会写入磁盘，仅用于展示产物列表与操作入口。`
    )
  }
  return (
    `【演示 · 执行阶段 · 第 ${round} 轮返工】\n\n已修复审核指出的样式偏差：统一使用设计 token，` +
    `并重新产出修订后的演示产物引用。执行记录见过程区。`
  )
}

export function demoExecuteProcess(round: number): ProcessEvent[] {
  const evs: ProcessEvent[] = [
    { kind: 'summary', text: '阶段摘要：按清单串行执行', ts: Date.now(), demo: true },
    { kind: 'tool', text: '读取项目结构（演示事件，未真实执行）', ts: Date.now(), demo: true },
    { kind: 'tool', text: '生成产物草稿（演示事件，未写入磁盘）', ts: Date.now(), demo: true },
    { kind: 'log', text: '步骤 1/4 完成 · 步骤 2/4 完成', ts: Date.now(), demo: true }
  ]
  if (round > 1) {
    evs.push({ kind: 'tool', text: '修正样式细节，统一引用 tokens（演示事件）', ts: Date.now(), demo: true })
    evs.push({ kind: 'log', text: '返工修复完成，等待审核复核', ts: Date.now(), demo: true })
  } else {
    evs.push({ kind: 'log', text: '步骤 3/4 存在样式细节偏差，继续完成剩余步骤', ts: Date.now(), demo: true })
  }
  return evs
}

export function demoArtifacts(round: number): ArtifactRef[] {
  const list: ArtifactRef[] = [
    { id: uid('art'), name: `deliverable-v${round}.demo.md`, kind: 'file', demo: true },
    { id: uid('art'), name: `change-summary-v${round}.demo.txt`, kind: 'change', demo: true }
  ]
  return list
}

export function demoReviewConclusion(round: number, maxRounds: number): string {
  if (round === 1) {
    return (
      `【演示 · 审核阶段 · 第 1 轮】\n\n对照验收标准逐项检查：3 项通过，1 项存在问题（样式细节未统一引用 token）。` +
      `结论：不通过，建议返工。审核不因执行方自称完成而放行。\n\n` +
      `剩余可返工轮数：${maxRounds - round}。`
    )
  }
  return (
    `【演示 · 审核阶段 · 第 ${round} 轮复核】\n\n返工项已修复，全部 4 项验收通过。结论：通过，建议交付。`
  )
}

export function demoReviewChecklist(round: number): ChecklistItem[] {
  if (round === 1) {
    return [
      { text: '目标理解与任务拆解符合需求', done: true, verdict: 'pass' },
      { text: '产物覆盖全部清单步骤', done: true, verdict: 'pass' },
      { text: '验证记录可复查', done: true, verdict: 'pass' },
      { text: '样式细节统一引用设计 token', done: false, verdict: 'issue' }
    ]
  }
  return [
    { text: '目标理解与任务拆解符合需求', done: true, verdict: 'pass' },
    { text: '产物覆盖全部清单步骤', done: true, verdict: 'pass' },
    { text: '验证记录可复查', done: true, verdict: 'pass' },
    { text: '样式细节统一引用设计 token（返工后复核）', done: true, verdict: 'pass' }
  ]
}

export function demoDeliveryConclusion(goal: string): string {
  return (
    `【演示 · 交付】\n\n任务"${goal}"在第 2 轮完成（含 1 次返工）。\n\n` +
    `已执行验证：清单逐项对照复核（演示）。\n` +
    `已知限制：本任务全程为演示数据，产物未落盘；接入真实 Agent/模型后，交付卡片将展示真实产物与验证记录。`
  )
}

export function demoFailureNote(): string {
  return '【演示 · 失败态】执行角色报告：外部依赖不可用（演示脚本注入的失败场景）。已保存当前进度与产物引用。'
}

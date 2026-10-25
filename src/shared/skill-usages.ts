// ============ 技能"生效范围"：事实计算层 + 统一文案常量（纯函数，main / renderer 两端同构可用） ============
//
// 为什么要有这一层：技能有两条持久参与通道（Agent 级绑定 / 工作流角色级绑定）× 两种模式
// （auto = 每次调用自动注入全文 / reference = 只进可引用清单），再加一个 enabled 总开关。
// 用户对此非常迷糊——界面要回答"这个技能现在到底在哪生效"，而答案散落在 agents 与
// workflow config 两个 store 里。这里把"谁绑定了它"算成一份事实清单，文案常量也只此一份，
// 三处界面（技能中心 / Agent 管理卡 / 配置面板）共用，防止各抄一份后措辞漂移。

import type { AgentConfig } from './types'

export type SkillUsageKind = 'agent' | 'role'
/** 注入方式：与 AgentConfig.skillMode 同一词汇表；mode 缺省或脏值一律按 'reference'（老配置行为不变） */
export type SkillUsageMode = NonNullable<AgentConfig['skillMode']>

export interface SkillUsage {
  kind: SkillUsageKind
  /**
   * 显示用位置名：agent → "工作站 · <Agent 名>"；role → "工作流 · <规划/执行/审核>"，
   * agentName 有值时附 "（<名>）"。这是给人看的，不回传结构化字段——界面不拿它做判断。
   */
  place: string
  mode: SkillUsageMode
}

/**
 * 角色级配置的窄形状：映射 types.ts 的 WorkflowRoleConfig（即 config.planner / config.executor /
 * config.reviewer）。实测该类型当前只有 agentName 与 skillIds、**没有 skillMode**——工作流注入
 * 把角色级绑定一律当 auto（见 stores/workflow.ts 的 autoIds 过滤："角色级绑定视为 auto"）。
 * 这里保留可选 skillMode 仅为向前兼容（渲染层将来若把模式暴露到角色上），缺省/脏值都按 'auto'，
 * 与现行注入行为逐字一致。
 */
export interface RoleSkillCfg {
  agentName?: string
  skillIds?: string[]
  skillMode?: SkillUsageMode
}

export interface SkillUsagesInput {
  /** Agent 级形状是 AgentConfig 的窄化（只取本函数要读的字段），脏值安全由实现兜底 */
  agents: { id: string; name: string; skillIds?: string[]; skillMode?: SkillUsageMode }[]
  /** 工作流三角色；未传 = 工作站视角调用，只扫 agents */
  roles?: { planner?: RoleSkillCfg; executor?: RoleSkillCfg; reviewer?: RoleSkillCfg }
}

/**
 * 某个技能当前被"谁绑定了"的完整事实清单。
 *
 * 语义约定（界面据此组装判断，本函数保持单一职责）：
 * - usages 只回答"谁绑定了它"，**不掺 enabled**——enabled 是另一道门（Skill.enabled，注入链里
 *   已被 partitionSkillsForInjection 拦）。"绑了但停用 / 启了没人用"这类叠加出的矛盾状态，
 *   由界面用 usages.length 与 skill.enabled 组合判断；把两件事掺在一起会让清单说不清事实。
 * - 同一个技能既被某 Agent 绑定、又被以该 Agent 为执行者的角色绑定 → 两条 usage 都列出。
 *   两个是真实的不同位置（工作站每次对话 / 工作流该角色），不是同一事实的重复，不做并集。
 * - agents 里 skillMode 缺省按 'reference'（与 AgentConfig.skillMode 的缺省语义一致，types.ts 注明
 *   "缺省或脏值都按 'reference' 处理，老配置行为完全不变"）。
 * - 脏输入安全：agents 非数组 / 元素不是对象 / skillIds 不是数组，都按"没有"处理，绝不抛——
 *   配置文件是用户手可以碰的，界面不能因为一条脏记录整页崩掉。
 */
export function skillUsages(skillId: string, input: SkillUsagesInput): SkillUsage[] {
  // 空串/非字符串的 skillId 不可能被绑定（unionSkillIds 只收非空字符串），直接空清单
  if (typeof skillId !== 'string' || !skillId) return []
  const out: SkillUsage[] = []
  const agents = Array.isArray(input?.agents) ? input.agents : []
  for (const a of agents) {
    if (!a || typeof a !== 'object') continue
    if (!Array.isArray(a.skillIds) || !a.skillIds.includes(skillId)) continue
    // name 缺了给占位而不是拼出 "工作站 · undefined"——显示层不应出现 typeof 字面量
    const name = typeof a.name === 'string' && a.name ? a.name : '未命名 Agent'
    out.push({
      kind: 'agent',
      place: `工作站 · ${name}`,
      mode: a.skillMode === 'auto' ? 'auto' : 'reference'
    })
  }
  const roles = input?.roles
  if (roles && typeof roles === 'object') {
    const labels = { planner: '规划', executor: '执行', reviewer: '审核' } as const
    for (const key of ['planner', 'executor', 'reviewer'] as const) {
      const r: unknown = roles[key]
      if (!r || typeof r !== 'object') continue
      const role = r as RoleSkillCfg
      if (!Array.isArray(role.skillIds) || !role.skillIds.includes(skillId)) continue
      const agentName = typeof role.agentName === 'string' && role.agentName ? role.agentName : ''
      // 现行注入行为：角色级绑定一律当 auto（见上方 RoleSkillCfg 注释）；显式 'reference' 才算引用
      const mode: SkillUsageMode = role.skillMode === 'reference' ? 'reference' : 'auto'
      out.push({
        kind: 'role',
        place: `工作流 · ${labels[key]}${agentName ? `（${agentName}）` : ''}`,
        mode
      })
    }
  }
  return out
}

/**
 * 技能变更的生效时机说明（三处界面共用，防漂移）。
 * 为什么强调"正在流式的回复不受影响"：技能是调用前拼装进 system/user 的，流式中的回复
 * 已经带着旧拼装结果，改开关既不会中断它也不会突然改它——用户最担心的是后者。
 */
export const SKILL_TIMING_NOTE = '所有技能变更只影响下一次调用：正在流式的回复不受影响，无需重启或新建会话。'

/**
 * 两种注入模式的一句话解释（三处界面共用，防漂移）。
 * 措辞钉住两个关键差异：auto 是"持续消耗 token"（每次调用都带全文），
 * reference 是"模型点名才注入"（平时只有一行清单）。auto 放前面因为它是列表缺省认知的对照组。
 */
export const SKILL_MODE_HINTS: Record<SkillUsageMode, string> = {
  auto: '自动：每次对话自动注入全文（持续消耗 token）',
  reference: '引用：只给一行清单，模型点名才注入全文'
}

/**
 * 拨动 enabled 开关的 toast 文案：动作 + 后果 +（有绑定时）恢复路径，一句话闭环。
 * usageCount 传当前绑定处数（skillUsages(skillId, ...).length），由调用方算好——
 * 这里只负责把"停用/启用 × 有/无绑定"四种组合说成人话，n 脏值按 0 处理不抛。
 */
export function skillToggleToast(enabled: boolean, usageCount: number): string {
  // 绑定数只可能是非负整数；防御性收口（NaN/负数/小数都按 0 走"没有绑定处"分支）
  const n = typeof usageCount === 'number' && Number.isFinite(usageCount) && usageCount > 0 ? Math.floor(usageCount) : 0
  if (!enabled) {
    return `已停用：下一次对话起不再注入${n > 0 ? `（仍有 ${n} 处绑定，重新打开即恢复）` : '（当前没有绑定处）'}`
  }
  return `已启用：下一次对话起按各绑定处的模式注入${n > 0 ? `（共 ${n} 处）` : '（当前没有绑定处，去 Agent 管理卡绑定或在输入框引用）'}`
}

/**
 * 技能来源的显示标签（Agent 管理卡 / 技能中心的徽章共用，防两处各写一份）。
 * key 与 Skill.source（'local' | 'builtin' | 'market'）一一对应；未知来源回退显示原值。
 */
export const SKILL_SOURCE_LABELS: Record<string, string> = {
  local: '本地',
  builtin: '内置',
  market: '市场'
}

/**
 * 计划态：在用户批准"怎么做"之前，任务不产生文件改动，交付物是一份计划。
 *
 * 承诺强度只到**模型 Agent 的工具层**——那部分执行权在 AgentHub 手里，"禁止"是真拦。
 * CLI 角色的写盘与命令由它自己的子进程执行，这里拦不到（spec 批次 F / 决策记录 A6：
 * 只能事后列出改动，界面措辞绝不能写成"一定没改文件"）。
 */

/** 会改动盘上或系统状态的五个工具；只读类与联网类不在其内 */
export const WRITE_TOOLS = ['write_file', 'replace_in_file', 'delete_file', 'move', 'run_command'] as const

export interface PlanVerdict {
  allowed: boolean
  reason: string
}

/** 这个名字是不是写类工具（schema 摘除与执行期拒绝共用同一份名单，不许各写一份） */
export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name)
}

/**
 * 计划态下这次工具调用放行吗。
 * `planMode` 只认显式 `true`：缺省 / 脏值 / 字符串一律按非计划态，
 * 免得一路上游塞了个 `'yes'` 就把用户正常授权的工具全关掉。
 */
export function planModeVerdict(tool: string, planMode: unknown): PlanVerdict {
  if (planMode !== true) return { allowed: true, reason: '' }
  if (isWriteTool(tool)) {
    return { allowed: false, reason: '计划态未放开写权限：本轮只读地看，产出计划；用户批准后才允许写类操作。' }
  }
  return { allowed: true, reason: '' }
}

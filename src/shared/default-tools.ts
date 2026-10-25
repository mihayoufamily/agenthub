import type { ToolGrant } from './types'

/**
 * 新模型 Agent 的默认工具授权（2026-10-26 用户拍板：文件+联网，命令默认关）。
 *
 * - 沙箱文件工具：dir 为自动创建的专属工作区（<文档>/AgentHub-workspaces/<name>），
 *   读写删移全限制在其内，路径逃逸即拒绝；
 * - 联网：allowWeb（web_fetch/web_search）默认开——查资料是最常用的基础能力；
 * - 命令执行**不默认开**（allowCommands 不写，缺省即关）：命令面留给用户在授权面板
 *   显式开启并配审批，默认值不替用户做权限最大的决定。
 *
 * 只在创建新 Agent 时使用；已存在的 Agent 永不回填——不做静默改既有配置的迁移。
 */
export function buildDefaultTools(dir: string): ToolGrant {
  return { dir: dir.trim(), access: 'sandbox', allowWeb: true }
}

/** 老 Agent 补默认值的一件改动（界面回执用） */
export interface BackfillPlanItem {
  id: string
  name: string
  tools: ToolGrant
  what: string[]
}

/**
 * "所有老 Agent 一键补默认值"的纯规划器（2026-10-26 用户拍板；显式操作、带确认，不是静默迁移）：
 * - 没有 tools 的模型 Agent：补全套默认（沙箱工作区 + 联网，命令不默认开）；
 * - 已有 tools 的模型 Agent：只补缺——dir 空则填工作区、联网没开则开；
 *   access/命令/审批策略/进阶白名单/MCP 勾选一律不动（用户显式设置的东西不覆盖）；
 * - CLI / 演示 Agent 不碰。
 * dirFor(name) 由调用方注入：主进程是"确保并返回工作区目录"，逻辑层测试传 fake。
 */
export function planDefaultToolsBackfill(
  agents: { id: string; name: string; kind: string; tools?: ToolGrant }[],
  dirFor: (name: string) => string | null
): BackfillPlanItem[] {
  const out: BackfillPlanItem[] = []
  for (const a of agents) {
    if (a.kind !== 'model') continue
    if (!a.tools) {
      const dir = dirFor(a.name)
      if (!dir) continue
      out.push({ id: a.id, name: a.name, tools: buildDefaultTools(dir), what: ['启用工具（沙箱工作区+联网）'] })
      continue
    }
    const what: string[] = []
    let tools: ToolGrant = { ...a.tools }
    if (!tools.dir.trim()) {
      const dir = dirFor(a.name)
      if (dir) {
        tools = { ...tools, dir }
        what.push('补沙箱目录')
      }
    }
    if (!tools.allowWeb) {
      tools = { ...tools, allowWeb: true }
      what.push('开启联网')
    }
    if (what.length) out.push({ id: a.id, name: a.name, tools, what })
  }
  return out
}

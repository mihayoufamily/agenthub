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

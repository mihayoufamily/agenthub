import type { Skill } from './types'

/**
 * 三层 Skill 绑定的合并口径（Agent 级 ∪ 会话手动引用 ∪ 角色绑定）。
 *
 * 用户明确否掉了"优先级开关"（spec 决策记录 A12），所以这里只有并集与去重，
 * 没有谁覆盖谁；顺序按传入层次保留先见到的排前面，便于断言与界面稳定。
 */
export function unionSkillIds(...layers: Array<Array<string | null | undefined> | null | undefined>): string[] {
  const out: string[] = []
  for (const layer of layers) {
    if (!Array.isArray(layer)) continue
    for (const id of layer) {
      if (typeof id === 'string' && id && !out.includes(id)) out.push(id)
    }
  }
  return out
}

/**
 * auto = 注入正文；reference = 只进可引用清单、不注入。
 * 停用的 Skill 即使被绑也不注入（与设置页开关语义、`skillsBlockFor` 现规则同口径）。
 * mode 缺省或脏值一律按 reference：老配置没有这个字段，行为必须与加字段之前完全一致。
 */
export function partitionSkillsForInjection(
  all: Skill[],
  ids: string[] | undefined,
  mode: 'auto' | 'reference' | undefined
): { injected: Skill[]; listed: Skill[] } {
  const picked = (Array.isArray(ids) ? ids : [])
    .map((id) => (Array.isArray(all) ? all.find((s) => s && s.id === id) : undefined))
    .filter((s): s is Skill => !!s && s.enabled !== false)
  return mode === 'auto' ? { injected: picked, listed: [] } : { injected: [], listed: picked }
}

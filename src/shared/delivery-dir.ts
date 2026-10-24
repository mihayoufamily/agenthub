/**
 * 交付目录里"本任务没登记的文件"该怎么列（纯函数，逻辑层逐条断言）。
 *
 * 为什么要它：执行方（尤其 CLI 角色）会往产物目录里留下 AgentHub 没登记的东西——本机实测 codex
 * 探自己能不能写盘时留了一个 `.__write_probe.tmp`（12 B，内容 `write test`），审核方据此按
 * "交付目录有垃圾"判过拒。登记只认 `file_change`/工具写盘回执，所以这类文件不在产物清单里；
 * 这里负责**如实把它们列出来给用户看一眼**，不删——删等于替用户动盘。
 */

const norm = (s: unknown): string =>
  typeof s === 'string'
    ? s.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
    : ''

/** 去掉目录前缀得到相对名；不在该目录下（或不是字符串）时返回 ''，调用方据此跳过 */
function toRel(path: unknown, dir: unknown): string {
  const p = norm(path)
  const d = norm(dir)
  if (!p || !d) return ''
  if (p === d) return ''
  return p.startsWith(d + '/') ? p.slice(d.length + 1) : ''
}

/**
 * @param dirFiles 产物目录的真实清单（相对路径，来自 `artifact:ls`）
 * @param registeredPaths 本任务已登记的产物绝对路径（卡片里的 `kind === 'file'` 那些）
 * @param dir 产物目录绝对路径（用来把已登记的绝对路径折成相对名）
 * @returns 目录里有、但本任务没登记的相对路径；目录清单里本来就有的排序返回，非字符串条目被丢掉
 */
export function pickUnregistered(dirFiles: unknown, registeredPaths: unknown, dir: unknown): string[] {
  if (!Array.isArray(dirFiles) || !Array.isArray(registeredPaths)) return []
  const registered = new Set<string>()
  for (const p of registeredPaths) {
    // 登记的绝对路径可能落在别的目录（换过产物目录的历史任务）：折不进当前目录的也照样按相对名收下，
    // 这样"当前目录里同名文件"仍会被认成已登记，不会虚报成垃圾。
    const rel = toRel(p, dir)
    if (rel) registered.add(rel)
    const base = norm(p).split('/').filter(Boolean).pop()
    if (base) registered.add(base)
  }
  const out: string[] = []
  for (const f of dirFiles) {
    const rel = typeof f === 'string' ? f.trim().replace(/\\/g, '/') : ''
    if (!rel) continue
    const key = rel.toLowerCase()
    const base = key.split('/').filter(Boolean).pop() || key
    if (registered.has(key) || registered.has(base)) continue
    out.push(rel)
  }
  return out.sort()
}

/** 界面文案的口径也抽成纯函数：说清"不登记、不删、只是让你看见"，不写成"已清理" */
export function unregisteredNote(files: string[], truncated: boolean): string {
  const shown = files.slice(0, 8).join('、')
  const more = files.length > 8 ? `；另有 ${files.length - 8} 个未列出` : ''
  const cap = truncated ? '（目录清单过长，只对照了前一部分）' : ''
  return `产物目录里有 ${files.length} 个本任务没登记的文件${cap}：${shown}${more}。AgentHub 不登记它们，也不替你删——要清就自己清。`
}

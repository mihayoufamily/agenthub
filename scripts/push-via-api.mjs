// 当 github.com:443 被代理拦截、仅 api.github.com 可达时，用 Git Data API 推送本地提交。
// 用法：node scripts/push-via-api.mjs [branch]
// 安全保证：每步都校验 GitHub 生成的 tree sha 与本地 commit 的 tree sha 一致（内容字节级相同）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPO = 'mihayoufamily/agenthub'
const BRANCH = process.argv[2] ?? 'main'
const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const API = `https://api.github.com/repos/${REPO}`

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts }).trim()
const gitBuf = (args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 })

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const ADOPT = process.argv.includes('--adopt') // 仅把远端已有提交重建到本地并对齐 ref（推送已完成后使用）
const remoteSha = git(['rev-parse', `refs/remotes/origin/${BRANCH}`])
const commits = git(['rev-list', '--reverse', `${remoteSha}..${BRANCH}`]).split('\n').filter(Boolean)
if (ADOPT) {
  console.log('模式：仅对齐本地 ref（跳过推送）')
} else {
  if (!commits.length) { console.log('无待推送提交'); process.exit(0) }
  console.log(`待推送 ${commits.length} 个提交：${commits.map((c) => c.slice(0, 7)).join(', ')}`)
}

const blobCache = new Map() // localSha -> remoteSha (同值)
async function ensureBlob(localSha) {
  if (blobCache.has(localSha)) return blobCache.get(localSha)
  try {
    await api(`/git/blobs/${localSha}`)
    blobCache.set(localSha, localSha)
    return localSha
  } catch {
    const content = gitBuf(['cat-file', 'blob', localSha]).toString('base64')
    const created = await api('/git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, encoding: 'base64' }),
    })
    if (created.sha !== localSha) throw new Error(`blob sha 不一致：本地 ${localSha} vs 远端 ${created.sha}`)
    blobCache.set(localSha, created.sha)
    return created.sha
  }
}

let parentRemote = ADOPT ? (await api(`/git/refs/heads/${BRANCH}`)).object.sha : remoteSha
for (const sha of ADOPT ? [] : commits) {
  const meta = git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', sha]).split('\0')
  const [an, ae, ad, cn, ce, cd, message] = meta
  const localTree = git(['rev-parse', `${sha}^{tree}`])
  const parentLocal = git(['rev-parse', `${sha}^`])
  const baseTree = git(['rev-parse', `${parentLocal}^{tree}`])

  // 变更清单（--no-renames 保证一行一路径）
  const raw = git(['diff-tree', '-r', '--no-renames', '--raw', '-z', parentLocal, sha])
  // -z 输出为成对字段：":100644 100644 <src> <dst> M" \0 path \0
  const parts = raw.split('\0').filter((s) => s.length)
  const entries = []
  for (let i = 0; i < parts.length; i += 2) {
    const fields = parts[i].split(' ')
    const [srcMode, dstMode, , , status] = fields
    const path = parts[i + 1]
    if (!path) throw new Error(`diff-tree 解析失败：${parts[i]}`)
    if (status === 'D') {
      entries.push({ path, mode: srcMode.slice(1), type: 'blob', sha: null })
      continue
    }
    const blobSha = git(['rev-parse', `${sha}:${path}`])
    const remote = await ensureBlob(blobSha)
    entries.push({ path, mode: dstMode, type: 'blob', sha: remote })
  }

  const tree = await api('/git/trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  })
  if (tree.sha !== localTree) throw new Error(`tree sha 不一致：本地 ${localTree} vs 远端 ${tree.sha}（提交 ${sha.slice(0, 7)}）`)

  const commit = await api('/git/commits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [parentRemote],
      author: { name: an, email: ae, date: ad },
      committer: { name: cn, email: ce, date: cd },
    }),
  })
  console.log(`  ✓ ${sha.slice(0, 7)} -> ${commit.sha.slice(0, 7)}  tree 校验一致  (${entries.length} 项变更)`)
  parentRemote = commit.sha
}

if (!ADOPT) {
  await api(`/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: parentRemote }),
  })
}
// Git Data API 创建的提交与本地 sha 不同（GitHub 会剥掉提交信息结尾换行，时区保留原值），
// 因此按远端返回内容在本地重建 commit 对象并逐字节校验，让本地历史与远端对齐。
const localChain = (ADOPT ? git(['rev-list', '--reverse', `${remoteSha}..${BRANCH}`]).split('\n').filter(Boolean) : commits)
const remoteCommits = []
let cursor = parentRemote
for (;;) {
  const c = await api(`/git/commits/${cursor}`)
  remoteCommits.unshift(c)
  if (!c.parents?.length) break
  const p = c.parents[0].sha
  const existsLocally = (() => { try { git(['cat-file', '-e', `${p}^{commit}`]); return true } catch { return false } })()
  if (existsLocally) break
  cursor = p
}
if (remoteCommits.length !== localChain.length) {
  throw new Error(`提交数量不匹配：远端 ${remoteCommits.length} vs 本地 ${localChain.length}，请人工核对`)
}

const hashCommit = (body) => execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: body, encoding: 'utf8' }).trim()
for (let i = 0; i < remoteCommits.length; i++) {
  const c = remoteCommits[i]
  const localC = localChain[i]
  // 时区：API 一律返回 UTC，真实时区从本地提交取
  const tzOf = (fmtStr) => (fmtStr.match(/([+-]\d{4})\s*$/) ?? [, '+0000'])[1]
  const atz = tzOf(git(['show', '-s', '--format=%ai', localC]))
  const ctz = tzOf(git(['show', '-s', '--format=%ci', localC]))
  const fmt = (p, tz) => `${p.name} <${p.email}> ${Math.floor(new Date(p.date).getTime() / 1000)} ${tz}`
  const build = (message) => {
    let body = `tree ${c.tree.sha}\n`
    for (const p of c.parents ?? []) body += `parent ${p.sha}\n`
    return body + `author ${fmt(c.author, atz)}\ncommitter ${fmt(c.committer, ctz)}\n\n${message}`
  }
  let sha = null
  for (const message of [c.message, `${c.message}\n`]) {
    const out = hashCommit(build(message))
    if (out === c.sha) { sha = out; break }
  }
  if (!sha) throw new Error(`本地重建 commit 对象失败：${c.sha.slice(0, 7)}（字段与远端不一致，已中止对齐）`)
  console.log(`  ✓ 本地重建 ${c.sha.slice(0, 7)} 校验通过（对应本地 ${localC.slice(0, 7)}）`)
}

git(['update-ref', `refs/remotes/origin/${BRANCH}`, parentRemote])
git(['update-ref', `refs/heads/${BRANCH}`, parentRemote])
console.log(`\n推送完成：refs/heads/${BRANCH} -> ${parentRemote.slice(0, 7)}（本地 ref 已与远端对齐）`)
console.log('远端地址：https://github.com/mihayoufamily/agenthub')

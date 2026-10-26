// 公网接入（2026-10-26 批次）：捆绑 cloudflared 跑 quick tunnel，让手机不走同一 Wi-Fi 也能访问手机端服务。
// 设计口径：
//  - quick tunnel 免账号免配置：`cloudflared tunnel --url http://127.0.0.1:<port>`，边缘分配 https://xxx.trycloudflare.com
//    临时地址（每次开启都变，扫码场景无所谓；要固定地址的用户可自配正式隧道，如 mobile.zdymodel.de5.net）
//  - 安全边界不变：公网地址仍带同一 token 才能访问（HTTP 层 fail-closed 不变），TLS 由 Cloudflare 边缘终结
//  - 进程管理：spawn 单进程（cloudflared 不再派生），kill 即回收；退出/超时如实报错，绝不假装成功
//  - 二进制约 15MB：resources/bin/cloudflared.exe（打包时从 <repo>/bin/ 复制，获取方式见 docs/MOBILE_ACCESS.md）
//    未捆绑时如实提示"未找到 cloudflared"，不影响局域网功能
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from './store'

const CONNECT_TIMEOUT_MS = 15000
/** quick tunnel 分配的临时公网地址（出现在 cloudflared 的 stdout/stderr 里） */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i

export interface TunnelStatus {
  /** 用户意图（prefs.mobileService.tunnel，重启后恢复） */
  enabled: boolean
  /** 已拿到公网地址且进程存活 */
  running: boolean
  /** 连接中（已 spawn 还没拿到 URL） */
  connecting: boolean
  url?: string
  error?: string
  /** 本机是否找得到 cloudflared 二进制（决定 UI 是否允许开启） */
  binaryFound: boolean
}

let proc: ChildProcess | null = null
let curUrl: string | undefined
let curError: string | undefined
let connecting = false
/** startTunnel 的等待方（IPC await）；stopTunnel 主动停止时立即放行，避免干等 15s 超时 */
let pendingDone: (() => void) | null = null
let getStoreRef: () => Store | null = () => null
let getWinRef: () => BrowserWindow | null = () => null

// ---------- 配置（读写 prefs.mobileService.tunnel，enabled/port 归 mobile.ts 管） ----------

function readPref(): { enabled: boolean; port: number; tunnel: boolean } {
  const st = getStoreRef()
  const p = st?.getConfig().prefs.mobileService
  return { enabled: p?.enabled ?? false, port: p?.port ?? 8748, tunnel: p?.tunnel ?? false }
}

function writeTunnelPref(on: boolean) {
  const st = getStoreRef()
  if (!st) return
  const cfg = st.getConfig()
  const cur = { enabled: false, port: 8748, token: '', ...cfg.prefs.mobileService }
  st.setPrefs({ ...cfg.prefs, mobileService: { ...cur, tunnel: on } })
}

// ---------- 二进制定位（env 覆盖 → 打包 resources/bin → 开发仓库 bin/） ----------

function findBinary(): string | null {
  const candidates = [
    process.env.AGENTHUB_CLOUDFLARED_PATH || null,
    process.resourcesPath ? join(process.resourcesPath, 'bin', 'cloudflared.exe') : null,
    join(app.getAppPath(), 'bin', 'cloudflared.exe')
  ].filter((p): p is string => !!p)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// ---------- 状态推送 ----------

function status(): TunnelStatus {
  return {
    enabled: readPref().tunnel,
    running: !!curUrl && !!proc && !proc.killed,
    connecting,
    url: curUrl,
    error: curError,
    binaryFound: !!findBinary()
  }
}

function push() {
  const w = getWinRef()
  if (w && !w.isDestroyed()) w.webContents.send('mobile:tunnel-status', status())
}

// ---------- 生命周期 ----------

function startTunnel(): Promise<TunnelStatus> {
  if (proc || connecting) return Promise.resolve(status())
  const bin = findBinary()
  if (!bin) {
    curError = '未找到 cloudflared（resources/bin/cloudflared.exe），公网接入不可用'
    push()
    return Promise.resolve(status())
  }
  const pref = readPref()
  connecting = true
  curUrl = undefined
  curError = undefined
  push()

  return new Promise((resolve) => {
    let settled = false
    const done = () => { if (!settled) { settled = true; pendingDone = null; resolve(status()) } }
    pendingDone = done

    let child: ChildProcess
    try {
      // http2 而非默认 quic：quic(UDP 7844) 被企业防火墙拦截的概率远高于 TCP
      child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${pref.port}`, '--no-autoupdate', '--protocol', 'http2'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      connecting = false
      curError = `cloudflared 启动失败：${e instanceof Error ? e.message : String(e)}`
      push()
      return done()
    }
    proc = child

    let out = ''
    const onData = (d: Buffer) => {
      if (curUrl || settled) return
      out += d.toString('utf8')
      if (out.length > 65536) out = out.slice(-32768) // 防日志无界增长
      const m = out.match(TUNNEL_URL_RE)
      if (m) {
        curUrl = m[0]
        connecting = false
        push()
        done()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (e) => {
      if (proc !== child || curUrl) return // 已被 stopTunnel/新一轮替换，不碰全局状态
      connecting = false
      proc = null
      curError = `cloudflared 启动失败：${e.message}（工作区安全策略可能拦截了该二进制，可设 AGENTHUB_CLOUDFLARED_PATH 指向可用副本）`
      push()
      done()
    })

    child.on('exit', (code) => {
      // 守卫：只认自己还是"当前实例"时的事件。否则 stopTunnel 的 kill 与新一轮 startTunnel
      // 竞态（旧进程 exit 晚到），旧事件会把新实例的 connecting 清掉、写入假错误
      if (proc !== child) return
      proc = null
      connecting = false
      if (!curUrl) {
        // 没拿到地址就退出：最常见的两个原因是本机到 Cloudflare 边缘不通、端口参数异常
        curError = `cloudflared 已退出（code=${code ?? 'signal'}）。公网连不上通常是本机网络到 Cloudflare 不稳定，可稍后重试`
      }
      push()
      done()
    })

    setTimeout(() => {
      if (!curUrl && settled === false) {
        connecting = false
        try { child.kill() } catch { /* 进程可能已退出 */ }
        curError = curError ?? `${CONNECT_TIMEOUT_MS / 1000} 秒内未拿到公网地址（网络到 Cloudflare 不通？）`
        push()
        done()
      }
    }, CONNECT_TIMEOUT_MS)
  })
}

function stopTunnel() {
  connecting = false
  curUrl = undefined
  curError = undefined
  const p = proc
  proc = null
  if (p) { try { p.kill() } catch { /* noop */ } }
  // 等待中的 startTunnel 调用方立刻返回干净状态（主动停止不是错误）
  pendingDone?.()
  push()
}

/**
 * 手机端服务开关联动：服务开→按 tunnel 意图拉起；服务关→隧道必停（公网入口跟随服务存在）。
 * tunnel 的 pref 只存"意图"，服务恢复时由此函数统一兑现。
 */
export function syncTunnelForService(serviceOn: boolean): void {
  if (!serviceOn) { stopTunnel(); return }
  if (readPref().tunnel) void startTunnel()
}

export function initMobileTunnel(opts: { getStore: () => Store; getWin: () => BrowserWindow | null }) {
  getStoreRef = opts.getStore
  getWinRef = opts.getWin

  ipcMain.handle('mobile:tunnelStatus', () => status())
  ipcMain.handle('mobile:setTunnelEnabled', async (_e, on: boolean) => {
    if (typeof on !== 'boolean') return { ok: false, ...status(), error: '参数必须是布尔值' }
    writeTunnelPref(on)
    if (!readPref().enabled) {
      // 手机端服务本体没开：意图已记住，但不启动（公网入口跟随服务）
      return { ok: true, ...status(), error: status().error ?? '请先开启手机端访问' }
    }
    if (on) await startTunnel(); else stopTunnel()
    return { ok: true, ...status() }
  })

  // 随应用启动恢复：服务开着且上次隧道也开着 → 重新拉起（地址会变，弹窗/页面会展示新地址）
  if (readPref().enabled && readPref().tunnel) void startTunnel()
}

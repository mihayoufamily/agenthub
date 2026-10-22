// 渲染进程构建：tsc 编译 TSX -> .tmp，rollup（纯 JS，无原生二进制）打包成单文件 IIFE，复制静态资源
import { rollup } from 'rollup'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import replace from '@rollup/plugin-replace'
import { cpSync, rmSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const cwd = process.cwd()

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd })
  if (r.status !== 0) {
    console.error(`[build-renderer] 命令失败: ${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

// 1) TSX -> ESNext (产物进 .tmp/renderer)
rmSync(`${cwd}/.tmp`, { recursive: true, force: true })
run('npx', ['tsc', '-p', 'tsconfig.build-web.json'])

// 2) rollup 打包（react/react-dom 为 CJS，需 commonjs 插件；NODE_ENV 置 production）
// @shared/* 别名：tsconfig 的 paths 只用于类型解析，不会改写 tsc 产物里的 import 说明符，
// 因此值导入（如 @shared/pricing）必须在此映射到 .tmp/renderer/shared/*（rootDir=src 的产物布局）
const sharedAlias = {
  name: 'agenthub-shared-alias',
  resolveId(source) {
    if (source.startsWith('@shared/')) {
      return `${cwd}/.tmp/renderer/shared/${source.slice('@shared/'.length)}.js`
    }
    return null
  }
}
const bundle = await rollup({
  input: `${cwd}/.tmp/renderer/renderer/src/main.js`,
  plugins: [
    sharedAlias,
    replace({ preventAssignment: true, values: { 'process.env.NODE_ENV': JSON.stringify('production') } }),
    resolve(),
    commonjs()
  ]
})
await bundle.write({
  file: `${cwd}/dist/renderer/bundle.js`,
  format: 'iife',
  name: 'AgentHubBundle',
  indent: false
})
await bundle.close()

// 3) 静态资源
mkdirSync(`${cwd}/dist/renderer`, { recursive: true })
cpSync(`${cwd}/src/renderer/index.html`, `${cwd}/dist/renderer/index.html`)
cpSync(`${cwd}/src/renderer/src/styles`, `${cwd}/dist/renderer/styles`, { recursive: true })
rmSync(`${cwd}/.tmp`, { recursive: true, force: true })
console.log('[build-renderer] done -> dist/renderer/')

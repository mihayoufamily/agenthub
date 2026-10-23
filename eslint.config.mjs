// 最小集：只把“注入面”这类会退化的问题设成 error，其余推荐集一律 warn，起步必须 0 error。
// 价值不在风格，而在于“渲染层 0 处 dangerouslySetInnerHTML”这件事从此由机器守着。
// error 面只有下面 5 条注入规则；@typescript-eslint/recommended 整体降级为 warn，
// 不拦构建、只做卫生提示——凡是会引发风格争论的都不升 error，也不去改 src。
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'

// 把 recommended 的每条规则降级为 warn：保留 off 项与原有 options，只把 error 改成 warn。
const recommendedAsWarn = Object.fromEntries(
  Object.entries(tsPlugin.configs.recommended.rules).map(([rule, conf]) => {
    if (Array.isArray(conf)) return [rule, conf[0] === 'off' ? conf : ['warn', ...conf.slice(1)]]
    return [rule, conf === 'off' ? 'off' : 'warn']
  })
)

// 基础规则 no-implied-eval 只认「已声明为全局」的计时函数：若 globals 里没有 setTimeout，
// setTimeout('字符串') 会被静默放过（teeth test 抓到的坑）。这里只声明该规则会检查的那组全局
// ——计时函数 + window/global/globalThis 三种成员写法——让 no-implied-eval 真正咬得住。
// no-eval / no-new-func 无需此声明，eval 与 Function 是语言内建、不是环境全局。
const impliedEvalGlobals = Object.fromEntries(
  [
    'setTimeout', 'setInterval', 'setImmediate',
    'requestAnimationFrame', 'requestIdleCallback',
    'msSetImmediate', 'msSetInterval', 'msRequestAnimationFrame', 'msRequestIdleCallback',
    'window', 'global', 'globalThis'
  ].map((name) => [name, 'readonly'])
)

export default [
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'verify/shots*/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: impliedEvalGlobals
    },
    plugins: { '@typescript-eslint': tsPlugin, react: reactPlugin },
    rules: {
      ...recommendedAsWarn,
      'react/no-danger': 'error',
      'react/no-danger-with-children': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
]

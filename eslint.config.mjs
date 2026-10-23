// 最小集：只把“注入面”这类会退化的问题设成 error，其余推荐集一律 warn，起步必须 0 error。
// 价值不在风格，而在于“渲染层 0 处 dangerouslySetInnerHTML”这件事从此由机器守着。
// error 面只有下面 5 条注入规则；@typescript-eslint/recommended 整体降级为 warn，
// 不拦构建、只做卫生提示——凡是会引发风格争论的都不升 error，也不去改 src。
//
// noInlineConfig（修复波 A · 项 4）：这 5 条 error 是本配置存在的全部意义，而一行
// `// eslint-disable-next-line no-eval` 就能在**没人评审得出来**的地方把它关掉
// （评审实测：disable 注释 + eval('1') → 0 error）。所以 inline 配置一律禁用：
// 真要豁免只能改这个文件，而改这个文件是会进 diff、会被评审看到的。
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
// setTimeout('字符串') 会被静默放过（teeth test 抓到的坑）。
// 声明的范围严格等于规则**真会查**的那一组——它源码里的模式是
// `/^(?:set(?:Interval|Timeout)|execScript)$/u`（node_modules/eslint/lib/rules/no-implied-eval.js），
// 外加 global / window / globalThis 三种成员写法（同文件的 GLOBAL_CANDIDATES）。
// 所以这里只有 setTimeout、setInterval、execScript 三个裸名字 + 那三个宿主对象。
// 评审实测的两头都不准已修掉：① 原先漏了规则真会查的 execScript（裸调用静默放过）；
// ② 原先声明了 7 个规则**永远不会查**的名字（setImmediate、requestAnimationFrame、
// requestIdleCallback、msSetImmediate、msSetInterval、msRequestAnimationFrame、
// msRequestIdleCallback）——声明了也一条都不报（verify/fixes-check.mjs [Z4] 段有反向断言钉住），
// 只会让读配置的人以为这些 sink 有人看着。删掉，不留"仅文档用途"的假声明。
// no-eval / no-new-func 无需此声明，eval 与 Function 是语言内建、不是环境全局。
const impliedEvalGlobals = Object.fromEntries(
  ['setTimeout', 'setInterval', 'execScript', 'window', 'global', 'globalThis'].map((name) => [name, 'readonly'])
)

/** 注入面那 5 条 error 规则：src/** 与发版路径（verify/**、scripts/**）共用同一份，别各写一遍 */
const injectionRules = {
  'react/no-danger': 'error',
  'react/no-danger-with-children': 'error',
  'no-eval': 'error',
  'no-new-func': 'error',
  'no-implied-eval': 'error'
}

export default [
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'verify/shots*/**'] },
  // 顶层默认：对所有被 lint 的文件生效（含 eslint.config.mjs 自己）。
  // 单独成一个 block——把 linterOptions 塞进上面那个只有 ignores 的对象里，会让它从
  // "全局忽略"退化成"某个 config 的局部排除"，out/dist/release/node_modules 就又被 lint 了。
  { linterOptions: { noInlineConfig: true } },
  {
    files: ['src/**/*.{ts,tsx}'],
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: impliedEvalGlobals
    },
    plugins: { '@typescript-eslint': tsPlugin, react: reactPlugin },
    rules: {
      ...recommendedAsWarn,
      ...injectionRules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  // 发版路径也过同一套注入规则：verify/**（三层验证脚手架，会 spawn 真进程、拼命令行）
  // 与 scripts/**（构建/打包/发布）原先是"零规则过一遍"，而它们守的正是发版那条路。
  // 只在新增 0 error 时才留这个 block（评审判"cheap 就做"）；一有 error 就删掉，不为了过而放宽。
  {
    files: ['verify/**/*.mjs', 'scripts/**/*.mjs'],
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...impliedEvalGlobals, process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' }
    },
    plugins: { react: reactPlugin },
    rules: { ...injectionRules }
  }
]

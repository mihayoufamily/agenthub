# AgentHub 批次方案：权限兜底、界面诉求、Agent 卡片、计划态、技能中心

日期：2026-10-23　基线：`cc5416e`（v0.3.0）　范围：6 个批次分 3 次发版
（文中代码位置均为仓库 `D:\dsh\agenthub` 内的相对路径，行号取自 v0.3.0 基线，实现时会漂移，按符号名定位优先。）

## 目标

把 v0.3.0 之后暴露的三类问题一次处理干净：外部评审（kimi-3 / deepseek）提出的**权限与兜底缺口**、用户亲自提的**5 项界面诉求**、以及两个"有底座、只差组合"的能力（**计划态**、**技能中心**）。

## 非目标（本轮明确不做）

- **G 整条不做**：Agent 间链式协作（一个 Agent 输出喂下一个）、MCP 配置文件导入（`claude_desktop_config.json`）。
- **A2 不做**：`web_fetch` 的 DNS rebinding 窗口保持现状，README 措辞原样保留。不换传输层，也不附带做"解析结果全部地址过校验"这类加固——避免出现"改了一半却声称关掉了"的状态。
- 不引入图表库、不引入 Vitest、不做插件/扩展点（已延期，见记忆）。

## 发版切法

| 次 | 批次 | 版本 | 理由 |
|---|---|---|---|
| 1 | A + B | **v0.4.0** | `McpServer` 数据模型破坏性变更（旧配置作废）+ CI 门禁 |
| 2 | C + D + F | **v0.5.0** | 界面与体验 + `AgentConfig` 新增字段 + 计划态 |
| 3 | E | **v0.6.0** | 技能中心新屏 + 内置 skill 机制 |

每批发版只推 tag，由 `.github/workflows/release.yml` 自己构建发布，**不再手工上传资产**。实施计划按次拆分：**先只做 v0.4.0 那一份**，做完验收再写下一份，避免一份计划横跨三次发版失去可执行性。

---

## 决策记录

分两档：**A = 用户拍定**（照此执行，不要重新解释）；**B = 我的推论**（用户未表态，写在 spec 里但可被否）。原 C 档 4 条已在 2026-10-23 全部由用户确认，并入 A 档。

### A · 用户拍定

1. **范围**：按推荐切法做 A–F，G 不做，E 做。
2. **E 的边界**：本轮只交付机制与页面，**内置内容由用户之后自己填**；技能中心**必须保留导入入口**（原话"记得给我留导入窗口"）。
3. **旧 MCP 配置不兼容**：一律作废重填，不做自动拆分、不猜。
4. **沙箱降级**：保留自动降级，但要可见（常驻徽章）且策略可改（三态）。
5. **Agent 级 Skill**：两种模式都给（自动注入 / 仅可引用），用户自己切。
6. **计划态承诺强度**：CLI 侧不拦，只事后列出改动（用户原选"不拦，只做事后透明"）。模型 Agent 侧仍真拦——那是禁止表的原有基线，不是新增承诺。
7. **计划态粒度**：任务级——开工前先出一轮计划，批准后才进正常三角色链。
8. **饼图位置**：两处都要（用量统计页 + 对话栏）；用量统计页 = **双环，内圈接入方、外圈模型**。
9. **内置 skill 的存放**：仓库 `build/skills/`，随包发；语义是"技能中心自带的、由用户自己写内容，其他用户自行选择是否使用"（= 有启用/禁用开关）。
10. **A2 整条本轮不做**：`web_fetch` 保持现状，含"全部地址过校验"这类附带加固也不做。
11. **内置 skill 形态 = 只读引用 + 另存副本**（不复制进 `skills.json`，正文只读，启用状态单独存）。
12. **Agent 级 skill 与角色绑定的关系 = 并集去重，不加优先级开关**（用户明确否掉了自己先前所选选项里的那层开关）。
13. **对话栏迷你图 = 单环**（按 harness 分色，复用已有图标按钮位置），接受相对"双环"的尺寸缩水；界面文案不出现"双环"。
14. **旧包删除已获用户本人授权**：`verify/AgentHub-v0.1.0-win-x64-portable.zip` 用精确路径删，删前 `git status --porcelain --` 核对未跟踪。（先前 spec 记成"已获点头"是误判——那句来自粘贴的外部评审文本。）

### B · 我的推论（用户未表态）

15. **C2 动画只重做工作站侧**，工作流的进入方式本轮不动。依据是用户原话只提了"进入工作站模式时跳出的"。
16. **旧 MCP 记录的处置为"禁用但不删除"**，并给「重填」入口。用户只说了一律作废，没说删不删；不删是可逆的那一侧。
17. **计划态下禁止 AgentHub 自己的兜底落盘**。不禁止就会出现"计划正文写进产物目录"的自相矛盾。

---

## 批次 A：权限与兜底（v0.4.0）

### A1 MCP 起进程不走 shell

现状：`src/main/mcp.ts:57` 为 `spawn(cmd, { shell: true, ... })`，整条命令字符串交 cmd 解析。

- **数据模型**：`McpServer`（`src/shared/types.ts:621`）加 `launch?: { bin: string; args: string[] }` 与 `formatVersion?: 2`；`command: string` 降级为只读旧字段。
- **迁移**：读盘时 `command && !launch` → 置 `invalid_legacy_command` 状态，**禁用但不删除**；`probeServer` 与 connect 统一返回该错误码（界面按错误码渲染，不靠文案匹配），并给「重填」按钮直达表单。
- **表单**：保持**单个命令输入框**，提交时用已有的引号感知 `splitSegments`（`src/shared/approvals.ts`）切成 argv 数组存下，旁边把 `JSON.stringify([bin, ...args])` 原样摊出供核对。
  - **实现时改判（2026-10-24 · 控制器裁决 · Ruling U：本条原话一字未改，只在这里加注）**：上线的**不是** `splitSegments`，而是新建的 `src/shared/argv.ts` 里的 `tokenizeCommand`。理由是实测出来的功能差别，不是口味：`splitSegments` 切的是"这条命令由几段子命令组成"（按 `&& || ; |` 断开），**分段符留在结果里、引号也原样保留**，把它当 argv 用会切出 `"C:\Program Files\nodejs\npx.CMD"` 这种带引号的元素，`launch.bin` 直接不可执行；`tokenizeCommand` 才是"按空白切、引号内空白算参数内容、引号本身剥掉"的那一个（`argv.ts:20`）。另附一条同源纠正：`splitSegments` 在 `approvals.ts:18` 至今只服务命令审批，本批没有把它拉去复用，也就没有"一处改动同时打断审批判定"的风险。
  - 否决"一行一个参数"的逐格填写：Windows 上 `npx` 的真身是 `"C:\Program Files\nodejs\npx.CMD" node_modules\npm\bin\npx-cli.js -y <pkg>`，含空格路径 + 含空格参数，逐格手写不可用。
- **`.cmd` 家族的启动路径**：定为方案 1——用 `comspec /d /c` 显式包一层并按 argv 转义，**只对 `.cmd/.bat` 家族开**，界面上标出"此 server 经 cmd 启动"。执行前有一个**实测前置步**：在本机 Electron 37 内确认 `.bat/.cmd` 在 `shell: false` 下的真实失败形态（ENOENT 还是 EINVAL）；若实测表明 `.cmd` 可直传，则改为真 `shell: false`（方案 2 的简化），并删掉界面上的 cmd 标注。**两种结果都算达成目标，但承诺措辞必须跟实测一致**——不能既支持 npx 又声称纯 `shell: false`。
- **断言**：旧格式记录不产生任何子进程；命令串里的第二段（用 sentinel 文件 `&& node -e "fs.writeFileSync(...)"`，不用 `calc`，保证 CI 可重复）**不落地**。

### A3 窗口导航兜底

- `setWindowOpenHandler`：`https?:` 先校验再 `shell.openExternal(url)`，随后**一律** `return { action: 'deny' }`（不是裸 deny，否则将来出现 `target=_blank` 外链会点了没反应）。
- `will-navigate`：只放行生产 `file://` 应用目录与开发 `http://localhost:<端口>`，其余 `preventDefault()` 后走已限 `https?:` 的 `openExternal`（`src/main/ipc.ts:138`）。
- `will-redirect`：一并拦（已核实 Electron 37 的 `electron.d.ts` 存在该事件）。
- 如实记录：当前渲染层**没有任何** `target=_blank` / `window.open`（全量 grep 0 命中），这三条是防退化，不是修现网漏洞。

### A4 沙箱降级可见可改

现状：`src/main/index.ts:30-34` 崩溃 2 次后静默带 `AGENTHUB_NO_SANDBOX=1` 重启，只在 `start-compat-mode.cmd` 里提过。

- 新增 `sandboxFallback: 'auto' | 'ask' | 'off'`，默认 `auto`。
  - `auto`：直接降级继续，降级后**非阻塞**提示一次三选并把选择落盘；
  - `ask`：降级前阻塞询问，拒绝则按启动失败处理；
  - `off`：不自动降级，沙箱失败直接报错退出，绝不静默继续。
- 顶栏黄徽章「兼容模式：渲染沙箱已关闭」按**实际状态**常驻，不是"配置写了就显示"；设置 → 关于 同步显示原因与当前策略。
- 真机要能验：加一个**仅验证环境生效**的降级触发门控（`window.__ahub_debug` 或专用 env），CI 构建不启用。没有它，A4 界面那一半等于没验过。

### A5 Hook 命令指纹

- 每条 Hook 旁显示 `normalizeCommand` 归一后的指纹，**截断并脱敏**（命令里可能带 token）。
- 指纹只用于肉眼比对，**不参与放行决策**；红字风险文案已有（`src/renderer/src/features/SettingsPage.tsx:505`），不动。
  - **实现时改判（2026-10-24 · 控制器裁决 · Ruling U：本条原话一字未改，只在这里加注）**：上面那句"截断并脱敏"如果被读成"指纹是对**脱敏后**的串算的"，那就是错的，本批刻意改判为**两条分开的通路**——**脱敏与截断只作用于显示回显**，**指纹对 `normalizeCommand` 归一后的命令原文算**。理由：`redactSecrets` 会把凭据值整段遮成 `***`，两条只有 token 不同的命令在脱敏文本上完全一样，指纹也就一样 —— 用户换了 key 却看见指纹没变，等于这条显示用散列在它最该起作用的那一格上是瞎的。改判后"改任意一个字符（含被遮成 `***` 的凭据值）指纹就变"，而大小写与空白差异仍同指纹，与放行判定用的 `normalizeCommand` 同口径。断言钉在 `verify/fixes-check.mjs`：`显示被遮成一模一样、指纹仍不同（证明哈希不吃 redactSecrets 的输出）`，并用变异实验证明它咬得住。参与放行决策的那一半（"永不参与放行"）原样成立，未改判。

---

## 批次 B：工程配套（v0.4.0）

- **B1** `ci.yml` 在 `npm run build` 后加 `npm run verify`（纯逻辑层，不起应用；PR 与 main 都跑）。现状是 CI 只有 `npm run build`，**逻辑断言在 CI 上一条都没执行过**（计划期此处印的是"303 条"）。落地后 CI 实际跑到的计数（2026-10-24 全量实测）：`fixes-check` **483 PASS / 0 FAIL** + `deliver` **52 PASS / 0 FAIL** = 逻辑层 **535** 条，且 `verify/run-all.mjs` 的 `SUITES` 给每套件钉了 `min` 下限（`fixes` 483 / `deliver` 52），条数一掉就红；计数不再写死在 YAML 里。这条收益高于引入 Vitest：`shared/approvals` 的四个规则早已有正反用例，缺的只是执行。
- **B2** `npm audit --omit=dev --audit-level=high`。本机 registry 为 `registry.npmjs.org`（已确认，audit 端点可用）；失败不吞。
- **B3** ESLint 最小集：error 只开 `react/no-danger`、`no-eval`、`no-new-func`、`no-implied-eval`，`@typescript-eslint/recommended` 全设 warn；起步必须 0 error。价值在于"渲染层注入面 0 命中"从此由机器保证，而不是每次人工复查。
  - **这句保证在实现后被判为夸大（2026-10-24 · 最终整枝评审 ㊾ · 控制器裁决"改宣称、不改代码"；原话保留在上一条）**：这 5 条 error 规则（原文只列了 4 条，落地时补了 `react/no-danger-with-children`）**管不到** `innerHTML` 直接赋值、`window.open`、`javascript:` URL、动态 `href` —— 这些写法今天 0 命中是**人工维持**的结果，没有机器拦。`react/no-danger` 也看不见经 prop 展开传进去的 HTML。真正由机器守着的只有：JSX 里的 `dangerouslySetInnerHTML`，以及 `eval` / `new Function` / 隐式 eval。如实版本写在 README「未实现 / 已知限制 ❌」，本条以它为准。
  - 落地后另外补上的两件事（原条目没写）：`linterOptions.noInlineConfig: true`（此前一行 `// eslint-disable-next-line no-eval` 就能静默关掉这台机器）与 `impliedEvalGlobals` 按规则实查范围校准；`verify/**`、`scripts/**` 也已上同样的 5 条 error 规则。当前基线 **0 error / 24 warn**（2026-10-24 实测）。
- **B4** `release.yml` 平铺修正：现有 `Compress-Archive -Path release/AgentHub-win-x64` 会多套一层目录（与"解压后双击 `AgentHub.exe`"和历史包不符），且 `Compress-Archive` **不展开 glob**，改成 `-Path .../*` 会直接报错。改用 Windows 自带 bsdtar：
  `tar.exe -a -c -f AgentHub-<tag>-win-x64-portable.zip -C release/AgentHub-win-x64 .`
- **B5** 删本机 `verify/AgentHub-v0.1.0-win-x64-portable.zip`（134MB，未跟踪；`git ls-files '*.zip'` = 0，说明仓库本来就没有二进制，`.gitignore:13` 已覆盖 `verify/*.zip`，无需再加）。**用户本人已授权删除**（决策记录 A14）。删除前先 `git status --porcelain -- <精确路径>` 确认，**只用精确路径，不用通配**。

---

## 批次 C：界面诉求（v0.5.0）

### C1 首页模式选择下移

现状：首页专属的绝对定位 pill（`src/renderer/src/features/BrandHome.tsx:81-98` + `styles/screens.css:236`，`top:20px; right:24px`），说明卡 `.mode-info` **已存在**（`BrandHome.tsx:101-120`）。所以这是搬位置 + 换触发，不是新做一套。

- 交互：**悬浮或键盘聚焦 = 展开介绍；第一次点击 = 选中；再点同一个已选中的 = 直接进入该模式**（走已有 `enterMode`，`features/ModeSwitch.tsx:14-41`）。
- 不做"只有 hover 一条路"：聚焦等同 hover，触屏与键盘用户才拿得到介绍。
- 介绍文案承担解释责任：进工作站要先有可用 Agent，进工作流要三角色可用，"先让你选是为了省掉后面的返工"。
- 「没选模式就发送 → 弹请选择工作模式」的 Modal 保留（`BrandHome.tsx:63-77`）。

### C2 进入工作站的过渡动画

现状：无条件渲染的全屏大字层（`features/Workbench.tsx:63` + `styles/workbench.css:23-40`），淡入 80–330ms、淡出 650–900ms，`z-index:60`，**没有任何状态位**，因此每次重挂载都重放——这才是"挡事"的根因，不只是观感问题。

- 新时间线：黑幕淡入 → 「工作站模式」出现 → 整块缩小并上移 → **落位为顶栏常驻的小模式名** → 黑幕退场，全程一次。时长 ~500ms 黑幕 + ~250ms 落位（比现在 900ms 短）。
- **新增状态位**：只在真正切模式时播（首页 `enterMode`、`Ctrl+M`、侧栏「切换模式」）；重启恢复、切任务、切会话等纯重挂载**不播**。
- 落位后的常驻模式名与现有空状态标题（`.wb-topbar .title`，`Workbench.tsx:70`）**复用同一个元素**，不让两个标题并存。
- 尊重已有的"减少动态效果"偏好（开屏动画已接）。
- 顺带清死代码：`switchHud` 的纯文本 HUD（`Workbench.tsx:49-52`）全仓无人渲染，`ModeSwitch.tsx:50-61` 只认 `__switch_warn:` / `__switch_ask` 前缀。

### C3 token 饼图

- 零依赖手写 SVG（参照 `components/Icons.tsx` 的画法），数据源 `bridge.ledger.list()`，口径复用现成 `rollup()`（`components/UsagePanel.tsx:219-240`）。
- 用量统计页：完整**双环**（内圈 harness、外圈 model），受"近 7 天 / 近 30 天 / 全部"分段控制，点外圈扇区筛下方表。
- 对话栏：把已有的图表图标按钮本身换成**单环迷你图**（`features/ChatView.tsx:271-336` 的 `ContextUsageBar`，图标在 322 行），位置与点击行为不变，不加高底部条；悬停 tooltip 列本会话各模型占比。**已确认接受相对"双环"的尺寸缩水**（决策记录 A13），界面文案不出现"双环"字样。
- 诚实边界必须画在图上：账本**只留最近 2000 条**（`src/main/ledger.ts:18`）、CLI 多数**不上报 usage**，所以"总计"只代表 ledger 可见调用。未上报的调用单列一格「未上报」，按调用次数计，**不估算 token**。

---

## 批次 D：侧栏 Agent 管理卡片（v0.5.0）

- **卡片**：现有 `⋯` 下拉（`features/Sidebar.tsx:163-175`，已有 fixed 坐标与上下翻转）从 2 项扩成 Agent 管理卡片：常驻提示词 + Skill 区 + 原有两项。
- **数据模型（本批真正的新东西）**：`AgentConfig`（`src/shared/types.ts:12`，`systemPrompt` 在同文件 23 行）加 `skillIds?: string[]` 与 `skillMode?: 'auto' | 'reference'`。
  - `auto` = 该 Agent 每次调用自动注入这些 skill 正文（工作站每轮、工作流每角色）；`reference` = 只进可引用清单，不自动注入。
  - 与已有三层是**并集去重**：Agent 自动注入 ∪ 会话手动引用 ∪ 角色绑定（`WorkflowRoleConfig.skillIds`，`types.ts:349`）；**停用的 skill 即使被绑也不注入**（沿用现规则，`SettingsPage.tsx:248-253`）。**不加优先级开关**（用户明确否掉了自己先前所选选项里的那层开关，决策记录 A12）。
  - 注入顺序不变（协议 → 项目约定 → 历史记忆 → 角色技能 → 常驻要求），Agent 级技能**并进"角色技能"层**，不开新层——这个顺序是 v0.3.0 刚拍定的，不为一个字段重排。落点在 `stores/sessions.ts:232` 与 `lib/rolePrompts.ts:152` 两个消费点。
  - 老配置无 `skillIds` → 行为完全不变；`config.json` 版本号递增走已有迁移机制（`src/main/store.ts:30`）。IPC 不加，`bridge.config.setAgents` 已覆盖。
- **唯一编辑入口**：常驻提示词现在写在 `ModelManageModal` 的 textarea（`features/ChatView.tsx:1177-1197`，`onBlur` 存 `systemPrompt`）。定为侧栏卡片是唯一编辑处，弹窗里改成只读摘要 + "到侧栏编辑"跳转——两处写同一字段必然漂移。

---

## 批次 F：计划态（v0.5.0）

**它负责的一件事**：在用户批准"怎么做"之前，任务不产生文件改动，交付物是一份计划。

| 项 | 计划态下 |
|---|---|
| 允许 | 读文件、`search_files` / `glob_files`、repo map、项目约定、长期记忆、联网（仅当 `allowWeb` 已开） |
| 禁止 | `write_file` / `replace_in_file` / `delete_file` / `move` / `run_command`，**以及 AgentHub 自己的兜底落盘**（否则计划正文就写进产物目录，自相矛盾） |
| checkpoint | 不建（不改文件） |
| 额度 | 照实消耗一次真实调用 |
| 批准后 | 同一个 run 继续，带计划上下文，不重跑、不重放 |
| 界面 | 卡片与确认门带「计划态」标记；计划正文可复制，点"存"才写成产物 |
| 不负责 | 不保证计划正确、不代替审阅、不冻结产物目录（只读地看） |

- 粒度：**任务级**。开工前跑一轮只读规划 → 出计划正文 → 批准 → 进入正常三角色链。
- **承诺强度按角色分区，界面措辞照此写**：模型 Agent 的工具层在 AgentHub 手里，"禁止"是真拦；CLI 角色的写盘与命令由它自己的子进程执行，AgentHub 只能下发提示词。所以标签是"模型 Agent 不写盘；**CLI 角色的改动在计划轮结束后列出来**"，绝不能写成"一定没改文件"。
- 实现落点：`ToolGrant` 加计划态标志，`execTool` 的 `dispatch` 前按工具类别拦（写类直接回模型"计划态未放开写权限"），复用现有 `commandPolicy` 与 `previewWrites` 的判定路径，不新建底座。

---

## 批次 E：技能中心与内置机制（v0.6.0）

- **页面**：应用无 router，页面靠 `stores/ui.ts` 的 `Screen` 枚举 + `App.tsx:211-221` 加一路分支。入口加在 `.sidebar-foot`（`features/Sidebar.tsx:217-230`，4 个按钮变 5 个）。列表按 **内置 / 已安装** 分组，每项显示名称、一行描述、启用开关、来源徽章（`agentskills` 目录 / 手建 / 内置），点开看正文。
- **导入窗口保留**：`skills:importDir`（认 `SKILL.md`、读 frontmatter、登记 `references/` `scripts/` 路径，`src/main/ipc.ts:547-583`）与"导入 .md 文件"（`SettingsPage.tsx:265-277`）两条都搬进技能中心。设置页 Skill 分区不删，改为一句"管理 Skill 请去技能中心"+ 跳转，避免同一份数据两个编辑面。
- **数据层收敛**：Skill 现在有两套——`userData/skills.json`（`src/main/store.ts:15`，设置页与聊天用）与 `AppConfig.skills?`（`types.ts:433`）。本批按 `skills.json` 收敛为唯一来源，清掉 `AppConfig.skills` 的读取点。渲染层当前没有 skills 的 zustand store（`SkillsSection` 用局部 `useState`，`SkillPicker` 各拉各的），本批新增一个统一 store，否则技能中心就是第三份重复实现。
- **内置机制**：**只读引用派（用户已确认，决策记录 A11）**——不复制进 `skills.json`、不写同步与冲突逻辑。
  - 内容放仓库 `build/skills/*.md`，`scripts/pack-portable.mjs` 整目录复制 `build/`，便携版自动带上；`electron-builder.yml` 的 `files` 需新增 `build/skills/**`（现只有 `out/**`、`dist/**`、`build/icon.ico`、`package.json`）。
  - 运行时每次现读随包目录，升级即生效，无冲突、无迁移。用户侧动作只有**启用/禁用**与**另存为我的副本**（副本可编辑，落进 `skills.json`）。
  - 内置项不进 `skills.json`，因此"删除"对它无意义；界面用不同徽章区分，不让人误以为能删内置。启用状态单独存（`userData` 里一个 `builtin-state.json` 之类，只记 `id → enabled`），避免"只读引用"和"可持久开关"互相打架。

---

## 验证计划

- 每批完成 = `npm run verify`（逻辑层）+ `npm run verify:gui`（真机 9 套件）全绿，且新增断言覆盖该批行为；发版前重新构建并部署到 `D:\AgentHub\resources\app` 再跑真机（只构建不部署等于用旧包验新代码）。
- 需要新写的真机断言：
  - A1 旧格式记录不起进程 + sentinel 文件不出现；
  - A4 徽章与三态（靠验证环境门控触发降级）；
  - C1 悬浮/聚焦出介绍、二次点击跳转；
  - C2 动画只在切模式时播一次、重挂载不播；
  - C3 双环扇区数与「未上报」格存在；
  - D `auto` 与 `reference` 两种模式在注入文本里可见差异；
  - F 计划态下写类工具返回拒绝、兜底落盘不写、计划轮结束后 CLI 改动被列出；
  - E 内置项只读 + 另存副本可编辑 + 两个导入口可用。
- 无法脚本验证、需人工核：A3 的窗口拦截（需真实外链点击）、C2 的观感（动画顺不顺只有眼睛能判），以及既有的两项遗留（`Ctrl+W` 确认框与托盘、真实图片输入）。

## 已知限制（发版说明照此写，不粉饰）

- 计划态对 CLI 角色**不构成写入约束**，只事后列改动。
- MCP 的 npm 家族与 `.cmd/.bat` 仍显式经 `cmd.exe` 启动，不声称纯 `shell: false`；该分支对参数采用**拒绝式**校验——含 `"`、`%`，或含任一 cmd 元字符（与、或、管道、重定向、转义符）的 token **一律直接报错，与有无空格无关**。执行侧实测过：在这条调用路径上把 token 包进双引号**并不能**让 `&` 变成字面量（哨兵文件照样被写出），所以"加引号即安全"的前提是错的，不接受它作为放宽理由。代价：`--filter=a&b`、`--filter="a b"` 这类值在该分支不支持；真正 argv 直传的 `.exe`/脚本路径不受此限制。另一处已知失败形态：comspec 命令行里出现第二对引号时 cmd 会剥掉首尾引号，该 server 起不来（实测旧写法同样起不来，且失败是响的、不会退化成注入）。
- `web_fetch` 的 DNS rebinding 窗口本轮不处理，README 原条目保留。
- 饼图分母是 ledger 可见调用（2000 条上限、CLI 多数无 usage），不是全量账单。
- 内置 skill 只读，正文要改必须先另存副本。

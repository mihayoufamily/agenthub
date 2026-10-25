# AgentHub 官方技能注册表

这个目录是 `agenthub-skills` 仓库（`https://github.com/mihayoufamily/agenthub-skills`）的**本地脚手架**：
`index.json` 与 `packs/` 的内容原样推到该仓库 main 分支后，AgentHub 客户端即可从
`https://raw.githubusercontent.com/mihayoufamily/agenthub-skills/main/index.json` 拉到。

收录审核在项目方：任何人都可以提 PR，合入前由维护者人工过目。**第三方注册表源刻意不做**——
客户端把包下载 url 锁死在本仓库 `packs/` 前缀内（即使 index.json 被篡改，包也只能来自这个仓库前缀）。

## 收录流程

1. 准备技能目录：一个目录含 `SKILL.md`（frontmatter 需 `name` / `description`，建议带 `version` / `author` / `homepage`）。
   可以直接在 AgentHub 里「导出技能包」得到 zip（它产出的就是 store-only、可复现哈希的规范包）。
2. 把 zip 放进 `packs/<id>-<version>.zip`，`id` 用目录名（字符限 `A-Za-z0-9._-`）。
3. 在 `index.json` 的 `items` 数组追加一条，`sha256` 与 `size` 必须与 zip 逐字节一致。
4. 提 PR。维护者核对哈希、内容与命名后合入。

## sha256 怎么算

Windows PowerShell：

```
Get-FileHash .\packs\code-review-1.0.0.zip -Algorithm SHA256
```

Node（与仓库验证脚本同一口径，十六进制小写）：

```
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('packs/code-review-1.0.0.zip')).digest('hex'))"
```

注意：zip 里的 DOS 时间固定为 2026-01-01 00:00，因此**同样内容打包出逐字节相同的文件**，
哈希只随内容变。改了一个字就要重算哈希并更新 index.json，否则客户端按声明哈希拒绝安装。

## index.json 字段说明

| 字段 | 要求 | 客户端行为 |
| --- | --- | --- |
| `id` | 非空，仅 `A-Za-z0-9._-`，≤64 字符 | 安装后技能 id 为 `market-<id>`（同 id 覆盖更新，绑定不断链） |
| `name` | 非空字符串，≤60 字符 | 技能显示名（SKILL.md frontmatter 的 name 优先） |
| `desc` | 字符串，≤200 字符 | 列表里的简介 |
| `version` | 非空字符串，≤40 字符 | 显示与安装目录名的一部分 |
| `sha256` | 64 位十六进制，与 zip 实际哈希一致 | 不符即拒绝安装，回执给出两个哈希值 |
| `size` | 正整数（字节） | 下载有 2MB 硬上限，超限条目没有意义 |
| `url` | 必须以 `https://raw.githubusercontent.com/mihayoufamily/agenthub-skills/main/packs/` 开头 | 越权 url 的条目被跳过并点名，不整表拒绝 |
| `author` / `homepage` | 可选；homepage 须为 https | 仅展示 |

非法条目（缺字段、哈希格式不对、url 越权等）会被客户端**跳过并在界面上点名**，不影响其余条目。

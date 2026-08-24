# dsh-plugin-response-window

DeepSeek Harness (DSH) Web 插件：把一轮里的 think（推理）和工具调用放进**有限高度的可滚动窗口**（默认 10 行），以**阶段性文字回复为界分段**，每个分段一个 **slide**；文字回复保持原生完整显示、不做限高。中间过程**始终可见**（只是不撑爆页面）——Grok Build 风格。

> 与「全部折叠成 summary」类插件（如 `dsh-tool-summary`）不同：本插件**不隐藏**任何内容。think 与工具调用一条条列在 slide 里，每段都能展开翻到底；文字回复完全原生展示。
> 只包 bash + think：阶段性/最终文字 response **不**加限高、**不**加「展开全部/收起」按钮。

## 效果

一个 prompt 之后有 100 次 tool call + 长回复时：

- **think（推理）和工具调用** → 合并为 slide（think 与 tool call 都是 implementation，不做区分）：
  - **以「阶段性文字回复」为界分段**：模型中途直接返回给用户的每条文字 response 是天然分隔点；两个分隔点之间的一段 think+bash 是一个 slide。不会两个 input prompt 之间挤成一整个 slide
  - 头部：`10 个工具调用 · 5 Think`（无 emoji、无冗余序号）+ 进行中 / 失败徽标，可点击收起/展开
  - 主体：`max-height: N 行`（默认 10）的**内部滚动区**
    - **think 与工具调用严格按真实输出顺序交错排列**（不做「think 全在上 / bash 全在下」的强行分区）
    - 每段 think 一行（Think + 单行摘要 + 展开箭头），默认折叠，点击展开完整推理（内部限高滚动）；展开文字与工具输出同字号（同一 mono 字体）
    - 每条工具调用一行（状态点 + 工具名 + 单行摘要），点击展开参数/输出（输出再限高一档，内部滚动）
  - 执行中自动跟随底部
- **原生 Think 行从消息流中隐藏**（该段已并入 slide，避免重复显示），与 slide 内展示共用同一份内容
- **阶段性文字回复与最终回复** → 完全原生展示，保持全文可见，**不套 slide 窗口**、不加任何按钮
- 用户消息始终是「整轮的分隔点」，保持原位

> 效果预览见 GitHub 仓库页面或自行安装体验（仓库不再内置运行截图，避免暴露会话内容）。

## 安装

```bash
dsh plugin --profile web add github:heiheiha798/dsh-plugin-response-window
```

或本地 link 方式（开发调试）：

```bash
git clone https://github.com/heiheiha798/dsh-plugin-response-window.git
cd dsh-plugin-response-window
dsh plugin --profile web add "link:$(pwd)"
```

装完重启 `dsh web`（或等 profile HMR）生效。

卸载：`dsh plugin --profile web remove dsh-plugin-response-window`

## 配置

`cordis.patch.yml` 里插入了默认配置，可改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `lines` | `10` | 窗口高度（行）。`0` = 不限高（等价于关闭窗口） |
| `collapsed` | `false` | 每轮 slide 是否默认收起成一行 bar。默认 `false`：始终展开、内容可见 |
| `showReadOnly` | `true` | 是否在 slide 里列出 read/grep/web_search 等只读调用（默认全列出，不藏） |
| `minCollapseRows` | `3` | 仅 `collapsed: true` 时生效：少于该数量的轮次不收起 |

### 设置页（Settings → General）

插件在 Web UI 的 **Settings → General** 里注册了一项 **「响应窗口大小（行数）」**：

- `−` / 数值输入 / `+`：调整 `lines`（0–200，`0` = 不限高，默认 10）
- **即时生效**：改动后已渲染的 slide 高度立刻变化（经宿主 settings namespace `dsh-plugin-response-window` 持久化）

## 实现说明（为什么安全）

- 工具调用 slide 通过 `conversation.chat.node`（`tool-call` key，`priority: -100`）的 **slot shadow** 在 React 层实现：每轮第一个 tool-call 节点渲染整个 slide，同轮其余 tool-call 节点渲染空，任何渲染异常自动 abdicate 回内置渲染。
- **绝不移走 React 拥有的 `[data-chat-anchor-key]` 行节点**。实测：把行移进自定义容器后，一旦 DSH 后续移除该行（会话切换/编辑/压缩），React 会调用 `parent.removeChild(row)` 抛 `NotFoundError`，整个会话树被卸载——因此本插件只用「slot shadow + 类/CSS」两种方式，对 React 行结构零改动。
- 原生 Think 行隐藏与 slide 内的 think 同步：只对「该段内有 slide」的原生 `data-variant="think"` 行加 `display:none`（DOM 类/CSS，无重挂、无删除），其余（无工具调用的纯 Think 段）保持原生显示。
- 插件只读 session 快照（`useSession`），不写快照、不调宿主 API。

## 开发 / 测试

纯 JS，无构建步骤：

```bash
npm run check   # node --check lib/index.js && node --check lib/client.js
```

E2E（需要已启动的 `dsh web` 与 python playwright）：

```bash
dsh --profile web --no-open --port 3639 &
python3 test/e2e.py --url http://127.0.0.1:3639 --session "架构重构不顺原因分析"
```

- 宿主半：`lib/index.js`（注册 settings namespace，依赖 `@deepseek-ai/schemastery`）
- 浏览器半：`lib/client.js`（`window.__ModuleLoader__.load`，依赖 web 运行时注入的 `react`、slots 与 settings scope）

## License

MIT

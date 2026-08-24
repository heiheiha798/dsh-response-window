# dsh-response-window

DeepSeek Harness (DSH) Web 插件：把「上一个用户 prompt → 下一个用户 prompt」之间的整段响应放进一个**有限高度的可滚动窗口**（默认 10 行），工具调用聚合为每轮一个 **slide**，中间过程**始终可见**（只是不撑爆页面）——Grok Build 风格。

> 与「全部折叠成 summary」类插件（如 `dsh-tool-summary`）不同：本插件**不隐藏**任何内容。工具调用一条条列在 slide 里，长回复文本限高后内部滚动，全部内容都能翻到。

## 效果

一个 prompt 之后有 100 次 tool call + 长回复时：

- **工具调用** → 压缩为 1 个 slide：
  - 头部：`🔧 响应 N · 100 个工具调用` + 进行中 / 失败徽标，可点击收起/展开
  - 主体：`max-height: N 行`（默认 10）的**内部滚动区**，每条调用一行（状态点 + 工具名 + 单行摘要），点击展开参数/输出（输出再限高一档，内部滚动）
  - 执行中自动跟随底部
- **回复文本** → 超过窗口的行数后自动限高 + 内部滚动 + 渐变遮罩 + 「展开全部/收起」按钮，原生 Markdown 渲染不变
- 用户消息始终是「slide 之间的分隔点」，保持原位

## 安装

```bash
dsh plugin --profile web add github:heiheiha798/dsh-response-window
```

或本地 link 方式（开发调试）：

```bash
git clone https://github.com/heiheiha798/dsh-response-window.git
cd dsh-response-window
dsh plugin --profile web add "link:$(pwd)"
```

装完重启 `dsh web`（或等 profile HMR）生效。

卸载：`dsh plugin --profile web remove dsh-response-window`

## 配置

`cordis.patch.yml` 里插入了默认配置，可改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `lines` | `10` | 窗口高度（行）。`0` = 不限高（等价于关闭窗口） |
| `collapsed` | `false` | 每轮 slide 是否默认收起成一行 bar。默认 `false`：始终展开、内容可见 |
| `showReadOnly` | `true` | 是否在 slide 里列出 read/grep/web_search 等只读调用（默认全列出，不藏） |
| `wrapAssistantText` | `true` | 是否给超长回复文本加限高滚动窗口 |
| `minCollapseRows` | `3` | 仅 `collapsed: true` 时生效：少于该数量的轮次不收起 |

## 实现说明（为什么安全）

- 工具调用 slide 通过 `conversation.chat.node`（`tool-call` key，`priority: -100`）的 **slot shadow** 在 React 层实现：每轮第一个 tool-call 节点渲染整个 slide，同轮其余 tool-call 节点渲染空，任何渲染异常自动 abdicate 回内置渲染。
- **绝不移走 React 拥有的 `[data-chat-anchor-key]` 行节点**。实测：把行移进自定义容器后，一旦 DSH 后续移除该行（会话切换/编辑/压缩），React 会调用 `parent.removeChild(row)` 抛 `NotFoundError`，整个会话树被卸载——因此本插件只用「slot shadow + 类/CSS」两种方式，对 React 行结构零改动。
- 长回复文本窗口是对原生 `_markdown` 元素加类 + CSS（同 `dsh-toolbox-web` 长消息折叠的手法），无 DOM 重挂、无删除。
- 插件只读 session 快照（`useSession`），不写快照、不调宿主 API。

## 开发

纯 JS，无构建步骤：

```bash
npm run check   # node --check lib/index.js && node --check lib/client.js
```

- 宿主半：`lib/index.js`（无依赖）
- 浏览器半：`lib/client.js`（`window.__ModuleLoader__.load`，依赖 web 运行时注入的 `react` 与 slots）

## License

MIT

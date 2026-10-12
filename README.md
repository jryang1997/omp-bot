# omp-bot

在 [omp](https://omp.sh)（oh-my-pi）上跑一支**常驻 AI bot 团队**：多 bot 花名册、bot 之间互发消息、回合制群聊。

后端零 npm 依赖，纯 Node ESM。每个 Bot scope 使用一个 `omp --mode rpc` 子进程。Node 编排层负责团队、运行台账、原生审批接入和群聊回合，模型执行仍由 OMP 负责。

编排协议和 GUI 都来自 [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot)。GUI 复制了它的样式和头像源码，并把侧栏、消息、输入框与详情面板适配到本项目的 HTTP API 和 SSE。后端仍使用 omp 原生的会话续接与压缩。复制范围、固定版本和许可见 [前端来源说明](web/vendor/README.md)。

## 它和 DS-Bot 的差别

| 维度 | DS-Bot（DSH 插件） | omp-bot（本项目） |
|---|---|---|
| 形态 | 宿主进程内的插件，自带浏览器 UI | 独立 Node 编排器 + 每 bot 一个 `omp --mode rpc` 子进程 |
| bot 抽象 | 一个 DSH Session | 一个 omp RPC 子进程绑定一个会话上下文 |
| 群聊 relay | 隐藏 relay session + 劫持 `llm/stream` 合成 tool-call | 编排器本身就是 relay，纯 Node 回合引擎，无 stream 劫持 |
| 记忆 | 自研 Markdown 记忆 + 后台 review | **关闭** omp 记忆后端做隔离；常驻记忆靠会话续接（`--continue`），每 bot 每 scope 独立 |
| 长上下文 | 自研 checkpoint/handoff/part 切换 | 复用 omp 原生 auto-compaction |
| 隔离 | 共享 DSH home | 每 bot 独立 cwd + session-dir + `--config` overlay 屏蔽用户全局 AGENTS.md、关闭共享记忆后端与 autolearn |

## 快速开始

### Windows 桌面应用

双击 `release/omp-bot-0.1.0-portable.exe` 可直接运行。`release/omp-bot-0.1.0-setup.exe` 是安装版，会创建桌面和开始菜单快捷方式。

应用包含 Electron、网页界面、Node 后端和 OMP 可执行文件，不需要另外安装 Node 或 OMP。模型配置与登录凭据仍使用本机的 OMP 设置，安装包不包含密钥、用户配置或聊天记录。

**关闭窗口只是隐藏**：后台任务、待审批和计划继续跑，托盘图标和「窗口」菜单可以随时把主窗口拉回来。真正退出用托盘菜单的「退出 omp-bot」或 `Ctrl+Q`：会先取消正在进行的运行（等到确实停下），再关掉 OMP 子进程并释放数据锁。

**系统通知**：运行完成、需要你输入或审批、运行失败时弹原生通知，点通知回到窗口。窗口在前台时不重复打扰。弹的是真实事件（run 状态与原生 UI 请求），不是假进度。

**菜单里的原生能力**：「帮助 → 模型登录」会在终端里跑 `omp login`，「原生帮助」跑 `omp --help`，「检查版本」跑 `omp --version`，「诊断信息」显示 Electron/Node 版本、node:sqlite 可用性、OMP 路径与版本、数据目录与锁状态。凭据始终由 OMP 自己管理，本应用不代填、不打印任何 token 或密钥。

数据目录是 `~/.ompbot`（`OMPBOT_HOME` 可改）。打开前先关掉使用同一数据目录的 `serve` 或 CLI，避免两个程序同时写数据：后者启动时会拒绝并提示。

应用图标为原创黑白圆角机器人，参考 Grok Bot 的视觉方向，源文件是 `web/assets/app-icon.svg`。

开发时运行 `npm install` 后执行 `npm run desktop`。运行 `npm run package:win` 生成 Windows 免安装版和安装版；构建时从本机安装路径复制 `omp.exe`，并随附其 MIT 许可，同时写入 `runtime/VERSION` 与 `runtime/PROVENANCE.json`（版本、来源路径、sha256）。本机 OMP 低于要求的 18.10 时构建直接失败，不会把不兼容的引擎打进安装包。

安装包尚未做 Authenticode 数字签名，也没有发布源：本项目不做自动更新，检查到新版本只能重新 `npm run package:win` 并安装。Windows 可能显示未知发布者提示。

### 网页与 CLI

前提：本机装好 `omp`（`omp --version` 能跑，需要 **OMP ≥ 18.10**，`omp update` 可升级），且至少配好一个模型（`omp models`）。**Node ≥ 24**：工作台台账用 Node 内置 `node:sqlite`，旧版本没有这个模块。CLI 和桌面版启动前都会检查这两条，不满足会直接报错而不是带着坏环境跑。

```sh
# GUI（网页控制台，推荐）：一条命令启动，自动打开浏览器
node ompbot.mjs serve
```

打开 `http://127.0.0.1:3099`（可用 `--port` 换端口，`--no-open` 不自动开浏览器）。GUI 里可以：

- 团队侧栏集中显示主 Bot、群聊和其他 Bot。顶部搜索名称或角色，点 ＋ 创建 Bot 或群聊，创建后自动打开会话。
- 点会话标题或右上角设置按钮打开详情面板。可以修改名字、角色、模型、思考档、专属指令和主 Bot 标记，或编辑群成员、管理员和发言模式。人格与模型改动在下一条消息生效。
- 私聊支持 Markdown、代码块、表格、消息复制和历史重载。Enter 发送，Shift+Enter 换行。切换会话后，正在生成的回复仍回到原会话。
- 群聊的 Bot 发言经 SSE 实时更新，也会同步未打开的群。单个 Bot 回合失败时显示错误；历史可以重新载入。
- 侧栏底部提供用量统计和明暗主题切换。连接状态旁的绿点表示 SSE 已连通。窄屏用左上角按钮打开侧栏，详情面板全屏显示。
- 工作台集中列出进行中、待处理、完成与失败的运行。聊天显示原生文本、思考、工具和子任务进度，可以停止或补充指令；新会话与清空显示分别操作。
- 添加附件、粘贴或拖入图片和文本资料。运行详情提供成果预览与下载，领取的是登记时的不可变版本。HTML 和 SVG 预览使用隔离策略。
- Bot 设置提供执行权限、累计 token 额度、原生 MCP、技能过滤、计划和能力状态。记忆缺少隔离认证前置时拒绝开启；模型登录沿用 OMP。
- 工作台的「飞书渠道」可以填写 App ID、App Secret、Verification Token、Encrypt Key、固定回调端口和身份映射。秘密输入框不回显，留空保留已有值；保存配置不会自动启用渠道。凭据保存在本机通道配置中，也支持既有环境变量引用。

服务只听 `127.0.0.1`，不对外网暴露。

### 一键 demo（CLI）

```sh
node ompbot.mjs demo
```

demo 会创建 Ada（协调者）和 Bo（保管秘密数字 4271），然后让 Ada 用 `message_bot` 去问 Bo，把数字带回来。

### 手动搭一支团队

```sh
# 1) 建 bot
node ompbot.mjs bots add Chief --role 群管理员 --main
node ompbot.mjs bots add Calc --role 计算专家
node ompbot.mjs bots list

# 2) 建群（admin 模式：普通消息只给 admin，由它 @ 人）
node ompbot.mjs room create 工作组 --members Chief,Calc --admin Chief --mode admin
node ompbot.mjs room list

# 3) 私聊某个 bot
node ompbot.mjs chat Calc "你的秘密数字是多少？"

# 4) 在群里发言，触发 relay 回合
node ompbot.mjs say 工作组 "帮我算一下这个数字"

# 5) 连续对话（REPL）
node ompbot.mjs interactive Calc          # 私聊
node ompbot.mjs interactive room:工作组    # 群聊
```

数据落在 `~/.ompbot`（或 `$OMPBOT_HOME` / `--home`）：`state.json` 是花名册与群，`workbench.sqlite` 是 Run 台账（事件游标、附件、成果、计划、审批、每 Run 用量），`bots/<id>/<scope>/` 下是每个 bot 每个会话上下文的 omp session、人格文件和隔离 overlay。老的 `state.json` 不会被删：首次打开时台账在旁边建库，Bot 与群的 id 保持不变，历史 session 不动。

## 命令

| 命令 | 作用 |
|---|---|
| `serve [--port 3099] [--no-open]` | 启动 GUI（网页控制台），默认自动开浏览器 |
| `demo` | 建两个 bot 跑一次私聊委派，打印用量 |
| `bots add <name> [--role R] [--model M] [--instructions I] [--main]` | 新增 bot |
| `bots list` / `bots rm <name\|id>` | 列出 / 删除 |
| `room create <name> --members A,B [--admin A] [--mode admin\|everyone]` | 建群 |
| `room list` | 列出所有群 |
| `chat <bot> "<message>"` | 私聊一个 bot（跨调用续会话） |
| `say <room> "<message>"` | 群里发言，跑 relay |
| `usage` | 当前进程内 runtime 的用量汇总（跨重启的累计看 `runs`） |
| `interactive <bot\|room:ROOM>` | REPL 连续对话（`:usage`、`:runs`、`:quit`） |
| `runs list [--bot B] [--room R] [--state S] [--limit N] [--json]` | 列出运行（台账投影） |
| `runs get <runId> [--json]` | 单次运行的完整记录 |
| `runs stop <runId>` | 取消运行，等它确实停（级联子任务）；不属于本进程时如实拒绝 |
| `runs steer <runId> "<text>" [--behavior steer\|follow_up] [--images a.png,b.png]` | 运行中途补话，不新开并行运行 |
| `approvals list [--all] [--json]` | 待处理的原生审批（`--all` 看全部状态） |
| `approvals respond <id> --value V \| --confirm \| --deny \| --cancel \| --answers '<json>'` | 回答原生请求，必须显式给出回答 |
| `session new <bot> [--scope private\|room:ID]` | 开新原生会话 |
| `routines list \| add \| get \| pause \| resume \| rm \| run` | 计划任务（`add` 默认暂停，要跑加 `--start`） |
| `settings show <bot> [--json]` / `settings set <bot> …` | 权限档、审批档、预算（对象，见下）、记忆、技能过滤、工作区 |
| `template export <file>` / `template import <file> [--dry-run]` | 团队模板导入导出（见下） |
| `backup [--out DIR]` | 停服务落盘后复制整个数据目录 |
| `version [--json]` | 应用、Node、OMP 版本与本机兼容检查 |

审批：原生 `approvalMode` 为 `always-ask`/`write` 时，工具调用会请求真实的人确认。`interactive` 会在终端里问你；一次性命令（`chat`/`say`/`demo`）默认**失败关闭**——不替你猜答案，直接停止这次运行。要显式放行用 `--approve <选项>`（选择）或 `--approve yes|no`（确认），提问用 `--answers '["回答"]'`（非空 JSON 数组）。凭据类请求（secret）永远不由 CLI 代填：请用 GUI 或在终端跑 `omp login`。

`settings set` 里 `--execution-mode full` 需要再加 `--confirm-execution-mode`，`--approval-mode yolo` 需要 `--confirm-approval-mode`（与 HTTP API 的 `confirmExecutionMode`/`confirmApprovalMode` 同一限制）。`full` 是明确的安全降级：可访问整个本机账户，不是沙箱；本机没有经过验证的 Windows 沙箱，所以 `sandbox` 模式不提供。

预算按核心的唯一契约存对象：`{maxTokens, maxCostUsd, maxTimeMs, maxConcurrency}`，每一项都是非负有限数字，`null` 表示不设限。`--budget 50000` 就是 token 额度（写成 `{maxTokens:50000}`），`--budget none` 清除全部额度；成本/时间/并发用 `--max-cost-usd`、`--max-time-ms`、`--max-concurrency`，这些限制项是**合并写入**（只给一项不会丢掉其它额度）。标量、负数或未知键会被核心明确拒绝，不会被静默当成「无限制」。

模板只带身份与任务描述：bot 的名字/角色/指令/模型/思考档、群与成员、计划定义。**不含**密钥、聊天记录、审批、授权档（`executionMode`/`approvalMode`）、预算、技能过滤、运行状态与私有记忆内容；导入的计划一律暂停，且不会把缺过的执行补跑。导入是加性的：重名的 bot/群跳过，不会覆盖既有数据。

`backup` 会先真正停下服务（SQLite 关闭后才安全复制）再拷贝数据目录，恢复就是复制回一个新的 `--home`。

环境变量：`OMPBOT_HOME`（数据目录）、`OMPBOT_MODEL`（默认模型，空则用 omp 默认）、`OMPBOT_THINKING`（默认思考档）、`OMP_BIN`（指定原生 omp 路径）、`OMPBOT_DEBUG=1`（打印编排事件与 RPC 帧）、`OMPBOT_URL` + `OMPBOT_TOKEN`（把控制命令发给正在运行的服务，见下）。

### CLI 与正在运行的 GUI/serve 的关系

同一个数据目录只能有一个写者。`serve` 或桌面版正在跑时：

- `runs list|get|stop|steer`、`approvals list|respond`、`session new`、`routines …`、`settings …`、`template …` 会被转发给那个进程的本机 HTTP API（它才是那些运行的持有者）；`chat`/`say`/`demo`/`interactive` 需要独占一个引擎，仍在本进程运行。
- 地址与凭证来自该进程写在数据目录里的 `runtime.json`（`{pid,url,token,lockStartedAt,…}`，0600；只在「进程还活着、且它记录的写锁 pid 与 nonce 与当前 `state.lock` 一致」时才被采用，陈旧文件直接忽略）；也可以显式指定：`--url http://127.0.0.1:3099 --token <token>` 或 `OMPBOT_URL`/`OMPBOT_TOKEN`。**本 CLI 从不打印 token，也不把它写进日志。**
- 拿不到活跃进程时，停止/审批这类必须由持有者执行的操作会**如实拒绝**（`runs stop` 打印真实状态或报错退出），不会假装停过；读取类命令（`runs list`、`settings show`、`template export`）仍然可用。`backup` 在有别的进程写同一个库时会拒绝，避免给出不一致的副本。

## 架构

```
   GUI(浏览器) ──HTTP/SSE──┐
   CLI / IM 桥 ────────────┤
                           ▼
                 ┌─────────────────────────────┐
                 │        Orchestrator         │  ← state.json（花名册/群/投递/聊天日志）
                 │  花名册 · runtime 池 · 投递   │     + workbench.sqlite（Run/事件/产品记录）
                 │  Run 生命周期 · 原生审批桥    │     + 单写者锁
                 └──────────────┬──────────────┘
                                │ 每个 (bot, scope) 一个 BotRuntime
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
       omp --mode rpc     omp --mode rpc     omp --mode rpc
       (Ada · private)    (Bo · private)     (Calc · room:X)
              ▲                 ▲                 ▲
              └── host tool: message_bot / list_bots ──┘
                  （bot 调用 → 编排器投递 → 目标回合 → 回复作 tool result）
```

- **`src/rpc-client.mjs`** — 驱动一个 `omp --mode rpc` 子进程的 JSONL 客户端：帧编解码、协议 v2 协商与 chunk 重组、命令/响应按 id 关联、事件订阅、host tool 回调服务。
- **`src/server.mjs`** — GUI 后端：node:http 常驻服务（127.0.0.1），静态文件 + JSON API + SSE 事件流。
- **`web/`** — GUI 前端：零依赖单页（index.html + app.js + style.css），侧边栏/聊天窗/设置抽屉/用量表。
- **`src/bot.mjs`** — `BotRuntime`：一个 omp RPC 子进程绑定一个会话上下文（`private` 或 `room:<id>`）。注入人格（`--append-system-prompt`）与隔离 overlay（`--config`），注册团队工具，维护 `busy`/`deliveryDepth` 状态机。
- **`src/persona.mjs`** — bot 人格文本生成 + 隔离 overlay（关掉 context-file provider 防止用户全局 `~/.omp/agent/AGENTS.md` 漏进 bot；关掉 `memory.backend`/`autolearn` 防止 bot recall/retain 用户的私有记忆库）。
- **`src/orchestrator.mjs`** — 唯一整合点：花名册 CRUD、runtime 池（按执行环境与权限档做租用兼容检查）、Run 生命周期（`startRun`/`cancelRun`/`steerRun`/`answerUi`）、`message_bot`/`list_bots` 团队工具、bot→bot 投递协议、群聊入口。公开的旧方法（`chatWithBot`/`postToRoom`）内部走同一套 Run，不再有第二条执行路径。
- **`src/ledger.mjs`** — `node:sqlite` 台账：Run 投影、全局事件游标、附件/成果/计划/审批/设置等产品记录、每 Run 用量。**不是第二份模型历史**：真实的模型回合、工具调用、压缩与分支都在 OMP 自己的 session JSONL 里，台账只做有限重放与展示投影。
- **`src/features.mjs`（`src/features/**`）** — 工作台产品面：资料与成果、计划调度、能力/MCP/技能/记忆、浏览器接管等端点，通过 `WorkbenchFeatures.handleRequest` 交给 server 调用一次。
- **`src/http-auth.mjs`** — 本机 HTTP 的边界检查：Host/Origin 严格同源回环、进程 token 或 HttpOnly `SameSite=Strict` 会话 cookie、Content-Type 与路径校验。
- **`src/relay.mjs`** — 群聊回合引擎：开场说话者选择（admin/everyone 模式）、串行队列、@点名插队、`[PASS]` 收敛、回合上限。
- **`src/domain.mjs`** — 核心数据形状（Bot/Room/Message/Exchange）与归一化：@mention 解析（最长名优先）、room.log 裁剪、群聊 prompt 构建。
- **`src/store.mjs`** — 团队状态持久层：原子写 + pid 单写者锁 + 版本迁移。
- **`src/constants.mjs`** — 领域常量（hop 上限、超时、mention 限额、回合上限等，多数借自 DS-Bot）。
- **`src/usage.mjs`** — 跨 bot 用量汇总（按实测 `get_session_stats` 字段归一化）。

## bot→bot 消息怎么防死锁

`message_bot` 是同步 host tool：A 调用它 → 编排器跑 B 的回合 → B 的回复作为 tool result 返回给 A。

- **hop 上限**：每跳 `deliveryDepth + 1`，超过 `MAX_HOPS`(6) 拒绝，防止 A→B→A→… 无限链。
- **busy 拒绝**：目标 runtime 正在跑回合时直接返回错误，不阻塞等待。A 调 B 期间 A 自己 `busy=true`（它的回合还没结束），所以 B 若反向调 A 会被立即拒绝，不会死锁。
- **失败回执**：目标启动失败 / 超时 / 忙，都作为 `isError` 的 tool result 返回，发送方不会永久挂起。

## 测试

```sh
npm test               # 下面全部串起来跑一遍
node test/unit.mjs     # 纯函数单测（无模型）：normalizeStats/parseMentions/isPass/room.log 裁剪
node test/shutdown.mjs # 显式退出：进行中的 Run 进终态、锁释放并能被另一个进程重新取得
node test/ledger.mjs   # 台账与单写者锁：真 SQLite、重启恢复、只读、陈旧锁接管、迁移前备份
node test/runs.mjs     # 运行契约：状态迁移、审批、取消级联、准入拒绝（注入 runtime 夹具，零模型）
node test/features.mjs # 资料/成果/计划/原生能力面/文件检查点（真 Ledger + 真文件系统）
node test/http-boundaries.mjs # HTTP 边界：凭证、跨源/Host、Content-Type、超大 body、cookie bootstrap、SSE 重放
node test/rpc-client.mjs      # RPC 传输层：竞态、被拒 admission、取消、坏帧恢复（内联协议夹具，零模型）
node test/channels.mjs        # 设备配对与 IM 适配器：真实 Ledger + 本地假端点，不发真实消息
node smoke-gui.mjs     # HTTP API 层：静态/CRUD/校验/SSE/目录穿越
node gate.mjs          # 阻塞门：RPC 握手、人格注入、host tool 回调、最终文本抓取
node smoke-b2b.mjs     # bot→bot 私聊委派闭环
node smoke-group.mjs   # 群聊 relay：everyone 收敛 + admin @路由 + 记忆隔离断言
node smoke-persist.mjs # 跨进程会话续接（关闭重开 bot 仍记得之前的话）
node probe-isolation.mjs # 判决实验：证明 overlay 关掉了记忆后端与 autolearn（对比 systemPrompt）
```

`test/` 下的用例零模型调用（真 SQLite、真 HTTP、夹具子进程）；`smoke-*` 与 `gate` 是真实模型调用，抓真实 transcript 作为断言证据，不用 mock。`probe-isolation` 不烧模型（只读 `get_state`）。`OMPBOT_MODEL` 可指定便宜模型，`OMPBOT_THINKING` 设默认思考档，`OMPBOT_DEBUG=1` 打印每一帧。

> `usage` 归一化依据的 `get_session_stats` 字段是探测校准的。omp 升级后若字段变动，起一个 bot、`getState()` dump 一次 `get_session_stats` 即可重校 `src/usage.mjs`。

## 已知限制

- **模型指令遵循**：admin 模式的 @路由依赖 admin bot 听话地 `@` 出成员名。用能力强的模型（Claude/GPT-5.x）稳，弱模型偶尔不 @。`everyone` 模式不依赖 @，是确定性的。
- **记忆隔离**：默认关闭 OMP 共享记忆后端与 autolearn，使用每 Bot、每 scope 独立的会话续接。原生 local 记忆需要私有 agentDir 和认证代理或专用 profile，并核对原生解析目录。前置缺失时明确拒绝开启，不修改用户全局认证或共享库。只清理本 Bot 的私有记忆文件，不调用会删除共享表的原生全局 clear。
- **单写者**：同一 `OMPBOT_HOME` 同时只能一个 orchestrator 写；第二个拿不到锁时只读，桌面版会直接提示而不是带着只读状态跑。CLI 与桌面版共用同一份 `state.json` + `workbench.sqlite`，不要用两个程序同时写。
- **权限与沙箱如实披露**：`supervised` 是本机原生审批模式，不是 OS 沙箱；`full` 是明确的安全降级，可访问整个本机账户。本机没有经过验证的 Windows 沙箱（未验证 Docker/Windows Sandbox 可用性，也没验证 WSL 是否构成隔离），因此不提供 `sandbox` 模式，不挂「安全模式」标签继续放开 shell。
- **Windows**：已在本机 Windows（Node v24 / Electron 44）实测；stdio 管道与子进程生命周期正常。
- **飞书与设备**：已接入本地飞书回调适配器、身份映射、原生审批回答、去重和投递记录。真实飞书运行需要应用凭据与可达 HTTPS 回调，当前未对真实账号验收。设备配对支持 Bot 范围权限和撤销，主服务仍默认仅监听回环地址；跨手机与远端需要用户自备并授权网络入口。
- **HTTP 只服务本机**：监听 127.0.0.1，`/api` 要求同源有效会话 cookie 或 Bearer token，并校验 Host/Origin/Content-Type。别把端口转发到公网，也别把带 token 的启动 URL 记进日志或分享出去。
- **浏览器接管**：本地接管入口暂停 Bot，归还后解除暂停；状态取自原生能力检查。未配浏览器或协作环境时不会生成可用性承诺，跨设备可视接管尚未验收。
- **资源基线**：本机 1、4、12 个空闲 OMP 进程的工作集合计约 283、1193、3467 MiB。不是峰值、吞吐或优化前后对比。三场景 30 次资料到成果验收全部通过，完整口径与交付边界见 [实施验收报告](docs/research/2026-10-12-implementation-verification.md)。

## 致谢

- [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot)：编排协议的设计来源，以及本项目实际移植的 GUI 样式、头像和组件结构。复制源码保留 Apache-2.0 许可与署名。
- [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：bot=隔离 profile、每成员每群一会话、带署名的 bot 间消息格式。
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮次与 @mention 中继。
- [oh-my-pi / omp](https://github.com/can1357/oh-my-pi)：宿主 harness，提供 RPC 模式、host tool 回调、会话续接与原生压缩。

## License

本项目原创代码采用 MIT。移植的 DeepSeek-Bot 前端代码保留 Apache-2.0 许可；Markdown 渲染使用 marked，HTML 清理使用 DOMPurify。各组件的许可与固定版本见 [前端来源说明](web/vendor/README.md)。

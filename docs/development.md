# 开发文档

[返回首页](../README.md) · [使用指南](guide.md)

后端是 Node ESM。每个 bot 的每个会话上下文（私聊或某个群）跑一个 `omp --mode rpc` 子进程。Node 编排层负责团队、运行台账、原生审批接入和群聊回合，模型执行仍交给 OMP。

编排协议来自 [DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot)。GUI 沿用其基础组件并重构布局、视觉和设置层次，适配本项目的 HTTP API 和 SSE。后端使用 omp 原生的会话续接与压缩。复制范围、固定版本和许可见 [前端来源说明](../web/vendor/README.md)。

- [它和 DS-Bot 的差别](#它和-ds-bot-的差别)
- [从源码运行](#从源码运行)
- [命令行](#命令行)
- [数据目录](#数据目录)
- [架构](#架构)
- [bot→bot 消息怎么防死锁](#botbot-消息怎么防死锁)
- [测试](#测试)
- [共享电脑从源码运行](#共享电脑从源码运行)
- [打包与发布](#打包与发布)
- [图标与头像](#图标与头像)

## 它和 DS-Bot 的差别

| 维度 | DS-Bot（DSH 插件） | omp-bot（本项目） |
|---|---|---|
| 形态 | 宿主进程内的插件，自带浏览器 UI | 独立 Node 编排器 + 每 bot 一个 `omp --mode rpc` 子进程 |
| bot 抽象 | 一个 DSH Session | 一个 omp RPC 子进程绑定一个会话上下文 |
| 群聊 relay | 隐藏 relay session + 劫持 `llm/stream` 合成 tool-call | 编排器本身就是 relay，纯 Node 回合引擎，无 stream 劫持 |
| 记忆 | 自研 Markdown 记忆 + 后台 review | 默认关闭。开启后用 omp 自带的 mnemopi，每个 bot 一个库，私聊群聊通用；对话上下文靠会话续接（`--continue`），每 bot 每 scope 独立 |
| 长上下文 | 自研 checkpoint/handoff/part 切换 | 复用 omp 原生 auto-compaction |
| 隔离 | 共享 DSH home | 每 bot 的 omp 进程 cwd 是 `team/bots/<id>`，每个 scope 独立会话目录；`--config` overlay 屏蔽用户级 AGENTS.md、CLAUDE.md、GEMINI.md，关闭 autolearn |

## 从源码运行

前提：本机装好 `omp`（`omp --version` 能跑，需要 **OMP ≥ 18.10**，`omp update` 可升级），且至少配好一个模型（`omp models`）。**Node ≥ 24**：工作台台账用 Node 内置 `node:sqlite`，旧版本没有这个模块。CLI 和桌面版启动前都会检查这两条，不满足会直接报错而不是带着坏环境跑。

```sh
# GUI（网页控制台，推荐）：一条命令启动，自动打开浏览器
node ompbot.mjs serve
```

然后打开 `http://127.0.0.1:3099`（`--port` 换端口，`--no-open` 不自动开浏览器）。服务只听 `127.0.0.1`。

## 命令行

### 一键 demo

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

### 命令表

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

## 数据目录

数据落在 `~/.ompbot`（或 `$OMPBOT_HOME` / `--home`）：

- `state.json`：花名册与群。
- `workbench.sqlite`：Run 台账（事件游标、附件、成果、计划、审批、每 Run 用量）。
- `team/`：bot 的身份、技能、文件和 omp 会话，见 [使用指南的团队目录](guide.md#团队目录)。
- `bots/<id>/<scope>/`：运行时生成的团队工具说明和隔离 overlay，不进 team。
- `computers/`：共享电脑的配置，见 [使用指南的共享电脑](guide.md#共享电脑)。
- `runtime.json`：正在运行的服务地址和 token（0600）。

老的 `state.json` 不会被删：首次打开时台账在旁边建库，Bot 与群的 id 保持不变。

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
- `web/` 提供共享网页界面。`app.js` 负责侧栏、聊天、设置与交互；`workbench-runs.js` 持有事件流、快照后的重放协调、Run 投影和原生增量渲染。草稿与附件归属分别由原有会话交互和附件模块管理。
- **`src/bot.mjs`** — `BotRuntime`：一个 omp RPC 子进程绑定一个会话上下文（`private` 或 `room:<id>`），cwd 是 `team/bots/<id>`，会话在 `sessions/<scope>/`。注入团队工具说明（`--append-system-prompt`）与 overlay（`--config`），注册团队工具和客机工具，维护 `busy`/`deliveryDepth` 状态机。
- **`src/team.mjs`** — 团队目录：建树、写模板、git 提交、身份块往返、技能库和私有技能、从 0.1.x 迁移。别的模块的 team 路径都从这里拿。
- **`src/persona.mjs`** — 团队工具说明 + overlay：关掉用户级 AGENTS.md、CLAUDE.md、GEMINI.md，项目级打开；技能库目录；客机工具 allow、装系统包 prompt；记忆默认关，开启时用 mnemopi（`scoping: global`、`bank: bot-<id>`、库在 `team/.memory/`）。
- **`src/computer-seats.mjs`** — 座席层：对外接口和电脑后端一样，电脑 id 指座席。经管理通道跑 `guest/omp-seat` 建座席、挂文件、装包；登录屏和发布登录；旧电脑搬家。`src/computer-backend.mjs` 是底下的 QEMU 后端，`src/file-share.mjs` 是挂载用的 SFTP 服务。
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

`delegate_bot` 是异步派活：A 调用它立刻返回，B 在后台做。每件活在台账里有一条派活记录（`delegations`），执行和交回分两本账：

- **交接简报和验收标准**：`message` 写成对方拿来就能干的简报（任务、背景、相关文件、现状、试过什么、决定、约束），对方看不到派活方的对话。`acceptance` 是可选的验收标准清单（最多 10 条，每条 300 字以内），开跑时附在简报后面，交回时原样带回给派活方逐条核对。结构学自 Paseo 的 handoff 技能。
- **忙了排队**：B 正忙（或被人工接管暂停）就排队，空了按派活顺序开跑，同一个 B 后来的不插队。预算、并发上限这类当场拒绝照旧报错给 A。
- **做完交回**：B 的 Run 一落定，结果连同子 Run id 作为一条新消息交给 A（在 A 的私聊里起一个新 Run，发送者是 B），由 A 验收。A 正忙就等它空了再送。交回状态 pending → delivered 或 dropped，只送 pending 的，重复触发不会重复唤醒。
- **重启**：排队的继续排；跑到一半的子 Run 被标 interrupted，按"中断"交回 A，不自动重跑；做完没送到的补送。正常关停的级联取消不算用户取消。
- **不越界**：开跑前重查准入（同工作区、不扩权、父回合没被用户取消）；交回前重查 A 和 B 还在不在同一工作区，不在就 dropped，结果只留在工作台。
- **工作台**：任务页的"助手之间派的活"列出每件活的状态、交回与否和原因（`GET /api/delegations`，只给主人）。
- **整棵派工树一份预算**：预算挂在用户发起的那个 Run 上（它的有效额度）。子任务、孙任务和交回的唤醒都从这一份里扣，不各拿一份；根自己花的也算。干活的成员一共只能用到八成（余量线），剩下两成留给交回和汇总。整棵树用到余量线时整棵停：在飞的子任务按预算取消，排队的不开跑，都照常交回，根和交回的唤醒用余量收尾。整棵超过总额时根和唤醒那一回合按预算耗尽收场。用量在每个回合结束时核对，所以会有一个回合的超出。

## 测试

```sh
npm test               # 下面全部串起来跑一遍
node test/unit.mjs     # 纯函数单测（无模型）：normalizeStats/parseMentions/isPass/room.log 裁剪
node test/workbench-runs.mjs # 网页投影：快照与事件交错、重连补齐、群聊去重及同步失败恢复
node test/attachment-drafts.mjs # 附件草稿：助手归属、在途上传换助手、成功提交只清理对应附件
node test/shutdown.mjs # 显式退出：进行中的 Run 进终态、锁释放并能被另一个进程重新取得
node test/ledger.mjs   # 台账与单写者锁：真 SQLite、重启恢复、只读、陈旧锁接管、迁移前备份
node test/runs.mjs     # 运行契约：状态迁移、审批、取消级联、准入拒绝（注入 runtime 夹具，零模型）
node test/features.mjs # 资料/成果/计划/原生能力面/文件检查点（真 Ledger + 真文件系统）
node test/http-boundaries.mjs # HTTP 边界：凭证、跨源/Host、Content-Type、超大 body、cookie bootstrap、SSE 重放
node test/computers.mjs # 电脑控制：旧代拒绝、接管竞态、输入 drain、未知副作用与成果临时目录
node test/seats.mjs     # 座席层：规格、建座席、最后一个停掉关机、补装客机脚本、装包、挂载参数、登录屏、旧电脑搬家（替身虚拟机）
node test/file-share.mjs # SFTP 服务：分根、钥匙、越界和外链拒绝、改名覆盖、并发追加、请求顺序、OpenSSH sftp
node test/team.mjs      # 团队目录：模板、身份块、git、迁移只复制、技能库和白名单
node test/delegation.mjs      # 派活：忙时排队、做完交回、重启恢复、撤权不越界（注入 runtime 夹具，零模型）
node test/team-memory.mjs     # 团队事实：提议要确认、替换撞车被拒、纠正过的不写回、只有用户和主助手能接受
node test/rpc-client.mjs      # RPC 传输层：竞态、被拒 admission、取消、坏帧恢复（内联协议夹具，零模型）
node test/channels.mjs        # 设备配对与 IM 适配器：真实 Ledger + 本地假端点，不发真实消息
node smoke-gui.mjs     # HTTP API 层：静态/CRUD/校验/SSE/目录穿越
node gate.mjs          # 阻塞门：RPC 握手、人格注入、host tool 回调、最终文本抓取
node smoke-b2b.mjs     # bot→bot 私聊委派闭环
node smoke-group.mjs   # 群聊 relay：everyone 收敛 + admin @路由 + 记忆隔离断言
node smoke-persist.mjs # 跨进程会话续接（关闭重开 bot 仍记得之前的话）
node test/real-omp.mjs   # 真 omp 端到端：脚本假模型零 token，验审批卡、目录外写入、密钥硬拦（含子任务）、相对路径落到工作区、卡住检测、计划、派活分档、记忆、续跑（没装 omp 就跳过；REAL_SLOW=1 加测计划检查）
REAL_MODEL=1 node test/real-model.mjs   # 真 omp + 免费真模型（OpenCode Go 的 *-free，key 放 ~/.secrets/opencode.key）：本地代理只放行免费模型，付费模型一律 403
node probe-isolation.mjs # 判决实验：证明 overlay 关掉了记忆后端与 autolearn（对比 systemPrompt）
```

`test/` 下的用例零模型调用（真 SQLite、真 HTTP、夹具子进程）；`smoke-*` 与 `gate` 是真实模型调用，抓真实 transcript 作为断言证据，不用 mock。`probe-isolation` 不烧模型（只读 `get_state`）。`OMPBOT_MODEL` 可指定便宜模型，`OMPBOT_THINKING` 设默认思考档，`OMPBOT_DEBUG=1` 打印每一帧。

前端变更还需在实际 Electron 或浏览器中检查：创建助手，添加附件后换助手，模拟提交失败并继续编辑草稿，反复开关设置与手机配对面板，核对任务终态；检查窄屏、长名称和深色主题。电脑变更需运行真实 VM 验证停启与文件保留，构建变更需从产出的 ZIP 解压启动，不能只凭测试通过宣布可用。

> `usage` 归一化依据的 `get_session_stats` 字段是探测校准的。omp 升级后若字段变动，起一个 bot、`getState()` dump 一次 `get_session_stats` 即可重校 `src/usage.mjs`。

## 共享电脑从源码运行

源码运行时先准备资源。QEMU 官方安装包的解包需要 7-Zip；运行电脑需要可用的 Windows Hypervisor Platform。应用不会自动安装系统功能或重启 Windows。

```sh
npm run setup:computers
npm run serve
```

已有核验过的资源时可复用，资源包括 `cua.exe`、`qemu/` 与官方 qcow2 镜像。脚本校验摘要，不复制模型凭据、会话或客机 token。

```sh
npm run setup:computers -- --runtime-source "资源目录" --image-source "官方镜像文件"
```

### 实机验证

沙盒里座席、文件挂载、登录屏和旧电脑搬家都用真实的 Xvfb、spacesd、sshfs、Chromium 和仓库里的客机脚本跑过（证据在 `.scratch/team-rebuild/proof/`），但共享虚拟机换成了沙盒本身。下面这些只能在 Windows 加 WHPX 的机器上验：

1. `npm run setup:computers`，然后 `npm run smoke:computers -- --model <支持图片的模型>`。看两个 bot 的座席同时起来，各自截图、点击、输入，互相读不到主目录，共享电脑里的命令不弹审批，工具清单里有装系统包的工具。再让一个 bot 装一个系统包，确认会问你。
2. 文件：在 Windows 的 `team/workspace` 放一个文件，客机 `/workspace` 马上看到；bot 在 `~/work` 写的文件，本机 `team/bots/<id>/work` 马上看到。这一步验证 QEMU 用户网络经 10.0.2.2 连回宿主、Windows 上的 SFTP 服务（路径分隔符、权限位、符号链接）和旧镜像补装 sshfs。
3. 登录：点「登录网站」，在登录屏登录一个真实网站，点「完成」，再让两个 bot 各开一次浏览器，都应是登录状态。这一步验证 Debian 的 chromium 包、xfwm4 下的焦点和关窗。
4. 旧电脑：留着 0.1.x 的电脑磁盘升级，开任一 bot 的座席，等「旧电脑」行显示已复制，到客机 `~/old-computer/` 核对文件，再试一次「删除旧电脑」。
5. 资源：五六个 bot 同时开浏览器时看宿主内存，必要时在电脑面板调内存。

## 打包与发布

### Windows

开发时运行 `npm install` 后执行 `npm run desktop`。

运行 `npm run package:win` 生成 Windows 安装版、ZIP 便携版和独立电脑资源包；打包前需要已准备的 `.computer-runtime/`，也可用 `OMPBOT_COMPUTER_RUNTIME` 指向资源目录。构建时从本机安装路径复制 `omp.exe`，并随附其 MIT 许可，同时写入 `runtime/VERSION` 与 `runtime/PROVENANCE.json`。本机 OMP 低于要求的 18.10 时构建直接失败。主应用保留实际使用的 Cua SDK DLL 和原生模块，排除准备镜像专用的 CLI，Electron 只保留简体中文、繁体中文和英文语言资源。

重新构建会核对电脑资源文件及现有 ZIP 的真实内容摘要，内容一致时复用电脑资源包。新应用先在 `release/.electron-builder-tmp/` 中构建，成功后换入 `release/`，旧版本安装包和便携包归档到 `release/archive/`；失败保留旧成品。运行中的 `win-unpacked/omp-bot.exe` 可能阻止目录换入，此时先退出该应用再重试。

安装包尚未做 Authenticode 数字签名，也没有发布源：本项目不做自动更新，检查到新版本只能重新 `npm run package:win` 并安装。Windows 可能显示未知发布者提示。

旧的单文件 `portable.exe` 每次启动都会将整个应用解压到临时目录，退出后删除。旧包包含约 1.5 GiB 电脑资源，因此启动时反复解压大量文件。ZIP 便携版解决这段启动开销；安装版也只在安装时解压。

`apple-ui`、`computer-final`、`ui-final` 是历史构建批次，当前界面和电脑功能已经合并到同一个应用。旧安装包统一归档到 `release/archive/`，构建不再生成这些根目录版本文件夹。便携表示免安装，应用数据仍使用下文的数据目录。

### 安卓

开发构建使用 `npm run build:android`。配置 JDK 17 和 Android SDK 36，或沿用本机的仓库外工具链。命令运行 Kotlin 单测、构建、签名并输出 APK 与 SHA-256 清单。私有签名材料留在用户缓存，不能提交到仓库。

## 图标与头像

- 应用图标是深色圆角底座上 5 个捏脸人物圆章的合影，底色是助手的黄、绿、粉、蓝，正中最前面是主助手的蓝。32px 及以下换成只有中间那个人的单人版，群像在那么小的尺寸会糊。
- `node scripts/build-icons.mjs` 生成 `web/assets/app-icon.{svg,png,ico}`、`web/assets/app-mark.svg`，以及安卓的启动图标前景、背景和通知图标。栅格化要 sharp：没有就 `npm i --no-save sharp`。安卓的自适应图标矢量格式不支持颗粒和投影滤镜，所以前景和背景用 PNG。
- 头像部件由 `NA_DIR=<上游检出目录> node scripts/build-notion-avatar.mjs` 从 notion-avatar 的固定提交生成 `web/vendor/notion-avatar/parts.js`。图标里的人物也来自这套部件。

# omp-bot

在 [omp](https://omp.sh)（oh-my-pi）上跑一支**常驻 AI bot 团队**：多 bot 花名册、bot 之间互发消息、回合制群聊。

零依赖，纯 Node ESM。不 fork omp，不改 omp 源码——把每个 bot 跑成一个 `omp --mode rpc` 子进程，用 Node 编排层做花名册、消息投递和群聊回合。

灵感来自 [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot)（DSH 的多 bot 插件）。本项目借用它的**编排协议**（bot=session、带署名投递、admin 群聊回合、@点名、`[PASS]` 收敛、那些踩过坑的阈值常量），但架构不同：omp 的记忆、压缩、会话续接都是原生的，编排层因此薄很多。

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

前提：本机装好 `omp`（`omp --version` 能跑），且至少配好一个模型（`omp models`）。Node ≥ 20。

```sh
# 一键 demo：建两个 bot，跑一次「私聊委派」，打印用量
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

数据落在 `~/.ompbot`（或 `$OMPBOT_HOME` / `--home`）：`state.json` 是花名册与群，`bots/<id>/<scope>/` 下是每个 bot 每个会话上下文的 omp session、人格文件和隔离 overlay。

## 命令

| 命令 | 作用 |
|---|---|
| `demo` | 建两个 bot 跑一次私聊委派，打印用量 |
| `bots add <name> [--role R] [--model M] [--instructions I] [--main]` | 新增 bot |
| `bots list` / `bots rm <name\|id>` | 列出 / 删除 |
| `room create <name> --members A,B [--admin A] [--mode admin\|everyone]` | 建群 |
| `room list` | 列出所有群 |
| `chat <bot> "<message>"` | 私聊一个 bot（跨调用续会话） |
| `say <room> "<message>"` | 群里发言，跑 relay |
| `usage` | 当前进程内 runtime 的用量汇总 |
| `interactive <bot\|room:ROOM>` | REPL 连续对话 |

环境变量：`OMPBOT_HOME`（数据目录）、`OMPBOT_MODEL`（默认模型，空则用 omp 默认）、`OMPBOT_DEBUG=1`（打印编排事件与 RPC 帧）。

## 架构

```
                 ┌─────────────────────────────┐
   CLI / IM 桥 →  │        Orchestrator         │  ← state.json（花名册/群/投递日志）
                 │  花名册 · runtime 池 · 投递   │     + 单写者锁
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
- **`src/bot.mjs`** — `BotRuntime`：一个 omp RPC 子进程绑定一个会话上下文（`private` 或 `room:<id>`）。注入人格（`--append-system-prompt`）与隔离 overlay（`--config`），注册团队工具，维护 `busy`/`deliveryDepth` 状态机。
- **`src/persona.mjs`** — bot 人格文本生成 + 隔离 overlay（关掉 context-file provider 防止用户全局 `~/.omp/agent/AGENTS.md` 漏进 bot；关掉 `memory.backend`/`autolearn` 防止 bot recall/retain 用户的私有记忆库）。
- **`src/orchestrator.mjs`** — 花名册 CRUD、runtime 池（按 `botId::scope` 懒启动）、`message_bot`/`list_bots` 团队工具、bot→bot 投递协议、群聊入口。
- **`src/relay.mjs`** — 群聊回合引擎：开场说话者选择（admin/everyone 模式）、串行队列、@点名插队、`[PASS]` 收敛、回合上限。
- **`src/domain.mjs`** — 核心数据形状（Bot/Room/Message/Exchange）与归一化：@mention 解析（最长名优先）、room.log 裁剪、群聊 prompt 构建。
- **`src/store.mjs`** — 团队状态持久层：原子写 + pid 单写者锁 + 版本迁移。
- **`src/constants.mjs`** — 领域常量（hop 上限、超时、mention 限额、回合上限等，多数借自 DS-Bot）。
- **`src/usage.mjs`** — 跨 bot 用量汇总（防御式归一化 `get_session_stats`）。

## bot→bot 消息怎么防死锁

`message_bot` 是同步 host tool：A 调用它 → 编排器跑 B 的回合 → B 的回复作为 tool result 返回给 A。

- **hop 上限**：每跳 `deliveryDepth + 1`，超过 `MAX_HOPS`(6) 拒绝，防止 A→B→A→… 无限链。
- **busy 拒绝**：目标 runtime 正在跑回合时直接返回错误，不阻塞等待。A 调 B 期间 A 自己 `busy=true`（它的回合还没结束），所以 B 若反向调 A 会被立即拒绝，不会死锁。
- **失败回执**：目标启动失败 / 超时 / 忙，都作为 `isError` 的 tool result 返回，发送方不会永久挂起。

## 测试

```sh
npm test              # unit + gate + b2b + group + persist 全套
node test/unit.mjs    # 纯函数单测（无模型）：normalizeStats/parseMentions/isPass/room.log 裁剪
node gate.mjs         # 阻塞门：RPC 握手、人格注入、host tool 回调、最终文本抓取
node smoke-b2b.mjs    # bot→bot 私聊委派闭环
node smoke-group.mjs  # 群聊 relay：everyone 收敛 + admin @路由 + 记忆隔离断言
node smoke-persist.mjs# 跨进程会话续接（关闭重开 bot 仍记得之前的话）
node probe-isolation.mjs # 判决实验：证明 overlay 关掉了记忆后端与 autolearn（对比 systemPrompt）
```

smoke 都是真实模型调用，抓真实 transcript 作为断言证据，不用 mock。`probe-isolation` 不烧模型（只读 `get_state`）。`OMPBOT_MODEL` 可指定便宜模型，`OMPBOT_THINKING` 设默认思考档，`OMPBOT_DEBUG=1` 打印每一帧。

> `usage` 归一化依据的 `get_session_stats` 字段是探测校准的。omp 升级后若字段变动，起一个 bot、`getState()` dump 一次 `get_session_stats` 即可重校 `src/usage.mjs`。

## 已知限制

- **模型指令遵循**：admin 模式的 @路由依赖 admin bot 听话地 `@` 出成员名。用能力强的模型（Claude/GPT-5.x）稳，弱模型偶尔不 @。`everyone` 模式不依赖 @，是确定性的。
- **记忆隔离是有意为之**：bot 关闭了 omp 的记忆后端（`memory.backend: off`）与 autolearn。用户若把 `memory.backend` 指向局域网/远程共享库（如 hindsight），不关的话 bot 会 recall 到用户私有项目记忆、还会把 bot 对话 retain 进共享库造成跨 bot 污染（这个 bug 真实发生过，`smoke-group` 现有断言守着）。bot 的常驻记忆改由会话续接（`--continue`）承担，每 bot 每 scope 独立、互不串。若要给某个 bot 开记忆，改它的 `isolate.yml` 并自负污染风险。
- **单写者**：同一 `OMPBOT_HOME` 同时只能一个 orchestrator 写；第二个拿不到锁时只读。
- **Windows**：已在本机 Windows（Node v24）实测通过；stdio 管道与子进程生命周期正常。
- **IM 桥未含**：本项目是编排内核 + CLI。接飞书/Telegram/QQ 需要另写一个 adapter 把 IM 消息映射到 `chatWithBot`/`postToRoom`，把回复发回 IM。可直接借鉴 [crayonlu/omp-bot](https://github.com/crayonlu/omp-bot) 的 NapCat/OneBot 管道或 [evandrodevbr/oh-my-pi-telegram](https://github.com/evandrodevbr/oh-my-pi-telegram)。

## 致谢

- [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot)：bot 编排层的设计蓝本（花名册、带署名投递、admin 群聊回合、@点名收敛、checkpoint 阈值常量）。
- [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：bot=隔离 profile、每成员每群一会话、带署名的 bot 间消息格式。
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮次与 @mention 中继。
- [oh-my-pi / omp](https://github.com/can1357/oh-my-pi)：宿主 harness，提供 RPC 模式、host tool 回调、会话续接与原生压缩。

## License

MIT

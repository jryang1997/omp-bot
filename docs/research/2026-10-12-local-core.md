# omp-bot 本地核心审计（只读，2026-10-12）

## 0. 方法与标注约定

- 范围：`src/{server,orchestrator,bot,persona,domain,store,relay,rpc-client,usage,constants}.mjs`、`ompbot.mjs`、`desktop/main.mjs`、`test/`、`smoke-*.mjs`、`gate.mjs`、`probe-isolation.mjs`、`web/{index.html,app.js}`。未执行任何脚本或模型调用；全部结论来自静态阅读。
- 标注：**[确认]** = 源码可直接判定；**[假设]** = 合理但需复现实验确认（沙箱逃逸、浏览器跨源、竞态窗口）。
主代理随后完成了局部运行验证，见 [运行证据](2026-10-12-runtime-evidence.md)。本文件其余静态判断不自动升级为实测。优先级和实施裁决以 [主报告](2026-10-12-competitive-gaps.md) 为准。

## 1. 输入 → 运行时执行 → 持久状态映射

| 入口 | 调用链 | 证据 |
|---|---|---|
| `POST /api/chat/:id` | server→`chatWithBot`→`runtimeFor(id,'private')`→`rt.send`→`rpc.promptAndWait` | server.mjs:172-183；orchestrator.mjs:303-317；bot.mjs:139-170；rpc-client.mjs:153-158 |
| `POST /api/rooms/:id/say` | server→`postToRoom`→`Relay.post` | server.mjs:215-221；relay.mjs:44-147 |
| `message_bot` host tool | orchestrator handler→目标 private runtime 回合→tool result | orchestrator.mjs:224-300 |
| CLI `chat/say/interactive` | 同一 Orchestrator 路径 | ompbot.mjs:230-330 |

持久状态有两轨：
- **Node 侧 `state.json`**（`bots/rooms/exchanges/chats`），每次变更整文件原子重写（store.mjs:20-23, 88-90, 96-164）。
- **omp 侧会话**：`<home>/bots/<id>/<scope>/sessions/*.jsonl`，重启用 `--continue` 续接（bot.mjs:44-47, 88, 181-188）。人格与隔离写入 `persona.md`/`isolate.yml`（persona.mjs:24-72）。

**没有独立的任务/作业状态**：一次回合（relay 或私聊）就是任务，无 job 表、无队列持久化、无重试记录。

## 2. 信任与权限

### F1 [确认] cwd 隔离不等于沙箱：bot 默认拿到全部 omp 工具与完整环境
`BotRuntime.start` 拼参数只有 `--no-ui --session-dir ... personaArgv` 与可选 `--model/--thinking/--continue`，**没有 `--no-tools`、没有 OS 级沙箱**（bot.mjs:79-88）。子进程环境为 `process.env`（rpc-client.mjs:58）。
- 成因：产品定位是「让 bot 能干活」，未在编排层做能力裁剪；`cwd` 只是工作目录。
- **重设计候选**：为 `Bot` 增加 `capabilities`（tools allowlist / no-shell / fs roots），启动时映射为 omp 的 `--no-tools`+显式 host tools，或包装在受限容器/低权账户。
- **验收**：`bot.add` 可选 `sandbox: 'readonly'`；启动参数断言含工具裁剪标志；用一个「写 `../../secret`」探针证明越权被拒。
- **未知**：omp 是否已内置权限确认；系统提示是否泄漏宿主路径。

### F2 [确认] 凭据与环境全量继承
rpc 子进程继承全部 `process.env`（含可能存在于环境里的 API key），且其 shell 工具可读宿主文件系统（`--no-tools` 缺省）。
- **重设计候选**：白名单环境变量（只透传 omp 需要的）；凭据改为 omp 自身配置读取而非环境。
- **验收**：子进程 env dump 不含非白名单键。

### F3 [确认] HTTP 无鉴权、无 Origin/Host 校验、无 CSRF 防护
`server.mjs` 全文件没有任何 `Origin`/`Referer`/token 检查；`host` 只在构造 URL 时被读（server.mjs:103）。唯一的边界是监听 `127.0.0.1`（server.mjs:241）。
- 成因：默认单用户本机假设。
- **[假设] 风险**：跨源页面可能触发有副作用的 POST（如 `/api/chat`、`/api/bots`）；`Content-Type: text/plain` + 原始 JSON body 属简单请求可绕过预检，响应不可读但副作用已发生。DNS rebinding 同理（Host 未校验）。需用本机 PoC 复现。
- **重设计候选**：启动时生成随机 token 注入页面，所有 `/api/*` 校验；或校验 `Origin` 与 `Host` 属白名单。
- **验收**：从另一源用 fetch 打 `/api/chat` 得 403；Host 伪造得 421/403。

### F4 [确认] message_bot / list_bots 无 ACL：任意 bot 可跨房间联系任意 bot
`_handleMessageBot` 用全局 `resolveBot(to)`（orchestrator.mjs:235, 149-166），`list_bots` 返回全部 bot（orchestrator.mjs:213-217）。不检查发送方与目标是否同群、是否有权限。群 A 的成员可联系只在群 B 的 bot。
- **重设计候选**：给投递加「共享房间/显式友链」策略；`list_bots` 按可见域过滤。
- **验收**：无共同房间的两 bot 互发被拒并记审计。

### F5 [确认] 主机工具调用无人工审批
`message_bot` 与 `list_bots` 的宿主 handler 由 `_serveHostTool` 执行，产品没有批准台账或 GUI 审批入口。OMP 原生审批行为需另外核验，不能据此断言底层完全没有审批能力。`--no-ui` 的 RPC UI 限制见 OMP 官方协议。
- **重设计候选**：在执行边界管理授权，跨工作区或有对外副作用的动作按策略审批，普通同域查询和委派无需逐次弹窗。

### F6 [确认] 静态目录穿越已防，但边界仅覆盖静态
`serveStatic` normalize 后要求落在 `WEB_DIR` 内（server.mjs:86-99），smoke 有断言（smoke-gui.mjs 目录穿越）。这是保留优点。缺口：`req.url` 未做长度/编码上限，`readBody` 仅 4 MiB 上限（server.mjs:69-83）。

### F7 [假设] 隔离 overlay 覆盖面依赖 omp 内部 provider 命名
`persona.mjs` 靠 `disabledProviders` 列名与 `memory.backend: off`/`autolearn.enabled:false` 覆盖（persona.mjs:15-72）。`probe-isolation.mjs` 用 `get_state.dumpTools`/`systemPrompt` 做判决实验（保留优点）。若 omp 改 provider id、或用户 config 用别名，overlay 可能漏；需在目标 omp 版本复现。

## 3. 状态机、超时、恢复、并发

### F8 [确认] 客户端超时没有主动中止回合
`promptAndWait` 的 timeout 使 `_waitPromptResult` 的 waiter reject，不发送 abort。主代理受控探针也只捕获到 prompt 命令。实际慢回合是否继续耗用 token，本轮未测。
- 风险是宿主超时与底层运行终态不一致，不能把 timeout 当作停止证明。
- **重设计候选**：复用已被主代理真实 RPC 接受的 abort 命令，验证实际工具与子任务停止，并在无法确认时隔离回收对应 runtime。
- **验收**：注入慢回合，断言超时后无新 token 增长/进程被回收。

### F9 [确认机制，后果待测] 超时后宿主状态回到 IDLE
`send` 的 `finally` 在 RPC 未关闭时把状态置回 IDLE，未检查回合是否真正终止。后续输入可能与未结束工作交错，但本轮没有复现两个模型回合并行、消息损坏或重复副作用。
- **重设计候选**：超时/失败应置「draining」态，直到收到真正 `prompt_result` 或进程重启。

### F10 [确认] 群 /say 无忙/去重保护
server 只对私聊做 `rt?.busy` 预检，postToRoom 每次创建 Relay，未统一锁住房间执行。各 Relay 会访问同一个 room.log，但 queue 与 mentionBudget 是每次 post 的局部变量，不是共享预算。并发下的日志和回合交错风险尚未运行复现。私聊启动期间的 admission 也应覆盖首次懒创建与启动等待。
- **验收**：并发两次 `/say` 第二次得 409；room.log 无交错。

### F11 [确认] 重启恢复：进程死亡丢回合，exchange 可能停留 pending
rpc `exit` 只置 STOPPED 记 lastError（bot.mjs:100-103）；重启靠 `--continue`（bot.mjs:88）。`recordExchange` 不落盘（store.mjs:135-141），仅在 handler 完成时 `flushExchanges`；进程在投递中途死亡 → 该 exchange 丢失。
- **重设计候选**：exchange 状态机加 WAL/落盘于 pending 时。

### F12 [确认] 只读态未在 server/CLI 处理
`orch` 拿不到锁时 `store.readonly=true`（store.mjs:57-76），任何 `save()` 抛错（store.mjs:88-90）。`desktop/main.mjs` 显式检查并报错，但 `server.mjs`/`ompbot.mjs` 未检查 → GUI/CLI 起到只读 home 时写操作返回 500。
- **重设计候选**：启动即 fail-fast 或进入只读 UI 模式。

## 4. 持久化、预算、记忆、可观测

### F13 [确认] 每次变更整文件原子重写，无 fsync/备份/轮转
`atomicWrite` 为 tmp+rename（store.mjs:20-23）。写放大；无 `.bak`；崩溃窗口小但无校验和。

### F14 [假设] pid 锁存在 TOCTOU
`acquireLock` 先 `existsSync` 读锁再 `atomicWrite`（store.mjs:57-75），两步非原子；两进程同时判陈旧可同时写锁。需并发启动复现。

### F15 [确认] removeBot/removeRoom 不清理派生态
`removeBot` 仅删 state+停 runtime（orchestrator.mjs:85-89），**不回删 `home/bots/<id>/` 会话文件**；群成员数组仍保留已删 id（relay `members()` 静默过滤，relay.mjs:35-39 仅 filter(Boolean)）。`removeRoom` 删 room 与 room runtime（orchestrator.mjs:137-146），无归档。
- **重设计候选**：级联清理 + 回收站；群成员删除时同步清理成员表。

### F16 [确认] 预算只报告不限制，且只统计存活 runtime
`collectUsage` 遍历 `orch.runtimes`（usage.mjs:44-73），无成本上限、无持久累积；CLI 一次性命令 runtime 池为空（ompbot.mjs `runUsage` 注释自证）。无 per-bot/per-room 预算，无 402/熔断。
- **重设计候选**：持久化用量账本 + 限额与熔断。

### F17 [确认] 记忆/压缩完全外包给 omp，编排层无记忆
overlay 关 `memory.backend`/`autolearn`（persona.mjs），常驻记忆靠 `--continue`；长上下文靠 omp 原生 compaction（README 自述）。编排层不裁剪 prompt（room.log 保留最近 60 条，constants.mjs `ROOM_LOG_KEEP`）。

### F18 [确认] 可观测性仅内存事件流
`emit`→SSE（server.mjs:47-51），无磁盘日志、无指标、无 trace id；bot→bot 有 hop 计数（exchange.hop）但无跨进程关联 id（orchestrator.mjs:246-247）。debug 才打印帧（rpc-client.mjs:216,232）。
- **重设计候选**：结构化审计日志（谁在何时用什么工具、投递链 traceId）。

### F19 [确认] 命名唯一性只在 HTTP 层校验，CLI 可造重名
`POST /api/bots` 查重名（server.mjs:136-138），但 `bots add` 无查重（ompbot.mjs runBots）；`resolveBot` 取「最长名」缓解但不能消歧（orchestrator.mjs:149-166）。重复名会使 message_bot 投递歧义。

### F20 [确认] 群 admin @路由依赖模型遵循（软指标）
`_openingSpeakers`/`_enqueueMentions` 靠模型输出的 `@名字`（relay.mjs:149-210）。README 与 smoke-group 明示为软指标。everyone 模式确定性收敛（保留优点）。

### F21 [确认] 死锁防护设计明确且有效（保留优点）
hop 上限 + busy 拒绝 + 失败回执三者齐备（orchestrator.mjs:7-8, 229-300；constants.mjs MAX_HOPS/DELIVER_TIMEOUT_MS）。这是本项目最扎实的一处，F9 是其唯一破口。

### F22 [确认] 群回合上限与去重
`ROOM_MAX_ROUNDS`、mention 限额、`[PASS]` 收敛（relay.mjs:92-146；constants.mjs）。防止 @ 链长尾。

### F23 [确认] 版本迁移最小化
`migrate` 只做形状兜底、不真正按 `version` 迁移（store.mjs:167-176），未来 schema 变更无升级路径。

### F24 [确认] 未使用的死代码/常量
`RPC_COMMAND_TIMEOUT_MS` 被 bot.mjs 导入但未使用（bot.mjs:14-17）；`modelsCache` 永久缓存，模型配置变更后 GUI 下拉不刷新（server.mjs:29-42）。

## 5. 测试覆盖（只读，未执行）

- `test/unit.mjs`：normalizeStats/parseMentions/isPass/appendRoomLog 纯函数，覆盖良好（含最长名、尾随字符、裁剪边界）。**未覆盖**：store 锁/迁移、relay 队列、rpc 分块重组、server 校验分支（除 smoke-gui）。
- `smoke-gui.mjs`：25 项 HTTP 断言，含静态、CRUD、409/400、SSE、目录穿越。**未覆盖**：Origin/Host、并发 /say、只读 home、超大 body。
- `gate.mjs`/`probe-isolation.mjs`：RPC 握手、人格注入、host tool 回调、隔离判决（不烧模型）。
- `smoke-b2b/group/persist`：真实模型端到端，含记忆隔离回归 token。
- **缺口**：无超时/中断测试、无并发/去重测试、无崩溃恢复测试、无预算限额测试、无沙箱越权测试（F1 无验收）。

## 6. 优先级与重设计路线

**P0（安全边界，先做）**
1. HTTP 鉴权 + Origin/Host 校验（F3）；2) bot 能力裁剪与沙箱（F1/F2）；3) 投递 ACL（F4）。
验收：跨源 PoC 失败；越权写探针失败；跨房间投递被拒并留审计。

**P1（正确性/资源）**
4. 超时真正中止 + 状态不再错置（F8/F9）；5) 群/私聊统一忙锁与去重（F10）；6) exchange 落盘与恢复（F11）；7) 只读 fail-fast（F12）。
验收：并发与超时注入测试通过；崩溃后 pending 可恢复。

**P2（可运维）**
8. 结构化审计日志与 traceId（F18）；9) 级联清理/回收站（F15）；10) 预算账本与限额（F16）；11) schema 迁移框架（F23）。

## 7. 保留优点（不要推倒）
- botId::scope 进程隔离模型与 `--continue` 记忆（bot.mjs）。
- host tool 同步投递 + hop/busy/失败回执的死锁防护（F21）。
- 纯 Node relay、无 stream 劫持（relay.mjs 头部注释）。
- 静态目录穿越防护与原子写（F6/F13）。
- 隔离 overlay + probe-isolation 判决实验（F7）。
- 覆盖私聊/群聊/持久/隔离的真实模型 smoke（第 5 节）。

## 8. 未知项（需复现或问作者）
1. omp 是否内置工具权限确认/沙箱标志（决定 F1 的具体修法）。
2. omp 是否有协议级 cancel/abort（决定 F8 修法）。
3. 浏览器跨源/DNS rebinding 对 `text/plain` 简单请求在本服务的实际可达性（F3）。
4. 隔离 overlay 在目标 omp 版本对各 context provider 的实际覆盖（F7）。
5. pid 锁 TOCTOU 的实际触发窗口（F14）。
6. 会话 jsonl 无上限增长的实际磁盘影响与 omp 侧 compaction 落盘策略。

## 9. 来源清单
- 本地源码：列于第 0 节；关键行号已内联。
- 本地文档：`README.md`、`AGENTS.md`、`docs/agents/*`。
- 未访问外部来源（本任务为本地核心审计，未做竞品比对，未联网）。

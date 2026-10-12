# 冻结实施接口 v1

所有实现者必须沿用 OMP 18.10.0 原生协议。主代理是集成所有者。此契约冻结共享数据和调用形状，具体逻辑由指定 worker 实现。允许修正需先告知主代理，禁止新增平行机制。

## 结构

保留 Store 的 state.json 花名册和原始聊天历史，不破坏已有资料。新增 Ledger 使用 node:sqlite，存运行投影、事件游标和产品独有记录。OMP session JSONL 是真实模型、工具、会话、压缩与分支的权威。Ledger 的文本事件只是有限重放与展示投影，不是第二模型历史。

Orchestrator 唯一整合 BotRuntime、Ledger 与 WorkbenchFeatures。不另建第二 RunManager。BotRuntime 唯一持有 RpcClient，运行态由真实 native frame 和 settled 驱动。默认采用 plain rpc-ui 加显式 write 审批档，原生执行能力与主机权限如实披露，不称沙箱。聊天受限档用 --no-tools，只有 host 受控资料工具。不存在经过验证的 OS 沙箱时拒绝 sandbox 模式，不伪装。

## Ledger，所有者 LedgerOwner

`new Ledger({home,readonly=false})`。方法均同步，关闭一次。SQLite 文件 `<home>/workbench.sqlite`。支持以下固定接口。

- `createRun(input)` 返回完整记录。input 为 `{id?,kind:'chat'|'room'|'delegation',botId?,roomId?,scope,text,attachmentIds?,parentRunId?,depth?,budget?,source?,taskId?}`。
- `getRun(id)`、`updateRun(id,patch)`、`listRuns({botId?,roomId?,state?,limit?}={})`。缺失 get 返回 null。update 验证终态不重新打开。
- `appendEvent(input)` 分配全局单调 seq，返回 `{v:1,seq,at,...input}`。`eventsSince(seq=0,{runId?,limit=1000}={})`，`lastSeq()`。
- `put(kind,record)`、`get(kind,id)`、`list(kind,{limit=200}={})`、`remove(kind,id)`。kind 限 `attachments,artifacts,routines,approvals,devices,settings,outbox,workspaces`。不存模型凭据。
- `addUsage(runId,stats)` 存每 Run 的差值数据和原生模型标识，`usage()` 返回 `{perRun,totals}`，保留真实费用口径，无价格时标未知。
- `reconcile()` 把旧 active 状态写为 interrupted，不自动重跑，不丢历史。`close()`。

run 字段至少 `{id,taskId,kind,botId,roomId,scope,text,state,createdAt,updatedAt,parentRunId,depth,budget,sessionId,sessionFile,reply,error,stats,approvalIds,artifactIds}`。state 为 queued/starting/running/waiting_input/waiting_approval/cancelling/completed/failed/cancelled/interrupted。cancelled 不等于撤回已发生动作。SQLite 架构版本迁移备份 state.json，单写者遵守已有 Store 锁，readonly 禁写。

## Native RPC，所有者 RpcNativeOwner

现有 RpcClient 加 mode 和 exactEnvironment、每个 decoded frame 的 frame 事件、prompt 的 images/signal、本机 UI response 和 abort 等原生命令方法。详细 worker brief 已冻结。`promptAndWait` 正确处理本地命令完成、拒绝、超时和真实 settlement。`onHostTool(name,handler)` handler metadata 包含 requestId、toolCallId、toolName、signal 与 progress。host_tool_cancel 按 targetId 中止并丢迟到结果。

## Orchestrator 与 Runtime，所有者 CoreOwner

保留既有公开 CLI 能力 `addBot/getBot/listBots/updateBot/removeBot/createRoom/getRoom/listRooms/updateRoom/removeRoom/getChat/clearChat/chatWithBot/postToRoom/shutdown`。公开旧方法内部复用新运行逻辑，不能保留另一个执行路径。

新增方法。

- `startRun({botId?,roomId?,text,attachmentIds=[],timeoutMs?,budget?,source='user',parentRunId?,depth=0})` 立即同步返回 run。admission 在首次启动前原子预留，忙目标 throw Error with status=409。异步执行失败持久进 run，而不是 unhandled Promise。
- `getRun(id)`、`listRuns(filters)`、`waitRun(id)` 返回终态 run。API 和 CLI await 旧方法仍拿 reply/spoken。
- `cancelRun(id,reason='user')` Promise 返回 `{accepted:true,run}`。级联取消宿主工具/子 Run/OMP subagent，不能立即 claim stopped。确认后 cancelled；回收进程实际关闭；新消息不得穿过 cancelling。
- `steerRun(id,text,{behavior='steer',images}={})` 调 native steer/follow_up。不创建第二并发运行。
- `answerUi(id,response)` 回原生 extension_ui_response，id 是工作台 approval 记录 id，record.nativeId 为 native request id，expired 或目标 run 不活跃时拒绝 409。response 为 `{value?,confirmed?,cancelled?,answers?}`，由 native method 验证，不默认推荐。
- `newSession(botId,{scope='private'}={})`、`nativeCommand(botId,command,{scope='private'}={})`，仅 server 显式允许的命令可用，runtime idle 时调用。
- `getNativeState(botId,{scope='private'}={})`；`runtimes` 保留可读 Map，兼容现有 smoke。
- `emit(type,data={})` 调 ledger.appendEvent 然后 onEvent，返回信封。`eventsSince(seq,filters)` 转 Ledger。

Bot 记录可增加 `executionMode:'supervised'|'chat'|'full'` 默认 supervised、`approvalMode:'always-ask'|'write'|'yolo'` 默认 write、`workspace` 用户显式选目录、`memoryEnabled` 默认 false、`skills` 可选原生过滤数组、`budget`。full/yolo 只能在用户专用设置入口显式确认，导入模板绝不带授权。supervised 是原生审批模式不是 OS 沙箱。policy signature 变化重建进程、等待 stop 完成，新 session 和更新不得冲撞活跃 Run。

直接 message_bot 沿用同步 host tool、hop/busy 防死锁，handler 接 signal；父 Run 取消传播到目标 Run。另可提供 `delegate_bot` 异步工具形成子 Run 并立即回 id，工作台收件箱可见，不绕过 scope/预算。群运行以一个 room Run 管理串行 native 子回合，继续保存原有 PASS/mention 语义。

原生 UI 记录 `{id,runId,botId,scope,nativeId,method,title,message,options,optionDetails,questions,status:'pending'|'answered'|'cancelled'|'expired',createdAt,expiresAt}`。原生 select/confirm 承载真实审批；ask 是提问，不得把 recommended 当用户回答。cancel(targetId) 清 pending。没有真实回答时不上行自动确认。

## 工作台事件

所有事件 `{v:1,seq,at,type,runId?,botId?,roomId?,scope?,...payload}`。保持原 roster/room/exchange 事件兼容，但统一 seq 和持久重放。

核心新事件。

- run_created/run_updated/run_finished，payload.run。
- native_event，payload `{runId,botId,scope,event:frame}`。前端从 message_update.assistantMessageEvent.text_delta/thinking_delta 解析增量，工具与 subagent 显示原生字段。不要假设字段，读官方 event 文档并真实探针校正。
- ui_request/ui_resolved，payload.approval。
- artifact_added，payload.artifact。

事件保留有限可重放投影，GET 状态可恢复快照。SSE 的 id 是全局 seq，重连不重复消费。

## HTTP，所有者 ApiOwner

`startServer({port=3099,host='127.0.0.1',home,bin='omp',debug=false,defaultThinking='low'})` 返回 `{server,orch,url,token,close}`。`url` 不带 token，`launchUrl` 可带 fragment token。网页在读取本机 index 时 bootstrap 使用随机进程 session cookie或安全一次性 local token，所有 `/api` 要求同源有效 session 或 `Authorization: Bearer token`，SSE 不能通过可日志 query 泄漏长期凭证。测试用 returned token header。校验 Host/Origin/Content-Type 和路径，保留 localhost合法缺 Origin CLI。

核心端点。

- 原 bots/rooms/chat GET/DELETE，原 chat POST 和 rooms say POST 保持可等待返回，用新 run 逻辑。新增 `POST /api/runs` 202 `{run}`，input 对应 startRun。
- `GET /api/runs` `{runs}`；`GET /api/runs/:id` `{run,approvals,artifacts}`；`POST /api/runs/:id/cancel`；`POST /api/runs/:id/steer`。
- `GET /api/events` SSE；`GET /api/events/history?since=N` `{events,lastSeq}`，401/403无鉴权拒绝。`GET /api/state` 含 bots,rooms,activeRuns,pendingApprovals,lastSeq。
- `GET /api/approvals` `{approvals}`；`POST /api/approvals/:id/respond` 交 answerUi。
- `POST /api/bots/:id/session/new`；`POST /api/bots/:id/session/fork` `{entryId?}`；`GET /api/bots/:id/native/state`；`GET /api/bots/:id/native/entries`；`GET /api/models?refresh=1`；`GET /api/usage` 含持久 totals。
- 原生受限命令 `POST /api/bots/:id/native/command` `{command}`，只允许会话/模型/登录/技能/记忆/电脑操作的明确命令集合，不任意 bash/eval/raw frame。

产品特性端点由 `WorkbenchFeatures.handleRequest(req,res,url,body,json)` 接入，返回 bool handled；ApiOwner 调用一次而不复制功能路由。auth 和 body 由 ApiOwner 统一先检查。Features 不能绕过 server 的安全判断。

## WorkbenchFeatures，所有者 FeaturesOwner

`new WorkbenchFeatures({orch})`，`handleRequest(req,res,url,body,json)` async bool，`start()`、`close()`，`preparePrompt(run)` async `{text,images}`，`collectArtifacts(run,runtime)` async artifact[]。CoreOwner 构造 `this.features` 并在任务前后调用 preparePrompt/collectArtifacts，服务启动 features.start，shutdown close。

负责 src/features.mjs 及 src/features/** 模块和 test/features.mjs，不改 core/server/store/web。Ledger 的 put/get/list 供附件、成果、计划、devices 等存储。端点。

- `POST /api/attachments` JSON `{botId,filename,mime,dataBase64}` → `{attachment}`；GET `/api/attachments?botId=`；DELETE `/api/attachments/:id`。
- GET `/api/artifacts?botId=&runId=` → `{artifacts}`；GET `/api/artifacts/:id/download`、`/preview`，only registered root-contained real files，html/svg 隔离 CSP。
- GET/POST `/api/routines`；PATCH/DELETE `/api/routines/:id`；POST `/api/routines/:id/run`。支持 once、daily time+IANA timezone、intervalMs，定义超时和重叠跳过。每次发起走 orch.startRun，不新循环。
- GET `/api/bots/:id/native/capabilities`，显示 OMP 原生 MCP、skills、memory、browser，未知写未知。MCP 配置与 skill 过滤写在 Bot 私有项目目录，不修改全局。真实调用仍由 OMP 原生工具处理。
- GET/PUT `/api/bots/:id/mcp` 公共定义只见 configured flags，不回密钥；原生 mcp.json格式、secret输入专用，写权限配置由用户动作授权，scope收紧重启 Bot。
- GET `/api/bots/:id/skills` 基于原生 get_available_commands 或安全本地 discovery；不复制 skill registry。更新过滤使用 Bot.skills。
- GET `/api/bots/:id/memory`，PUT `/memory`，POST `/memory/clear`，只管理原生 local backend 的 scoped MEMORY.md/learned.md，必须验证 native path隔离，未测不开；不建第二记忆后端。
- POST `/api/bots/:id/browser/takeover`、`/release` 复用原生 browser/Cdp机制，人工期间暂停 Bot；若需环境能力，明确 capability状态并无假 URL。
- 配对与飛书可在下一波复用此类追加。Webhook独立receiver且明确开关；token不自动公开。

## 前端，所有者 UiOwner

只写 web/app.js,index.html,style.css 和必要 UI 模块。native/server endpoints以上述为准，existing GUI保持真实可用。核心 run流式、工具、子代理、approval、停止、补充、新会话、图片附件、任务页、成果、计划、能力/MCP/skills/memory面与搜索、导出。未实现API不做假按钮，用实际能力状态决定入口。bootstrap fetch同源cookie或注入token，所有动态文本安全渲染。

## Desktop 与 CLI，所有者 DesktopCliOwner

只写 desktop/main.mjs、ompbot.mjs、scripts/prepare-desktop.mjs、electron-builder.yml、package.json 和 README.md、CHANGELOG.md、test/shutdown.mjs，其他tests由集成owner。托盘关闭隐藏，明确退出 stop，系统通知工作完成/待输入/失败。CLI旧方法内部新run，新增run/stop/approve/routine操作，认证不泄漏。复用 OMP login/update/help原生入口，安装包本地构建，签名和发布需用户真实证书/源不得造假。Node engines>=24本机SQLite要求。完整README在最后接口稳定后更新。

## 测试与临时资料

实现者可以写有行为价值的测试但中途不执行。root在冻结后统一跑。ApiOwner负责更新 smoke-gui.mjs 的鉴权请求和增加HTTP拒绝原点/Host/Content-Type实际检查；所有owner更新被自己改破的consumer，越界先message root。只用临时home，不对用户home迁移或发真实业务消息。

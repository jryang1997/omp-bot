# 04: 记忆改用 mnemopi，每 bot 一库

**What to build:** 开启记忆的 bot 改用 mnemopi，按 bot id 分 bank，库文件在 `team/.memory/`。删掉私有 agentDir、私有 models.yml 生成和记忆前置门槛。omp-bot 发给 bot 的消息标上场景和发送者。在常驻进程里验中文召回，选定嵌入模型。

**Blocked by:** 01

**Status:** done

- [x] overlay 的记忆段是 mnemopi、global、`bot-<id>`、team 内的 dbPath，autolearn 关，模型角色钉在选定模型
- [x] 子进程环境里没有 `PI_CODING_AGENT_DIR`
- [x] 开启记忆不再因为前置条件被拒，`memory_prereq_missing` 不再出现
- [x] 私聊和群聊消息带场景和发送者标签
- [x] 嵌入模型的选择和实测写进 CHANGELOG

落地记录：

- overlay 记忆段：`memory.backend: mnemopi`，`mnemopi.scoping: global`、`bank: "bot-<id>"`、`dbPath` 指到 `team/.memory/mnemopi.db`、`embeddingVariant: multilingual`，`autolearn.enabled: false`，default、smol、memory 钉在选定模型（`src/persona.mjs`）。缺库路径时直接抛错，不让 omp 退回用户自己的库。
- 删了 `src/memory-config.mjs`、BotRuntime 的私有 agentDir 和 `_writePrivateModelConfig`、编排器的 `validateMemoryPrereq`。`buildEnv` 只剩最小放行集。用户自己设的 `PI_CODING_AGENT_DIR` 和 profile 原样转发，omp-bot 不再设置。
- 全部 bot 一个库文件。omp 在 global scoping 下 bank 就是共享 bank，`resolveBankDbPath` 直接用 dbPath，不建 `banks/` 子目录；行按 `session_id = bank` 分，omp 的写入 scope 都是 `bank`，召回 `session_id = ? OR scope = 'global'` 不会串。实机里另一个 bot 读不到。
- 消息标签：`sceneTag`、`senderOf` 在 `src/domain.mjs`。私聊在 `_driveRun` 加第一行，群聊在 `roomPrompt` 第一行，bot 之间传话用 `sender: 🤖 名字 (@id)`，飞书传 `飞书 <label>`。台账和聊天记录存原文。persona 里讲清标签含义。
- 记忆面改只读：`memoryStatus`、`memoryRead` 用 node:sqlite 只读开库，列最近 50 条；删了 PUT、clear、probe 三个接口和前端编辑器。面板时间按本机时区显示，对话存档的 role 标记换成「用户：」「助手：」。
- 证据：`proof/memory-e2e.json`（13 项全过：私聊 4 轮后存档带标签、群聊新会话首轮召回私聊内容、另一个 bot 读不到、状态面边跑边读、用户记忆目录没动、子进程没有 PI_CODING_AGENT_DIR）；`proof/embed-eval/`（e5-large 真实召回 top1 14/15、top3 15/15，bge-small-zh 1/15）。嵌入进程实测三个 omp 共用一个，常驻约 1.85GB。
- 测试：test/team.mjs 加 3 项 04 测试（27/27），runs.mjs 记忆测试改写，features.mjs 记忆测试改成 mnemopi 只读，13 个测试文件全过，smoke-gui 55/55。
- skip: 整库清空某个 bot 的记忆。所有 bot 一个库文件，按 bank 删行要碰 mnemopi 的十几张表，还会和运行中的 omp 抢写，先不做，面板写明让 bot 自己忘。


# omp-bot 本地体验与功能审计（竞品差距输入）

- 日期：2026-10-12
- 对象：C:/Users/Jerry/Desktop/omp_bot
- 方法：只读通读 desktop/main.mjs、web/index.html、web/app.js、web/style.css、ompbot.mjs、README.md，并以 src/*.mjs 为后端契约权威来源。未运行应用、未跑测试、未接触竞品（OpenMausBot / Meta Muse / xAI Grok Bot / OpenAI Dots 仅为差距参照，本文件不声称任何竞品实测）。所有结论分三级标注：【源】= 源码可验证行为；【营销】= README/文档自述；【推断】= 由源码结构合理外推、未实测。

## 1. 结论概览

后端编排已成型（花名册、群聊 relay、bot→bot 委派、每 bot 隔离 overlay），但“面向用户的聊天产品”能力落后：没有流式、没有停止、没有重试/编辑/分支、没有附件/语音、没有消息搜索/导出、没有通知/托盘/常驻、没有更新机制、没有首次启动引导。以下 30 条发现按严重级排列。

严重级：P0=阻断核心留存，P1=显著影响体验，P2=可用性瑕疵，P3=一致性/卫生。

## 2. 用户流程映射（实测源码路径）

| 流程 | 现状（源码路径） |
|---|---|
| 首次启动/凭据 | 桌面：findOmp 找 omp.exe，失败即弹错误框（desktop/main.mjs:10-46,155-158）。模型目录来自 `omp models --json`（src/server.mjs:29-42）。无登录/输入密钥/测连 UI。 |
| 新建/编辑 Bot | 侧栏＋ → 模态表单 botForm（web/app.js:605-632），字段 name/role/model/thinking/instructions/isMain；POST /api/bots（server.mjs:133-147）；PATCH 会停 runtime（orchestrator.mjs:96-110）。 |
| 新建/编辑群 | roomForm（app.js:634-674）选成员/模式/admin；POST/PATCH /api/rooms（server.mjs:185-209）。 |
| 私聊消息 | `send()`（app.js:423-474）乐观插入用户气泡 → `await POST /api/chat/:id`（server.mjs:168-183）→ 整段 {reply}。无增量。 |
| 群聊消息 | POST /api/rooms/:id/say（server.mjs:211-221）阻塞跑完 relay；SSE 推 room_round_start/room_bot_post/room_bot_pass/room_turn_error/room_round_end（relay.mjs 多处 emit）。 |
| 停止/重试/编辑/分支 | 不存在（app.js 无 stop/abort/retry/regenerate/取消 命中）。 |
| 附件/图片/音频 | 输入区仅 textarea+发送按钮（index.html:96-103）；无 paste/drop/upload；仅 bot 出站可用 Markdown 图片（style.css:97）。 |
| 搜索/导出/历史 | 侧栏搜索仅匹配 name/role（app.js:182-183）；无消息搜索、无导出；历史 GET /api/chat/:id，展示层上限 400 条（store.mjs:154）。 |
| 通知/后台/托盘 | 无（desktop/main.mjs:1 未导入 Tray/Notification）；关窗退出（main.mjs:60）。 |
| 键盘/无障碍/移动 | Enter/Shift+Enter、Escape（app.js:932-963）；模态有焦点陷阱（app.js:945-955），drawer 没有；响应式断点 760/1100px（style.css:156-179）。 |
| 模型选择/错误恢复 | 下拉来自缓存的 /api/models（app.js:610-615,985）；错误以 toast/气泡呈现（app.js:462-465）；无重试按钮。 |

## 3. 发现清单

### F1 无“停止生成”——P0，用户锁定
【源】chat POST 是唯一入口且阻塞（src/server.mjs:159-183），无 abort 路由；`syncBusy()` 在忙碌时禁用输入与发送（web/app.js:409-421）；全库无 stop/abort/取消。用户发起后只能等超时（私聊 timeoutMs 默认 600000，server.mjs:180；群聊 ROOM_TURN_TIMEOUT_MS=240000，constants.mjs:12）。
影响：长回合、模型卡住、误发消息时用户完全无法干预，被迫等待或杀进程（会丢失 bot 进程）。
改动量：大（后端需中断 RPC 回合 + 前端按钮 + 状态机）。
验收：发送后 1s 内出现“停止”；点击后 ≤2s 恢复可输入并在气泡上标注“已停止”；范围内 bot 子进程回合被取消而非等超时；停止不影响会话续接。

### F2 私聊无流式输出——P0
【源】POST /api/chat 返回整段 {reply}（server.mjs:174-183；app.js:446）。SSE 仅发 `bot_to_user`（orchestrator.mjs:315），前端收到后只 `loadChat` 整表重载（app.js:537-542），不注入增量。生成期间仅显示 `${name} 正在回复…` shimmer（app.js:389-391）。
影响：首字延迟不可见，长回复像卡死；体验与 ChatGPT/Claude/Grok 差距最大的一项。
改动量：大。
验收：回复文本逐段出现；可显示首 token 延迟；停止后已产出部分保留。

### F3 无工具调用/委派进度——P1
【源】`exchange_request` 仅弹 toast「A → B（委派中）」（app.js:538-539）；`exchange_reply`/`exchange_failed`（orchestrator.mjs:289,295）与 `room_mentions`/`room_empty`（relay.mjs:64,134）在 app.js 中无消费者。
影响：多 bot 协作时用户看不到消息在谁之间流转、谁在调工具；失败无落痕。
改动量：中/大。
验收：回合内以时间线展示 message_bot 调用的起止与结果；失败以行内 chip 呈现。

### F4 无重试/编辑/重新生成/分支——P1
【源】app.js 全文无 retry/regenerate/编辑分支（grep 零命中）；消息渲染为只读（app.js:312-367），仅提供整条复制（app.js:336-360）。
影响：模型答歪只能新建会话或重打字；无法像主流客户端那样编辑上一条再滚回。
改动量：中。
验收：assistant 气泡有“重新生成”；用户气泡可编辑并重发；可切分支。

### F5 无附件/图片/音频输入——P1
【源】输入区仅 textarea+send（index.html:96-103）；app.js 无 paste/drop/file/upload 处理；拖放样式 `.bt-dropzone`、语音 `.bt-voice-pane`（ui.css:391,493-497）随包分发却零引用。
影响：无法贴截图、传文件、语音输入；对“给 bot 派活”的场景是硬缺口。
改动量：大。
验收：粘贴/拖入图片生成缩略图并随消息提交；桌面端可录音上传（至少给出明确的“暂不支持”提示而非静默）。

### F6 无消息搜索/导出——P2
【源】侧栏搜索只过滤 bot/room 名与角色（app.js:182-183）；无 /api/search；无导出按钮。历史靠 GET /api/chat（server.mjs:159-162）与 room.log。
影响：会话变长后无法定位旧结论，也无法带走记录。
改动量：中。
验收：会话内搜索命中并可跳转；提供导出 Markdown/JSON。

### F7 无通知/托盘/后台常驻——P1（与定位强冲突）
【源】desktop/main.mjs:1 仅导入 app/BrowserWindow/dialog/Menu/shell；无 Tray、无 Notification。window-all-closed→app.quit（main.mjs:60），before-quit 停止 backend 与 bot 进程（main.mjs:160-188）。
影响：“常驻 bot 团队”实际必须保持窗口开启；bot 在后台跑完/出错用户收不到提醒；误关窗即中断所有 bot。
改动量：大。
验收：关闭窗口最小化到托盘而非退出；bot 完成/群回合结束/出错发系统通知；托盘菜单可退出并释放锁。

### F8 无自动更新——P2
【源】electron-builder.yml:6 `publish: null`，无 autoUpdater/更新检查；package.json version 0.1.0。README【营销】仅提示未签名。
影响：用户无法获知/获取新版本，修复只能重装。
改动量：中。
验收：应用内可见当前版本；有更新时提示并可下载安装。

### F9 首次启动无模型/凭据引导——P1
【源】模型下拉数据来自 `omp models --json`，失败即 `{models:[],error}`（server.mjs:31-42）；若空，表单只有“（默认模型）”且仅一行 hint“选一个 omp models 里已认证的模型”（app.js:611-615）。无登录、无密钥输入、无“测试连接”。桌面缺 omp 时仅错误框（main.mjs:38-45）。
影响：新用户最可能卡在“没有可用模型却不知怎么办”。
改动量：中/大。
验收：无模型时给出可执行引导（安装/登录/配置命令或按钮）与“重新检测”。

### F10 模型目录永久缓存——P2
【源】`modelsCache` 一旦填充永不过期（server.mjs:30-42）；前端 init 只取一次（app.js:981-986）。
影响：新增/切换模型后必须重启整个应用才可见。
改动量：小（加 `?refresh=1` 或加 TTL）。
验收：设置页有“刷新模型”，点击后下拉更新。

### F11 无“新会话/重置记忆”，清空聊天 ≠ 重置上下文——P1
【源】`clearChat` 只清展示层（store.mjs:161-164；orchestrator.mjs:325-327），确认文案自认“不影响 bot 的 omp 会话记忆”（app.js:744-746）。无停止/重建会话入口。
影响：用户以为“清空”等于重开，实际 bot 仍记得旧上下文，产生“记忆污染”。
改动量：中/大（需暴露 omp 会话重置）。
验收：提供“新建会话/重置记忆”，明确会否保留历史；两个动作可区分。

### F12 历史静默截断——P2
【源】私聊 chats 上限 400（store.mjs:154-158），exchanges 上限 500（store.mjs:135-139），room.log 进 prompt 只保留 60（constants.mjs:25）。UI 无“更早记录已省略”提示。
影响：长期使用后旧消息凭空消失，用户误以为数据损坏。
改动量：小（提示）/中（可配置）。
验收：列表顶部提示“仅显示最近 N 条”，或提供完整历史页。

### F13 群聊乐观插入可能瞬时重复——P3
【源】`send()` 先本地 push 用户消息进 room.log（app.js:443），relay 也会 appendRoomLog 并发 room_user_post 触发 loadAll（relay.mjs:55-58；app.js:534）。
影响：SSE 与本地状态竞争时可能出现短暂重复/闪动。
改动量：小。
验收：慢网下不出现重复气泡；以服务端为准收敛。

### F14 群成员按名字匹配——P3
【源】room_bot_post 用 `bot.name === event.bot` 反查成员（app.js:518）。
影响：改名或重名（服务端虽 409 防新建重名，但改名路径存在）会导致头像/身份错配。
改动量：小（用 id）。
验收：改名后群消息头像正确。

### F15 drawer 非模态、无焦点陷阱——P2（无障碍）
【源】#drawer 声明 role=dialog（index.html:109）但打开时未设置 `inert`/焦点陷阱；仅 modal 在 closeModal 切 inert（app.js:858-864）。drawer 打开后 Tab 可跑到底层侧栏与输入框。
影响：键盘/读屏用户会“跑出”对话框。
改动量：小/中。
验收：drawer 打开时焦点限制其中，Esc 关闭并还原焦点（已有 drawerReturn，app.js:723,790）。

### F16 chat-log aria-live 全量重渲染——P2（无障碍）
【源】#chat-log 为 aria-live=polite + aria-relevant=additions text（index.html:95），而 renderChat 每次事件 `replaceChildren` 重建全部节点（app.js:374-405）。
影响：读屏可能反复播报整段历史，噪声大。
改动量：中（增量 DOM 更新）。
验收：新增一条只播报该条。

### F17 无快捷键/命令面板——P2
【源】键盘处理仅 Enter/Shift+Enter 与 Escape（app.js:932-963）；无 Cmd/Ctrl+K 面板、无快捷键说明；移植的 palette 样式（ui.css:592 等）未接入。
影响：重度用户效率受限。
改动量：中。
验收：提供至少 Cmd+K 跳转会话 + Cmd+N 新建。

### F18 无 PWA manifest/离线——P3
【源】index.html 仅有 favicon/apple-touch-icon（index.html:8-9），无 manifest.json、无 service worker。
影响：移动浏览器“添加到主屏”体验弱、无离线壳。
改动量：小。
验收：可安装、有名称与图标。

### F19 打包版窗口图标取自 asar 路径——P2（风险）
【推断】`icon: join(app.getAppPath(), "web", "assets", "app-icon.png")`（desktop/main.mjs:100）；electron-builder.yml 设置 asar:true，app.getAppPath() 指向 asar 内路径，Electron 对 asar 内图标支持依版本而定，可能不显示。
影响：打包版任务栏/窗口图标可能缺失。
改动量：小（用 nativeImage.createFromPath 或放 extraResources）。
验收：安装版窗口与任务栏显示 omp-bot 图标。

### F20 打包版关闭 devTools，无诊断入口——P2
【源】webPreferences.devTools = !app.isPackaged（desktop/main.mjs:105）；无“查看日志/诊断”入口。
影响：线上问题无法自查，用户只能找开发者。
改动量：小（隐藏快捷键/帮助菜单项）。
验收：提供可选的诊断/日志导出。

### F21 桌面必须独占写锁，serve 在跑就打不开——P2
【源】store 用 pid 锁，第二实例 readonly；桌面发现 readonly 直接抛错退出（desktop/main.mjs:72-77；src/store.mjs:60-66）。
影响：用户开着 `serve` 就不能用桌面版，且没有“只读浏览”选项。
改动量：小（提供只读模式说明）/中。
验收：锁被占用时给出“以只读打开”或清晰指引，而非直接失败。

### F22 服务无鉴权——P2（已知，多用户场景为 P0）
【源】server 只监听 127.0.0.1（server.mjs:102-103；README【营销】已声明）。无 token/session。
影响：本机单用户可接受；一旦端口转发/多用户/浏览器扩展探测即无防护。
改动量：大（若确需）。
验收：若支持非本机访问，则强制 token。

### F23 仅整条复制，无代码块级复制/引用——P3
【源】复制按钮仅整条消息（app.js:336-360）；代码块无独立复制/折叠。
影响：从长回复里取一段代码不便。
改动量：小。
验收：代码块右上有复制按钮。

### F24 SSE 断线无重放——P2
【源】onerror 仅改标签为“连接中…”（app.js:487-490），依赖 EventSource 自动重连；onopen 重新 loadAll（app.js:479-486）。断线窗口内的群事件依赖 loadAll 兜底，但瞬时 room_bot_post 动画/note 可能丢失；无 Last-Event-ID 续传。
影响：网络抖动后可能漏掉一次群回合过程。
改动量：小/中。
验收：重连后群历史与服务端一致（已有 loadAll 兜底，补断线提示即可）。

### F25 用量不持久，CLI 易误导——P2
【源】usage 仅统计当前进程内 runtime（server.mjs:128-131；app.js:809），重启即清零；CLI 打印提示（ompbot.mjs runUsage）。README【营销】已说明。
影响：用户看不到跨天/跨会话累计花费。
改动量：中。
验收：用量按 bot 落盘并可在重启后查看。

### F26 忙时无排队，仅 409——P2
【源】chat POST 若 runtime busy 返回 409（server.mjs:174 附近）；但同页 UI 已禁用输入（app.js:411），跨标签/并发 API 才触发；无消息队列。
影响：并发使用（多标签）会丢消息。
改动量：中。
验收：忙时入队并顺序处理，或明确提示“已排队”。

### F27 删除 bot 不删磁盘会话，未充分提示——P3
【源】确认框写“其会话文件保留在磁盘”（app.js:772），orchestrator.removeBot 只动 store（orchestrator.mjs:83-89）。
影响：期望“彻底删除”的用户会留下残留。
改动量：小。
验收：删除时可选“同时删除会话文件”。

### F28 后端事件无前端消费者（契约缺口）——P2
【源】`user_to_bot`（orchestrator.mjs:305）、`exchange_reply`/`exchange_failed`（289/295）、`room_mentions`/`room_empty`（relay.mjs:64/134）在 app.js 的 handleEvent（app.js:497-548）中均无分支。
影响：@点名提示、群空提示、委派失败均不显示；部分事件纯属浪费带宽。
改动量：小。
验收：上述事件各自有 UI 呈现或被后端删除。

### F29 死常量 ROOM_BOT_ROUNDS——P3
【源】constants.mjs:22 导出 ROOM_BOT_ROUNDS=3，全仓无人引用；relay 实际用 ROOM_MAX_ROUNDS=12（relay.mjs 导入）。
影响：误导后续维护，暗示存在“bot 自发回合”能力但未实现。
改动量：小（删除或实现）。
验收：常量被使用或移除。

### F30 移植 CSS 大规模死代码——P3
【源】随包分发的 ui.css 含 dropzone/voice/palette/memory/头像编辑等规则（ui.css:328-330,370-393,493-497,592,661-664），app.js 零引用（grep 无命中）。
影响：包体增大、维护者误以为功能存在；亦为缺失能力的清单。
改动量：小（清理）/中（按需实现）。
验收：未使用规则移除，或对应功能接入。

## 4. 前后端契约与 DOM 不一致

1. 事件表不匹配：见 F28，后端 emit 多于前端 handle。
2. 终态返回 vs 流式期待：见 F2，API 是“一次性返回”，UI 文案却用“正在回复…”暗示连续性。
3. 私聊无 abort/DELETE-in-flight：DELETE /api/chat 只清历史（server.mjs:163-167），不中断生成，易被误解为“停止”。
4. 群 turn 上限：README【营销】称“@ 链有上限”，源码为 ROOM_MAX_ROUNDS=12、每成员点名 2（admin 4）（constants.mjs:18-28），UI 无任何“已收敛/达上限”提示（relay 仅 emit room_round_end.capped，app.js 未展示）。
5. room.log 语义：updateRoom 直接改不重建 runtime 的 room scope（orchestrator.mjs:122-134）；成员变更后旧 room runtime 的上下文与成员不同步，仅靠 prompt 重建（relay roomPrompt），存在短暂不一致【推断】。
6. 展示层 thinking 默认：GUI 空值经 orchestrator 解析为 defaultThinking（默认 "low"，orchestrator.mjs:70；server.mjs:startServer 默认 low），但桌面入口未显式传 defaultThinking（main.mjs:66-71），依赖服务默认值——链路脆弱【源+推断】。

## 5. 分发与更新生命周期

- 打包：package.json `package:win` = prepare-desktop.mjs（复制本机 omp.exe + OMP-LICENSE + VERSION 到 .desktop-runtime，scripts/prepare-desktop.mjs）→ electron-builder（electron-builder.yml）。产物 portable + nsis 安装版，未签名（README【营销】）。
- 运行时资源：files 含 desktop/main.mjs、src/**、web/**、package.json、README、LICENSE；extraResources 把 .desktop-runtime→runtime（electron-builder.yml:7-15）。findOmp 在打包时优先 `resources/runtime/omp.exe`（main.mjs:20-21）。
- 更新：无自动更新（F8）；无版本展示（package.json 0.1.0 未在 UI 暴露）；无崩溃上报/遥测。
- 单实例：requestSingleInstanceLock + second-instance 聚焦（main.mjs:48-59,55-59），但 second-instance 处理里对最小化/可见性判断为 `if (window.isMinimized()) window.restore(); if (window.isVisible()) window.focus();`——若被隐藏则不聚焦【源，小瑕疵】。
- 关闭语义：关窗即退出并停 bot（F7）；无“最小化到托盘/继续后台运行”。
- 数据兼容：state.version 有 migrate 兜底（store.mjs:170-177），但 GUI 无版本迁移提示。

## 6. 小改 vs 大改建议（按优先级）

一期（直接决定留存，多为大改但价值最高）：F1 停止生成、F2 流式、F4 重试/编辑/重新生成、F7 通知/托盘/后台、F9 首次启动引导。
二期（体验补齐，小到中改）：F5 附件/图片/音频、F6 搜索/导出、F10 模型刷新、F11 新会话/重置记忆、F3 tool 进度、F26 忙时排队。
三期（打磨，多为小改）：F12 截断提示、F14 id 匹配、F15 drawer 焦点陷阱、F16 增量 aria、F17 快捷键、F19 图标、F20 诊断、F21 只读模式、F23 代码块复制、F24 断线提示、F25 用量持久化、F27 删除提示、F28 事件消费者、F29/F30 死代码清理、F18 PWA。
大改（若确需多用户）：F22 鉴权。

## 7. 未知项与未能验证

- 未运行应用，所有“实际表现”均为源码推断；渲染动画、性能、真实模型行为未实测（母 agent 负责运行时验证）。
- 竞品（OpenMausBot / Meta Muse / xAI Grok Bot / OpenAI Dots）未做任何实测或源码核验，本文件不含对其行为的断言；相关差距描述仅基于本产品缺口，不构成竞品能力主张。
- omp 本体能力（RPC 是否支持中断/流式增量）未在本仓验证：src/rpc-client.mjs 是否有 abort/stream 能力未在本审计范围内通读，F1/F2 的可行实现依赖 omp 侧支持，需上游确认。
- 打包产物图标在 asar 下的真实表现未实测（F19）。
- 未检查 test/、smoke-*.mjs 的运行时结果（只读抽查了 smoke-gui.mjs 断言，确认契约测试未覆盖 stop/流式/附件）。

## 8. 主要阅读来源

- README.md（【营销】自述，与源码核对后使用）
- desktop/main.mjs
- web/index.html、web/app.js、web/style.css
- ompbot.mjs
- src/server.mjs、src/orchestrator.mjs、src/store.mjs、src/bot.mjs、src/relay.mjs、src/constants.mjs
- scripts/prepare-desktop.mjs、package.json、electron-builder.yml
- web/vendor/README.md、web/vendor/ds-bot/ui.css
- smoke-gui.mjs（契约断言抽样）
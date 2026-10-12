# OpenMausBot 竞品差距研究（只读，2026-10-12）

## 0. 方法与快照

- 对象：`github.com/milind-soni/OpenMausBot`（原名 OpenGrokBot / 亦称 MausBot）与 `openmausbot.com`（抓取时 302 到 `mausbot.com`）。
- 快照：最新 release **v0.1.107**（published 2026-10-10T18:03Z，tag 指向 commit `978993c84e2ec17144fcf46e7bfa1e04c9f32a4b`，来源 https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest ）；仓库页快照 4532 stars / 776 forks / 379 issues（https://github.com/milind-soni/OpenMausBot ）；本次源码取证来自 `--depth 1` 只读临时 clone，`main` HEAD = `83c10b3908f29c60a49b7e3c5d76f2db7529db45`。未安装、未构建、未运行该产品。
- 标注：**【文宣】**=官网/README 营销表述，未验证；**【文档】**=仓库内官方文档（维护者自述行为）；**【源码】**=仓库源码可核（给出路径）；**【推断】**=我方推理。
- **全局未实测声明**：本报告中没有一条竞品行为经过我真机运行验证；凡涉 UI 实际观感、延迟、稳定性者一律按【文档】/【文宣】处理。抓取事实：`openmausbot.com` 首页请求被重定向到 `mausbot.com`（reader 返回的落点 URL 与正文均为 mausbot.com），故官网引文以 `mausbot.com` 为准。
- 引用简写：`R`=仓库 README；`D/<f>`=`https://github.com/milind-soni/OpenMausBot/blob/main/docs/<f>`；`A/<p>`=`https://github.com/milind-soni/OpenMausBot/blob/main/apps/docs/content/docs/<p>`；`W/`=`https://mausbot.com/`（`/pro`、`/pricing`）。
- **修正（重要）**：本机 `omp` 运行时（v18.10.0）**本身已有** `read/bash/edit/eval/glob/grep/task/wait/todo/web_search/write` 工具、可经 `eval` 驱动浏览器，并支持 `--tools/--no-tools/--no-skills/--no-extensions/--approval-mode` 等开关（root 只读验证，见 `docs/research/2026-10-12-runtime-evidence.md`）。因此下文中「无连接器/MCP/浏览器」一律指**产品编排层**没有对应的托管、授权、审计与可视化面，**不是**「底层没有工具能力」。凡属此类的差距等级已相应下调。

## 1. 能力矩阵（25 行）

| # | 维度 | OpenMausBot（能力 + 证据级别） | 主要来源 | 我方现状（本地行号） | 差距 |
|---|---|---|---|---|---|
| 1 | 产品形态 | Electron 桌面（macOS arm64/Intel、Windows x64、Ubuntu 24.04 x64）+ 自托管 web + iOS/Android 伴侣 + `npx openmausbot` CLI【文宣】【文档】 | R「Quick start」「Run from a terminal or on a server」；A/mobile/*；D/cli-onboarding.md | 仅 Windows Electron 便携/安装版 + 浏览器 GUI + CLI（`README.md:1-8,30-58`） | 大 |
| 2 | 发行与签名 | macOS 已签名+公证；Windows 安装包**未做代码签名**（SmartScreen 提示）；Ubuntu 标 beta | R「Desktop capability status」 | 安装包未做 Authenticode 签名（`README.md:34`） | 相同（双方同短板） |
| 3 | 首次上手 | CLI 向导选择接入、登录或 key、模型和手机配对，桌面有引擎检查与引导 | D/cli-onboarding.md；D/cloud-pro.md | Windows 桌面包已内置 Electron、Node 后端和 OMP，不需另装 Node 或 OMP。模型认证仍使用本机 OMP 配置，应用内缺认证向导，网页与 CLI 路径需要已有 OMP（README.md:24-38） | 大，差距在认证与首任务引导 |
| 4 | 引擎/模型广度 | claude、codex、grok CLI + ACP 家族（Cursor、Antigravity、Gemini CLI、Qwen Code、OpenCode、Pi）+ OpenAI 兼容/OpenRouter/MiniMax/Mistral 等；每 bot 一模型、可会话中切换；自定义 CLI/端点零代码接入 | R「Features/Status」；D/approval-levels.md:136-160；D/custom-engines.md | 仅 omp 自身模型；每 bot 可设模型/思考档（`README.md:57`, `src/bot.mjs` 启动参数） | 中（差距在「多引擎家族」而非模型数） |
| 5 | Bot 身份/工作区 | bot=持久身份，`~/.openmausbot/workspaces/<botId>/` 私有工作区（默认 cwd），threads/folders/teams 组织，bots 可含 skills/记忆/工具授权 | D/memory.md:17-41；A/features/bots-and-tasks.mdx；A/features/chat-and-teams.mdx | bot=一个 `omp --mode rpc` 子进程 + 每 (bot,scope) 会话上下文 + 独立 cwd/persona/overlay（`README.md:100-135`） | 中 |
| 6 | 每 bot 一台计算机 | 四类执行体：Boat 云桌面（第三方付费）、Local VM（Docker/Podman 容器化 Linux 桌面，`maxInstances`）、自带 VPS（SSH 别名驱动远端 Docker）、本机桌面（Cua Driver）；Linux 上 Wayland 主机控制**硬关闭** | A/computers/*.mdx；D/computer-use-integration.md:10-38；R「Desktop capability status」 | 无；bot 直接在宿主 cwd 跑工具（`README.md:165`） | 大 |
| 7 | 浏览器 | 三档：默认内嵌 `WebContentsView` CDP（每 bot `persist:bot-<id>` 分区、零安装）、可选真实 Chrome 扩展桥、可选 playwright-mcp；已知限制：内嵌 webview 下 Google OAuth 被挡 | D/computer-use-integration.md:145-168 | **产品无浏览器面**：底层 omp 有 `eval` 等工具可自行驱动浏览器（runtime-evidence），但编排层没有浏览器窗格、每 bot 会话分区、人工接管/暂停/交还登录的入口（`ompbot.mjs:137` 只是打开本机 GUI 浏览器；`desktop/main.mjs` 只建 Electron 窗口） | 中-大（工具在，产品化不在） |
| 8 | 审批/自治 | 五档 `ask/edits/auto/full/custom`，**逐档直通各 provider 原生权限模式，应用侧不做安全判定**；Full 只能在本地打包桌面 App 内开启（经私有进程通道，web/远程模式下隐藏）；Chief of Staff 档位可下传到被委派线程；问题卡永不自动回答 | https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/shared/approval-mode.ts ；D/approval-levels.md:1-61,115-176 | **无审批层**：`src` 检索 `approv|permission|sandbox|yolo|bypass` 零命中；bot 拿全部 omp 工具直接执行 | 极大（P0） |
| 9 | 审批可视化/审计 | 会话内联卡（Allow once / Always allow this session / Deny）+ Inspector + 决策日志（`decisions.retentionDays`）+ 一行动作回执与 **Undo**；拒绝后不换路径重试 | A/features/approvals-and-inspector.mdx；D/approval-levels.md:62-114 | 无 | 极大（P0） |
| 10 | 产物与实时可见 | bot 的云/VM 桌面可看实时画面并「Open desktop」接管；截图（settle-time）折回 transcript；每回合 shadow-git checkpoint 列出改动文件；附件库（图/文档/语音 note）；**没有独立 artifact 面板**（全仓检索 `artifact` 仅命中「turn artifact（截图）」与安装包字样） | D/computer-use-integration.md；`src/state/store.tsx:2030`；A/features/attachments-and-search.mdx | 纯文本 transcript；无产物面 | 大 |
| 11 | 连接器 | Composio Session，一键市场（Gmail/Slack/GitHub/Notion/Linear…「500+」【文宣】），多账号带别名、每 toolkit 上限 5；**每 bot 工具级授权**（All/精确清单/None），未授权工具不给模型，每次 allow/deny 写决策日志 | D/composio.md；R「Connected apps」 | **产品无托管连接器面**：编排层团队工具只有 `message_bot`/`list_bots`（`src/orchestrator.mjs:196-206`）；宿主 omp 自带 skills/插件能力（`--no-skills/--no-extensions` 开关存在，runtime-evidence），但**编排层不做授权、授予、审计** | 大 |
| 12 | 自定义 MCP | 用户零代码加 MCP server；组织级 MCP 策略；远端 MCP 的连接槽（值不随包走） | D/custom-mcp-servers.md；D/team-sharing.md:30-52 | 无产品级 MCP 注册/授权/策略面（宿主 omp 的扩展能力不由产品管理；编排层无开关、无 grant） | 中-大 |
| 13 | 触发/例程 | 一次性/间隔（5–1440 分钟）/工作日/cron 五段（含 `L`/`W`/`#`，需 IANA 时区，Croner 计算）；错过 12 小时内补跑一次；Webhook 独立接收器 `127.0.0.1:8800`（Bearer 优先或 capability URL）；运行收据区分 queued/active/waiting/completed/missed/failed/cancelled；「记住上一次运行」 | D/routine-schedules.md；A/features/automation.mdx；R「Routines and webhook triggers」 | 无（检索 `src` 无 schedule/cron） | 极大（P0） |
| 14 | 通知/主动性 | 「主动性=显式触发器」：仅 approval/question/needs-hands/finished/routine-failed 事件通知，**无后台心跳自造任务**；通知带 bot+精确 thread 定位；窗口聚焦时抑制；iOS 关闭态推送待 APNs | D/notification-and-proactivity-qa.md | 无 | 中 |
| 15 | 记忆 | `MEMORY.md` 前 **200 行或 24 KB**（`server/workspace.ts:45-46`）进系统提示；topic 文件按需读；每轮自动 recall（最多 4 笔记+4 会话片段）；capture/upkeep 自动整理并归档；**变更日志 + 一键 Undo**；写入 `0600`、原子写、凭据形文本落盘前脱敏；跨会话「recent-work brief」 | D/memory.md:42-105,106-176,227-251；`server/workspace.ts:45-46` | **记忆后端被有意关闭**（`memory.backend: off` + `autolearn: false`，`src/persona.mjs:70-78`），常驻记忆仅靠会话续接（`README.md:165`） | 大（但方向性差异：我方以隔离换安全） |
| 16 | 多 bot 协作 | 群聊、delegate_bot、coordinate_bots、Chief of Staff、Team incidents 与 session_search，范围由产品授权 | A/features/chat-and-teams.mdx；D/team-incidents.md | admin/everyone 群 relay、@点名、PASS、同步 message_bot、MAX_HOPS=6 与 busy 拒绝。实际 relay 上限为 ROOM_MAX_ROUNDS=12，ROOM_BOT_ROUNDS=3 未使用（src/constants.mjs:22、28；src/relay.mjs:93） | 中，缺持久交接与失败上报 |
| 17 | 团队模板/共享 | BotMRR 一键装队 + `openmaus.package` v2 单文件（bots/skills/group chats/routines/Chief/连接槽/启动笔记）；导入全量**加性**、bot 落 Ask、skills 关、routines 暂停；导出绝不含聊天/密钥/模型/计算机 | R「Install a complete team…」「Share a whole team」；D/team-sharing.md:1-105 | 无导出/模板 | 大 |
| 18 | 组织/多用户 | 组织库（Admin 发包、桌面一键装）+ 管理员活动日志（`admin-activity/YYYY-MM.ndjson` 0600、值脱敏、CSV 导出）+ 企业 entitlement：`whitelabel`/`sso`(planned)/`admin`/**`budgets`（月度花费上限，到顶即拒所有回合）**/`billing`（按模型定价+计费列） | D/self-hosting.md:869-940；`enterprise/FEATURES`；`LICENSING.md` | 单用户；无登录/鉴权（`README.md:169`）；单写者 pid 锁（`src/store.mjs:59-74`, `README.md:166`） | 大 |
| 19 | 常驻/远程 | `serve`/`service install`/Docker/Tailscale/托管隧道；设备配对（一次性 5 分钟码，手机仅 chat+approval）；付费 MausBot Cloud：Personal $29 / Pro $49 / Max $99（1/4/8 并发电脑、50/200/500 电脑小时、约 30 分钟/1 小时/3 小时语音、10/50/100 GB） | D/cli-onboarding.md:34-52；D/self-hosting.md:1-63；W/pro、W/pricing | 仅 `127.0.0.1`，服务必须前台常驻（`README.md:53`；`src/server.mjs:45,241`） | 大 |
| 20 | 凭据 | 打包桌面用 OS 级 `safeStorage` 加密、UI 只见 configured 布尔、密钥写只写；CLI API key 为**明文** `config.json`(0600)、`tunnel-account.json` 同；每 provider 环境变量按需注入；Composio 令牌归 Composio | D/cli-onboarding.md:78-86；D/composio.md:5-20；A/security/permissions-and-secrets.mdx | 未做密钥管理；子进程继承**全量** `process.env`（`src/rpc-client.mjs:58`；见 `docs/research/2026-10-12-local-core.md` F2） | 大 |
| 21 | 成本/额度 | 用量账本区分 uncached/cached input 与 output，能报则报，未报则按内置价目表**估算**并标 `costSource: estimated`；企业额度可设月度上限；语音按 utterance 服务端截断；自认 **无语音花费计量**；Cloud 为 fair-use 配额 | A/features/chat-and-teams.mdx；D/self-hosting.md:914-937；D/voice-mode.md:104-107 | `usage` 仅进程内汇总（`src/usage.mjs`，`README.md:135,150`） | 中 |
| 22 | 导出/备份/恢复 | ①团队导出；②`Settings→Backups` 全量加密 `.ombbackup`（含消息/附件/记忆/skills/routines；**不含凭据/连接**；上限 10 GB/10 万条；导入前校验+`REPLACE`+旧数据留 `.backups/safety-<id>/`）；③桌面「Copy this computer here」直传服务器并留 Swap back；④每回合 shadow-git checkpoint 列改动文件；⑤编辑早前消息=新分支，不续接陈旧 provider 会话；routines/webhook 恢复后暂停 | A/self-hosting/data-and-backups.mdx；`server/checkpoints.ts:1-24`；A/features/chat-and-teams.mdx「Rewind and branches」 | 仅 `state.json` 原子写+pid 锁；无导出、无备份、无 checkpoint、无分支（`README.md:104-113`） | 大 |
| 23 | 语音 | TTS 五选（ElevenLabs/Fish Audio/Grok xAI/Mac 内置/本地 Chatterbox）；可对单条回复朗读或自动朗读；call 模式半双工（麦克风仅在 bot 不说话时开）、审批语音确认（非明确 yes/no 一律重问）、工具活动旁白；**通话仅 macOS**（Live call 走 OpenAI key 可跨平台）；rooms 尚不能说话 | D/voice-mode.md:1-124；R「Bots that talk back」 | 无 | 大 |
| 24 | 安全边界/已知风险 | 服务只听 127.0.0.1；loopback 匿名读可用、变更需桌面私有能力或配对会话；**未修已知项**：bot 的 shell 可借 Slack worker 的 guarded 路由向已存在 Full-access 线程投递/开启线程以绕过审批卡（计划用 worker-only relay token 修）；Wayland 主机控制禁用；共享机上同 OS 用户互信 | `SECURITY.md`；R「Desktop capability status」 | 无 Origin/Host/CSRF 校验，无鉴权（`docs/research/2026-10-12-local-core.md` F3） | 大 |
| 25 | 质量/工程门 | CI 多 workflow（docker/npm-package/package-win-linux/browser-vendor/shared-terminal-smoke/ci-stop-closed）；`pnpm typecheck|test|build`；release 有「updater migration invariant」与 bundled browser gate；718 个 `server/*.ts` 内含大量 *.test.ts | R；D/releasing.md；D/ci.md | `npm test` 跑 6 个真实模型 smoke + 纯函数单测（`README.md:145-160`） | 中（我方 smoke 依赖真实模型，慢且非确定） |

## 2. 关键边界结论（逐条给证据）

1. **审批不是「应用侧安全判定」，而是 provider 权限模式的透传**；应用自己只做两件事——Full access 下代答残余原生 prompt，以及「Approve for me」放行 web search。源码注释与 `APPROVAL_MODES` 定义见 `shared/approval-mode.ts`（primary URL 如上）；文档 D/approval-levels.md:1-8 明确「OpenMausBot does not judge an action itself: there is no app-side allowlist, classifier, or pattern rule」。
2. **Full/Custom 有硬件式闸门**：只能从打包的本地桌面 App 开启，走私有进程通道而非 bot 可访问的 HTTP API，且在 dev/纯 web/远程页隐藏（D/approval-levels.md:36-46）。持久化还带两阶段授权标记：未获 Electron 确认前，存储的高档位只能以 Ask 执行（`shared/approval-mode.ts` 的 `approvalGrant`/`approvalFor`，未知值一律 fail-closed 到 Ask）。
3. **例程/Webhook 不是托管服务**：App 不运行就不派发，休眠机器不唤醒（cron 可 `Keep this computer awake`，合盖仍睡）；真 24/7 靠 VPS 或付费 Cloud（D/routine-schedules.md:47-60；A/features/automation.mdx「Callout warn」）。Webhook 接收器只暴露 `/health` 与 `/hooks/...`，需要公网时只能单独反代该端口。
4. **记忆是文件+预算制**：200 行/24 KB 硬预算、超预算自动归档、每次写入原子且脱敏凭据形文本、变更日志在 workspace 之外（bot 改不到）。这是可审计但**有限容量**的设计（D/memory.md:42-105,227-251）。
5. **「活跃度」被刻意限制**：无后台心跳；无人在场的回合（webhook/routine/他 bot）在决策日志里被标记「nobody was at the keyboard」（D/approval-levels.md:56-61）。
6. **可选付费边界清晰**：app 本体 Apache-2.0 + `enterprise/` source-available（生产需 license key，白标/代运营需 partner 协议；删掉该目录即纯 OSS 版，`LICENSING.md`）。Cloud 只卖机器/电脑/语音/调度/支持，不卖模型（W/pro FAQ）。
7. **诚实披露的短板**：Windows 安装包未签名、Ubuntu beta、Wayland 禁用、iOS 关闭态推送缺 APNs、内嵌浏览器下 Google OAuth 被挡、通话仅 macOS、语音无花费计量、rooms 不能说话、hosted/mobile 连接仍在建（R「Status」；D/voice-mode.md:95-107；D/computer-use-integration.md:145-168）。
8. **建仓速度即为竞品压力**：release 已到 0.1.107（Docker/npm/多平台安装器全套），open issue 前 10 条里有 6 条是 10-09~10-11 新报的真问题（含 Windows 预览、browser tools not installed、远程 MCP 登录跳转失败），failure 面被社区实时暴露（https://github.com/milind-soni/OpenMausBot/issues ）。

## 3. 对 omp-bot 的差距（G）与我方证据

- **G1 无审批/自治梯度（P0）**：`src` 全目录检索 `approv|permission|sandbox|yolo|bypass` 零命中；bot 子进程不带任何工具裁剪或权限标志（`src/bot.mjs:79-88` 起参数只有 persona/overlay/model/thinking）。竞品提供 5 档 + 原生映射 + 决策日志 + Undo。
- **G2 无调度与事件触发（P0）**：`src` 检索 `schedule|cron|webhook` 零命中；只有「人来消息才跑」。竞品有 cron/间隔/工作日 + 独立 webhook 接收器 + 补跑策略 + 运行收据。
- **G3 无任务台账/可恢复执行（P0）**：一次回合就是任务，无 job 表、无重试记录、进程重启后无 in-flight 状态（`README.md:104-113`；`src/store.mjs` 只存 bots/rooms/exchanges/chats）。
- **G4 无产物面与实时可观测（P1）**：产物只有聊天气泡文本；竞品有桌面实时预览/接管、settle-time 截图折回、每回合改动文件 diff（`server/checkpoints.ts`）。
- **G5 无产品托管连接器/技能面（P1）**：编排层团队工具仅 `message_bot`/`list_bots`（`src/orchestrator.mjs:196-206`）；宿主 omp 自身有 skills/插件与工具（runtime-evidence），但产品不做**连接授权（grant）、按 bot 工具裁剪、技能启用管理、拒绝审计**——这正是竞品「未授权工具不下发给模型 + 每次 allow/deny 写日志」的同一层（D/composio.md「Per-bot tool grants」）。
- **G6 记忆被关闭而非治理（P1）**：memory.backend off 与 autolearn false 阻止共享库污染，但 --continue 仍可跨进程续接历史，不能写成完全没有跨会话记忆。差距是没有独立偏好和工作笔记管理、编辑、遗忘、来源与容量可见的治理面。
- **G7 无远程/常驻与多端（P1）**：仅 127.0.0.1 前台（`src/server.mjs:45,241`），无配对、无手机、无隧道；竞品有 `serve`+Docker+Tailscale+配对+Cloud。
- **G8 凭据与进程边界过宽（P0/P1）**：子进程继承全量 `process.env`（`src/rpc-client.mjs:58`）且默认拿到全部 omp 工具、shell 可读宿主 FS；omp 已提供 `--tools/--no-tools/--no-skills/--no-extensions/--approval-mode` 可复用（runtime-evidence），但产品**一个都没传**（`src/bot.mjs:79-88`）。竞品有 per-provider 环境注入、写只写密钥、OS safeStorage。
- **G9 无成本治理（P2）**：`src/usage.mjs` 只在进程内汇总，重启即丢；竞品有持久账本 + 估算 + 企业上限。
- **G10 无备份/导出/模板（P2）**：`README.md` 无任何导出提及；竞品三套（团队包 / 全量加密备份 / 直传服务器）+ 安全回退目录。
- **G11 分发与运维面（P2）**：我方已提供内置 OMP 的 Windows 安装包与便携包，缺应用内认证引导、更新流程与其他平台发布。OpenMausBot 有多平台、npm 与服务部署；两者 Windows 安装包都未签名。
- **G12 多 bot 协调层（P2）**：我方 hop、busy 与错误回执明确，但没有共同负载实验，不能宣称优于竞品。实际缺口为任务所有者、失败上报、持久 inbox 和跨线程检索。

## 4. 建议优先级与验收标准

**P0（不做则不能托管长任务）**
1. 动作闸门/审批层：在 host tool 调用点前插策略中间件（allow/ask/handoff 三态），默认对写/外发 ask，带审批卡片与决策记录。验收：三态单测；一条外发动作必产生审批记录；被拒后不得改道重试；「Always allow」仅限当会话且绑定具体工具。
2. 调度 + 事件触发：cron/间隔调度器 + 本地 webhook 接收器（独立端口、仅 `/hooks/*`、Bearer 优先）。验收：关掉 GUI 只留服务时仍按点触发；pause/cancel 与「停止当前回合」解耦；错过窗口有补跑或 missed 收据。
3. 持久任务台账：Activity（进行中/等待输入/完成/失败）+ 运行收据。验收：每次 bot 回合与投递都有可查询行；进程重启后台账与 in-flight 状态不丢。

**P1**
4. 每轮 checkpoint（shadow git，落 `$OMPBOT_HOME/checkpoints/`）+ 「本回合改了哪些文件」列出与会话内 undo。
5. 凭据边界：子进程 env 白名单 + 复用 omp 已有开关做工具裁剪（`--no-tools`/`--tools`/显式 host tool 白名单；`--approval-mode` 语义待先验证再定去留）。验收：子进程 env dump 不含非白名单键；「写 ../../secret」探针被拒。
6. MCP 连接器入口（先只读工具），并给每 bot 工具级授权 + 拒绝记录。
7. 解耦「隔离」与「无记忆」：每 bot 独立、可整体删除的笔记层，容量预算可见（对齐竞品 200 行/24 KB 的显式契约）。

**P2**
8. 远程/常驻：`serve --host` + token/Origin 校验 + 配对码；GUI 鉴权。
9. 用量账本持久化 + 月度上限（拒绝回合）。
10. 团队包导入/导出（严格白名单字段，密钥/聊天绝不出包；导入默认 Ask+暂停）。
11. 多 bot 协调者（现状 `MAX_HOPS` 保留）：失败/停滞上报与限于 2 次的重试，1 小时噪声静音。

**不该做的**（对齐竞品教训）：不要在无审批层时先上云常驻执行体或堆连接器生态；不要引入应用侧「安全分类器」去代替 provider 原生权限模式（竞品明确不做，且其审批语义由各家 CLI 决定）。

## 5. 未知（无法从一手来源确认）

- 竞品 UI 实感、真实延迟、崩溃率：需真机运行，本报告全部未实测。
- 「500+ apps」「hundreds more」为官网/README 口径（【文宣】），未在源码中清点具体数量。
- Cloud 后端 Admin（`openmaus-cloud`）不在本仓库，其计费/限流实现不可核（D/cloud-pro.md:20-30 自述为三方契约）。
- 我方 bot 运行时（omp v18.10.0）已有 `--approval-mode` 开关，但它的语义（是否等价于「需人工确认的逐动作闸门」）尚未验证，本任务只做了参数存在性确认；其余关于 omp 能力的结论引自 `docs/research/2026-10-12-runtime-evidence.md`（root 只读验证），非我本人复现。
- iOS/Android 伴侣、MausBot Cloud 控制台、`cloud.openmausbot.com` 均未抓取（未支付账户）。
- 抓取受阻：无。官网 `openmausbot.com` 仅发生重定向到 `mausbot.com`；GitHub 页面与 raw 文件均可直读。

## 6. 已读来源

- https://github.com/milind-soni/OpenMausBot （README 全文 604 行）
- https://api.github.com/repos/milind-soni/OpenMausBot/releases/latest
- https://github.com/milind-soni/OpenMausBot/issues （开放 issue 列表）
- https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/shared/approval-mode.ts
- 只读 clone（`main` HEAD `83c10b39…`）内：`LICENSING.md`、`SECURITY.md`、`enterprise/FEATURES`、`server/workspace.ts`、`server/checkpoints.ts`、`server/auto-approve.ts`、`docs/{approval-levels,memory,routine-schedules,computer-use-integration,voice-mode,team-sharing,composio,cli-onboarding,team-incidents,notification-and-proactivity-qa,self-hosting,cloud-pro}.md`、`apps/docs/content/docs/{computers/local-vm,computers/cloud-and-vps,features/approvals-and-inspector,features/automation,features/bots-and-tasks,features/chat-and-teams,features/attachments-and-search,self-hosting/data-and-backups,security/permissions-and-secrets}.mdx`、`src/state/store.tsx`
- https://mausbot.com/ 、https://mausbot.com/pro 、https://mausbot.com/pricing
- 本地：`README.md`、`src/{constants,server,persona,store,bot,orchestrator,rpc-client}.mjs`、`docs/research/2026-10-12-local-core.md`、`docs/research/2026-10-12-runtime-evidence.md`（本机 omp v18.10.0 运行时能力，root 只读验证）

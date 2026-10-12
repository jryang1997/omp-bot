# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，版本号用 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

OMP 原生优先的工作台改造：把「一次性聊天」升级成有台账、能停、能审批、能后台跑的产品，同时不重造 OMP 已经负责的模型循环、压缩、技能、浏览器与子代理。

### 新增

- **Run 台账**：`node:sqlite` 记录每次运行的状态、事件游标、每 Run 用量与产品记录（附件、成果、计划、审批、设置）。OMP 的 session JSONL 仍是模型历史的唯一权威，台账只是有限重放与展示投影。
- **原生增量与取消**：RPC 帧级事件、`cancelRun` 等到确实停下（级联宿主工具、子 Run 与 OMP subagent），`steerRun` 中途补话不新开并行运行。
- **原生审批桥**：plain rpc-ui 下真实的 `extension_ui_request` 映射为工作台审批记录，`approvals respond`/GUI 给出真实回答；不把 recommended 当用户输入，没有回答就不上行确认。
- **CLI**：`runs list|get|stop|steer`、`approvals list|respond`、`session new`、`routines list|add|get|pause|resume|rm|run`、`settings show|set`、`template export|import`、`backup`、`version`。旧命令（`bots`/`room`/`chat`/`say`/`demo`/`interactive`/`serve`）保留，内部改走同一套 Run。
- **CLI 跨进程控制**：同一个数据目录只有一个写者。`serve`/桌面版正在跑时，CLI 把运行、审批、会话、计划、设置与模板命令发给那个进程的本机 HTTP API（地址与凭证来自服务写在数据目录里的 `runtime.json`，只在「进程活着且写锁 pid/nonce 一致」时采用，或用显式 `--url`/`OMPBOT_TOKEN`），不启第二个引擎；`chat`/`say` 这类需要独占引擎的命令仍在本进程跑。拿不到持有者时，停止/审批等命令**如实拒绝并非零退出**（绝不打印「已停止」），读取类命令照常可用，`backup` 在有别的进程写库时拒绝以免给出不一致副本。token 不打印、不写日志。
- **桌面版**：关闭窗口只隐藏（托盘 + 「窗口」菜单可恢复），显式退出先停正在进行的运行再释放数据锁；运行完成/待输入/失败弹原生通知，窗口在前台时不重复打扰。
- **菜单里的原生命令**：模型登录走 `omp login`，帮助走 `omp --help`，版本走 `omp --version`，诊断显示运行时版本、node:sqlite 可用性、OMP 路径/版本与数据目录锁状态；应用不接触、不打印任何密钥或 token。
- **团队模板导入导出**：白名单只带身份与任务描述，导入是加性的、计划一律暂停、不带任何授权；`backup` 在停服务落盘后复制整个数据目录。
- **打包 provenance**：构建时记录内置 OMP 的版本、来源路径与 sha256（`resources/runtime/PROVENANCE.json`），本机 OMP 低于 18.10 直接构建失败。
- **工作台界面**：任务筛选、原生文本与工具过程、子任务模型和用量、附件选择与图片预览、成果下载、运行详情、计划、MCP、技能及设备/飞书面板。OMP 18.10 异步子任务读取 task/wait 的真实 progress/jobs，完成快照缺省字段保留最后一次实际用量；无回退时不显示回退标签。
- **浏览器验收修复**：附件选择器入口、飞书 PUT 与入站状态、独立抽屉刷新、reconciliation_required 终态、分页重放、token 预算 maxTokens 保存与回显。清除 token 额度保留费用限制。
- **飞书配置入口**：补齐 App ID、秘密输入框、固定回调端口与身份映射保存，公开状态只返回非秘密配置。实测保存后秘密输入清空、未自动启用、状态不回显凭据；Channels 25/25。

### 变更

- **运行要求**：Node ≥ 24（台账用内置 `node:sqlite`），OMP ≥ 18.10。CLI 与桌面版启动前都做本机兼容检查，不满足直接报错。
- **HTTP 边界**：`/api` 要求同源有效会话 cookie 或 Bearer token，校验 Host/Origin/Content-Type；网页引导用一次性 local token 换成 HttpOnly `SameSite=Strict` 会话 cookie，SSE 不再通过可记录的 query 传长期凭证。
- **CLI 审批语义**：`interactive` 在终端问真实的人；一次性命令默认失败关闭并停止该运行，只有显式 `--approve`/`--answers` 才代为回答；凭据类请求永不由 CLI 代填。
- **权限档**：Bot 增加 `executionMode`（默认 `supervised`）、`approvalMode`（默认 `write`）、预算、记忆开关、技能过滤与工作区。预算按核心唯一契约存对象 `{maxTokens, maxCostUsd, maxTimeMs, maxConcurrency}`（`null` = 不设限），CLI 的 `--budget N` 写 `{maxTokens:N}`、`--budget none` 清除、`--max-cost-usd/--max-time-ms/--max-concurrency` 合并写入，标量或未知键被明确拒绝而不是当成无限制。`full`/`yolo` 必须由用户显式确认（CLI 需要 `--confirm-execution-mode`/`--confirm-approval-mode`，HTTP 需要同名确认字段），导入模板绝不携带这些授权。

### 修复

- 关停期间晚到的 Run 收尾不再把「Ledger 已关闭」抛成未捕获拒绝而崩掉进程；群 Run 的成果登记改为如实跳过（没有单归属 Bot），不再报 `run.botId 必填`。

### 升级注意

- 老的 `state.json` 不删、不改语义，Bot 与群的 id 保持；台账在旁边新建 `workbench.sqlite`，历史 session 不迁移也不改写。
- 同一 `OMPBOT_HOME` 不会被两个进程同时写：第二个只读，桌面版会提示先关闭占用的 CLI/`serve`。
- 原生的 checkpoint/rewind 只管对话，不还原文件系统；工作区快照是另一件事，不要把它当回滚。
- `cancelRun` 只停本机执行与后续步骤，已经发出的外部动作（发送、发布）无法撤回。

### 未验证前置项

- Windows 安装包没有 Authenticode 证书，也没有发布源：不做自动更新，也没法在这里验证签名与更新链路。
- 本机没有经过验证的 Windows 沙箱，因此不提供 `sandbox` 模式；`full` 是明确的安全降级。
- 真实飞书账号、公网 HTTPS 回调、跨手机访问与远端节点未验证。本地配对、范围权限、撤销、飞书验签/去重/投递和失败记录已实现并通过本地检查。
- 原生隔离记忆需要认证代理或专用 profile，当前保持关闭。浏览器跨设备可视接管、Windows 系统通知实际投递、安装/卸载与更新链路未验收。
- 三场景 30 次真实模型资料到成果验收全部通过。资源结果是当前版本基线，不声称提速或降低内存；详见 docs/research/2026-10-12-implementation-verification.md。

## [0.1.0] - 2026-10-11

首个版本：把 omp 包成一支常驻 bot 团队。

- 多 bot 花名册、群聊 relay（admin/everyone、@点名、`[PASS]` 收敛）、bot→bot `message_bot` 委派与 hop/busy 防死锁。
- 每个 bot 每 scope 一个 `omp --mode rpc` 子进程：会话续接、原生压缩、独立 cwd 与隔离 overlay（屏蔽用户全局上下文与共享记忆后端）。
- 网页控制台（静态 + JSON API + SSE）、CLI（`bots`/`room`/`chat`/`say`/`demo`/`interactive`）、Electron 桌面应用与 Windows 便携/安装包（内置 OMP）。

# OMP 原生工作台实施与验收

本轮已把竞品调研中的 A-H 工作包接入现有产品。默认保持本地执行、原生审批和单写者数据目录。模型循环、会话、压缩、技能装载、MCP 和子代理由 OMP 负责，工作台提供运行管理、授权入口与成果领取。

本报告描述本地可验证交付。飞书真实账号、公网回调、跨手机访问、远端节点和发布证书仍缺前置条件。本机私有记忆与本地浏览器人工接管已完成真实运行验收。

## 工作包状态

| 工作包 | 已交付行为 | 验收与边界 |
|---|---|---|
| A 运行契约与 HTTP | startRun 同步落库并原子预留 scope，合法请求走同一执行路径。Cookie 或 Bearer 鉴权，Host、Origin、Content-Type、路径和请求体检查 | HTTP 边界 83/83，GUI API 55/55。默认回环监听，无公网隧道 |
| B 增量与控制 | 原生文本、思考、工具、task/wait 子任务进度，停止、补话、新会话、事件分页重放 | 真 OMP 长工具停止，实际子进程消失，延迟效果未发生，188ms 确认取消；随后 scope 可继续工作。浏览器真实聊天与子任务原生帧回放通过 |
| C 运行台账与预算 | node:sqlite 的 Run、事件游标、审批、产品记录与实际用量。父子额度交集、已花与在飞预留、未知用量失败关闭 | Ledger 10/10，运行契约 42/42。重启保留资料，未知副作用不自动重放 |
| D 原生审批与权限 | 原生 rpc-ui 请求真实回答，不采用推荐选项。chat/supervised/full 明确分档，收紧策略先停旧进程，子任务不扩权 | 真实 Deny 不写文件、Approve 写准确内容。chat 档真实工具列表仅三个受控宿主工具，项目 MCP 与扩展 canary 未调用。没有验证过的 OS 沙箱，因此拒绝 sandbox |
| E 资料与成果 | 文本与图片上传、图片读出口、不可变成果版本、预览、下载、文件检查点及保护已有编辑 | 原生图片识别红/蓝通过。浏览器文件选择、真实审批、生成文件和下载/预览逐字一致。三个场景各 10 次成果验收通过 |
| F 原生能力接入 | OMP 能力状态、MCP 私有配置与凭据脱敏、技能过滤、登录入口、浏览器暂停/归还 | 真 Chromium 人工输入、页面不冻结、暂停拒绝新回合、重建恢复暂停、归还后继续通过。MCP 添加保留其他服务及秘密，坏原件拒绝覆盖。真实外部应用账号撤销和跨设备可视接管未验收 |
| G 后台与计划 | Electron 后台、原生计划与协作、每 Bot 私有原生记忆目录及编辑/清理备份 | 两个 Bot 实际 learn、重启新会话召回、互不串标记通过。编辑读回、清理后新会话不召回、保留源会话和另一 Bot 通过。OpenCode Flash 原生 thinkingLevel=max 实跑确认 |
| H 配对与飞书 | 一次性配对、Bot 范围权限、设备撤销、飞书身份映射、验签/解密、去重、原生审批回答、入站中断与投递记录 | Channels 25/25，本地回调 HTTP 与 SQLite 实跑。设备撤销关闭 SSE，旧凭证失效。真实飞书、公网 HTTPS、手机与远端主机未接通 |
| 质量与交付 | 旧资料迁移前备份、团队模板加性导入且计划暂停、兼容版本检查、内置引擎 provenance | 以下记录实际检查。无签名和发布源，自动更新未启用 |

## 验证记录

各检查在实现冻结后由主代理执行。不是只依据实现者自报，也不是一次未执行的 npm test 汇总。

| 命令 | 最后观察结果 |
|---|---|
| node test/unit.mjs | 11/11 |
| node test/shutdown.mjs | 退出拒绝新工作、运行落定、释放锁、CLI 访问持有者和审批真实状态通过 |
| node test/ledger.mjs | 10/10，包含多个真实子进程竞争陈旧锁 |
| node test/runs.mjs | 42/42 |
| node test/features.mjs | 53 项行为检查通过 |
| node test/http-boundaries.mjs | 83/83 |
| node test/rpc-client.mjs | 30/30，包含 admission timeout、迟到 settlement、进程回收与重启 |
| node test/channels.mjs | 25/25 |
| node smoke-gui.mjs | 55/55 |
| gate、smoke-b2b、smoke-group、smoke-persist | 握手/人格/宿主工具闭环、4271 委派、群路由 10/10、重启回忆紫罗兰-7788 通过 |
| 原生工作台 smoke | 文本增量、拒绝、批准、CLI 跨进程取消真实工具、取消后复用、持久运行与事件通过 |
| 浏览器验收 | 真实发送、文件选择、审批、成果预览/下载通过。实际 task/wait 帧回放显示 completed、Flash 身份与 NATIVE_CHILD_VALUE_437 |
| 浏览器预算 | 先复现保存失败，再验证 maxTokens=12345 保存与回显。清空后仍保留 maxCostUsd=2 |
| npm run package:win | portable 与 NSIS 构建成功。内置 OMP 18.10.0，源文件和包内 sha256 一致 |
| 最终 release/win-unpacked/omp-bot.exe | 真内置 OMP 回合完成，关窗保持后台，菜单恢复窗口并截图，显式退出释放锁，5.53s |
| pwsh 包检查 | 两个交付 EXE 和内置运行时实际签名状态均为 NotSigned，sha256 已落盘 |

源码级独立审查覆盖传输、设备/飞书、功能边界和前端契约。已修复的具体问题包括陈旧锁竞争、预算重复派发、宽权限 runtime 复用、MCP 在活跃回合中杀进程、成果字节与哈希不同步、图片读出口缺失、飞书审批载荷错误、receiver 异常逃逸、设备范围缺省、有效配对码被淘汰、凭据 URL 回显、恢复覆盖已编辑文件、网页终态与分页缺失、附件按钮、飞书方法和抽屉刷新。

UI 子任务使用 OMP 18.10 实际协议。该版本的异步模式没有独立 subagent_lifecycle 帧，task 的 progress 和 wait 的 jobs 才是本次真实来源。完成快照缺少用量时保留此前实际值，不造进度或回退标记。

## 三场景 30 次基线

使用 DeepSeek V4.1 Flash。输入为仓库源码调研资料、发票计算模块需求与 CSV 分析资料。每个场景包含首次进程/会话、新会话与续接会话。检查实际成果内容，开发场景执行产出的模块，数据场景核对计算结果。不是检查文件非空。

| 场景 | 验收成功 | 总耗时中位数 | 总耗时 P90 | 首文本中位数 |
|---|---|---|---|---|
| 源码调研 | 10/10 | 13.64s | 21.48s | 11.36s |
| 开发交付 | 10/10 | 13.36s | 16.80s | 10.57s |
| 数据分析 | 10/10 | 14.61s | 17.09s | 12.74s |

中位数取排序后第 5 和第 6 项均值，P90 取最近秩第 9 项。30 次原生用量合计 982919 tokens，包含缓存读取，66 次工具调用。原生返回费用合计 0.035874852 USD，不是账户账单核对。首事件中位数约 17ms 多为续接进程，不能当首字延迟。

这份 30 次基线采集早于 model 字段修复，保留其 model:null 原文。不能事后填成已观察值。后续两次真实新回合/续接回合用原生 get_state 验证 Run 和 Ledger 中的实际 Flash 身份相同，费用分别为 0.000335652 和 0.000135228 USD。另一个真实 task 子任务完成并报告同一 Flash 身份，未回退。

基线是当前版本的本地可运行任务结果，没有竞品同输入实测或改造前配对样本。不能据此宣称更快、更便宜或已经达到竞品质量。

## 进程资源基线

通过 Get-Process 读取逐个启动后的空闲工作集。首 Bot 包含两次文本回合，其余进程刚启动。只计 OMP 进程，不含 Electron、Node 服务、浏览器和峰值。

| Bot 进程数 | 工作集合计 | 从首样本开始累计时间 |
|---|---|---|
| 1 | 283.12 MiB | 1.20s |
| 4 | 1193.25 MiB | 5.19s |
| 12 | 3467.30 MiB | 14.40s |

12 个空闲进程约 3.39 GiB。保留会话续接的空闲回收值得另做有唤醒损耗对照的优化，本轮没有凭基线新增进程池或宣称节省。

## Windows 交付

- [便携版](../../release/omp-bot-0.1.0-portable.exe)，189815285 bytes，SHA256 `0eb5feb8136833f270f802297e07b94d8108979e3993b12fb19e82f393c851db`。
- [安装版](../../release/omp-bot-0.1.0-setup.exe)，190079263 bytes，SHA256 `a70e1089d1039ba9e7e949f000a0174bd69a6d962fad92807326cf3ad94500b3`。
- [包内引擎来源](../../release/win-unpacked/resources/runtime/PROVENANCE.json)，OMP 18.10.0，SHA256 `4694cf5c4b37a88036ed183b2459d9b61b6c2f16ba2f162a8a0b50aef7a988e4`，与本机来源相同。

首次构建遇验收进程占用内置 EXE，关闭本轮测试服务后重建成功。最终 smoke 运行的是打包目录里的应用及其内置 OMP，不是开发 Electron。窗口恢复的第一次检查在 show 后立即读取状态失败，随后改为点击真实菜单并等待可见，观察通过；未修改生产恢复代码。

## 交付边界

- supervised 是原生本机审批，不是 OS 沙箱。full/yolo 需专用入口显式确认，模板不带权限批准。
- 本机取消不撤回已发送邮件、发布或其他外部动作。无法确认执行效果时保留 reconciliation_required。
- 私有原生记忆使用选定模型的非密 provider 定义。本机 auth:none 回环路径实跑通过，未修改用户全局记忆与认证。认证代理分支仅行为夹具验证，未连真实代理。配置解析仅接受受支持的 YAML 子集，flow map、锚点和带引号键会显式拒绝。
- 本地浏览器接管暂停 Bot，不代表已经实现云电脑或手机可视远控。
- 飞书检查使用本地测试端点，没有向真实业务账号发消息。公网反代、外部凭据和远端节点仍由用户配置与授权。
- Electron 窗口和后台生命周期已实测。托盘菜单鼠标交互及 Windows 系统通知实际投递未观察。
- Windows 安装/卸载、Authenticode 签名及更新链路未验收。安装包尚无证书和发布源。
- 原生子任务探针成功记录完成结果后，Windows 临时目录清理曾报 EPERM。该探针退出码不能称全通过。另查命令行未找到相应探针进程，不能由清理失败推断生产进程泄漏。

## 本地证据

- [冻结接口](../../.scratch/omp-native-workbench/contract.md)。
- [30 次基线原始记录](../../.scratch/omp-native-workbench/quality-baseline.json)。
- [受控聊天原生工具检查](../../.scratch/omp-native-workbench/chat-surface-proof.json)。
- [浏览器文件与原生审批](../../.scratch/omp-native-workbench/browser-approval-proof.json)。
- [成果下载与预览](../../.scratch/omp-native-workbench/browser-artifact-proof.json)。
- [原生子任务完成记录](../../.scratch/omp-native-workbench/subagent-proof.json)。
- [浏览器子任务回放](../../.scratch/omp-native-workbench/browser-subagent-replay.json)。
- [网页预算回归](../../.scratch/omp-native-workbench/browser-budget-proof.json)。
- [模型与进程工作集](../../.scratch/omp-native-workbench/metadata-resource-proof.json)。
- [桌面运行证据](../../.scratch/omp-native-workbench/desktop-proof.json)。
- [包哈希与实际签名状态](../../.scratch/omp-native-workbench/package-proof.json)。
- [本地浏览器人工接管](../../.scratch/omp-native-workbench/browser-handoff-proof.json)。
- [OpenCode Flash max 私有运行](../../.scratch/omp-native-workbench/opencode-private-max-proof.json)。
- [双 Bot 私有记忆及重启召回](../../.scratch/omp-native-workbench/private-memory-proof.json)。

证据位于本地 .scratch，未公开上传。竞品差距和原始改进方案保留在同目录的 competitive-gaps 与 improvement-plan 文档，本文不覆盖原始研究。

交付前已成功删除两份曾报 EPERM 的本轮子任务探针临时目录，保留本地证据 JSON。一次性浏览器检查脚本已清理，实际运行 harness 与证明数据留在 .scratch。

最后一轮已修复飞书配置保存将环境引用秘密写成明文、启用时隐藏 receiver 错误、计划跳过却报告成功、MCP 单服务保存覆盖其他定义、浏览器进程退出后无法归还和重启丢暂停。运行隔离夹具改用临时模型源并恢复环境，不再依赖用户全局模型。最后构建后的打包应用实际原生回合、关窗后台、菜单恢复、截图和退出释放锁再次通过。

浏览器接管探针行为验收通过，首次临时目录清理报告 EPERM。最终交付前已成功删除本轮目录 `ompbot-browser-handoff-proof-HTcHJh`，保留证明 JSON 和截图。

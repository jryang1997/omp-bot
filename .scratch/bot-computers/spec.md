# 每个 Bot 的独立电脑

Status: ready-for-agent

## 已授权目标

用户授权按研究推荐方向实施。保留现有 OMP 模型与会话，给每个 Bot 绑定持久 Linux 电脑，接入 guest shell/文件/桌面控制、附件、成果和人工接管。既有 Bot 和用户修改保持可用。本次不创建付费云资源、不改变模型认证、不自动迁移私人浏览器登录。

## 完成条件

1. 在真实后端启动两个 Bot 所属的 Linux 桌面，每台电脑能截图、点击、输入并显示可观察状态变化。
2. 电脑绑定由服务端持有，模型不能选别的 Bot 电脑或提交任意宿主路径。电脑模式实际工具清单中没有本机 bash/read/eval、浏览器、任意用户 MCP 等绕过通道。
3. 附件在客机可用；客机生成文件下载进现有不可变成果库，GUI 能预览和下载。跨 Bot 附件/电脑/成果调用拒绝。
4. 停启后客机文件和浏览器 profile 保留，服务重启重新连接同一台电脑。关闭会话不删除电脑。
5. 同台电脑跨 scope 输入互斥；人工接管期间拒绝自动输入和新回合，归还不会重放旧点击；取消客机命令真正终止或明确标记效果未知。
6. GUI 展示电脑状态、桌面、启动/停止和接管/归还。既有本机执行路径通过现有回归检查。

## 前置事实

Node 24.19.0，OMP 18.10.3 可用。Win11 Pro，31.8 GiB RAM，本次测得 11.6 GiB 空闲，HypervisorPresent=true，非管理员。PATH 无 Docker/Podman/QEMU/Cua，WSL 未安装。先验证官方 Windows CLI 加 QEMU/WHPX；本机电脑启动若需要系统功能修改或重启，先完成所有可审阅的软件实现，再处理具体前置。

## 现有执行路径

HTTP -> Orchestrator.startRun -> features.preparePrompt -> BotRuntime/RpcClient -> 本机 OMP -> nativeTurn -> collectArtifacts。独立会话粒度 botId::scope；电脑粒度需要 Bot 所属机器。原生 `--no-tools --no-extensions` 与工具清单核验已有 chat 档先例。MCP 配置仅是接入点，不能把默认 sandbox 名当隔离边界。

## 实施工作流

先核实电脑 runtime 并保留基线。两个独立架构候选给出 SDK/host-tools 与 scoped MCP 形状，独立 judge 按固定目标、实际工具隔离、持久性、输入/取消/接管、文件交付和维护成本选型。核心 owner 管理共享的数据与运行时契约；runtime 和 UI 分离所有权。完成后主代理统一测试和真实 HTTP/OMP/桌面验收，再更新 README、CHANGELOG 和审阅证据。

## 测试位置

复用现有 HTTP API、Orchestrator Run 生命周期和真实 OMP RPC 作为消费者接口。新增永久测试只覆盖能被外部观察的隔离、持久状态、输入互斥、取消、接管和文件所有权。电脑端到端另用可重跑 smoke 命令，清楚区分真实客机与受控协议夹具。

## Comments

- 初始电脑后端部署选择待真实 Cua runtime 检查；两个设计候选仅用于比较接口，主代理负责整合与验收。
- 已选择并实测 QEMU/WHPX 与官方进程内 Cua SDK。管理通道采用私有认证命名管道，关闭 VNC。`backend-proof.json`、`lifecycle-proof.json` 和 `packaged-proof.json` 分别证明本机开机、崩溃重连与实际 Electron 包内客机操作。
- 两路独立审查提出的生命周期、代际输入、未知效果与 spool 问题均已修正。`test/computers.mjs` 主代理实际 11/11 通过，工作台实际接管、放大、归还、成果预览与旧输入队列验证见 `gui-proof.json`。
- 官方逐字输入发生中文首字错写，已改为固定目标窗口的 SDK 剪贴板粘贴。生产代码已在真实终端重复 6 次及实际 Chromium 中验证中文和 emoji 原样输入，见 `clipboard-proof.json`。
- 最终 `smoke-computers.mjs --model magpie/codex/gpt-6.1-sol` 实机验收 13/13 通过，包含两 Bot 模型读图、物理输入、附件成果、跨 scope 拒绝、真正杀客机子进程、停启浏览器 localStorage、native write 审批、接管与关机时的纯聊天、服务重启重连。见 `smoke-proof.json`。

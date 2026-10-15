# OpenMausBot「每 Bot 一台电脑」机制一手取证（canonical HEAD）

范围：官方仓库 `milind-soni/OpenMausBot` 的电脑集成机制，回答三个问题：①绑定是把工具收窄到某一台指定电脑，还是接受模型给出的任意 ID；②GUI 路由与整体 runtime 隔离的分界；③canonical HEAD 上云电脑 provider 究竟是 Boat 还是 Box/box.ascii.dev。方法：`--depth 1` 只读 clone 到临时目录，HEAD = **`34cbd59bb46341839febcb5ed5b014b11be9e102`**（main，2026-10-12T23:02Z）。**未运行**该产品、未安装 Cua、未调用 Boat API；凡标【未测】者均未真机验证。标注：【明确】= 该 commit 源码/官方文档可直接核对；【推测】= 我方推理。

## 一、结论

1. **绑定是服务端单目标绑定，不接受模型指定电脑 ID**。【明确】每台电脑的核心工具集（`cloud-computer-tools.ts` 的 10 个工具、Cua Driver 的点击/输入类工具、`vm_exec`）schema 里**没有任何 computer/box/desktop 参数**；目标由服务端 turn 作用域能力记录解析：`InternalCapability.boxId`（`server/index.ts:2271-2273`，注释「only ever set by the harness at attach」），路由处 `boxId: () => internalCapability.boxId ?? claimedBoatId(...)`（同文件 `18497-18505`）。模型只能通过 harness 工具 `select_computer` 换**地点类型**（`auto/cloud/vm/local/browser`，Cloud home 只有 `auto/cloud/browser`），且「A pending result means end this turn immediately」，由服务端更新会话选择器并重跑原请求（`server/drivers/agents-catalog.ts:303-310`、`server/computer-selection.ts`）。**唯一例外**是「借出电脑」（Shared computers）：`shared_computer` 工具确实接收 `computer_id`（`agents-catalog.ts:254-260`），但那台桌面的授权（文件夹/终端/控制三个独立 grant）由借出方逐操作复核（`server/shared-computers.ts` 头注与 `sharedComputerScopeRefusal`）。所以：内置四类地点=闭包持有目标；借出电脑=模型可点名，但每次调用仍受桌面侧授权约束。
2. **模型进程不在远端电脑上，GUI 工具才指向目标机**。【明确】云电脑挂载点写死为宿主机回环：`{command: process.execPath, args:[harness-mcp-proxy, "computer"], env:{OMB_HARNESS_URL:"http://127.0.0.1:${PORT}", OMB_MCP_TOKEN_COMPUTER: <turn capability>}}`（`server/index.ts:8347-8357`）。模型 CLI（Claude/Codex/ACP 等）由宿主机 harness 以 `--mcp-config`/`mcp_servers.*` 挂同一个 `computer` stdio server（`server/drivers/turn-mcp.ts:32`；Claude 临时 mcp.json 见 `server/drivers/claude.ts:1776-1779`）。因此**原生 shell/读写文件仍发生在宿主机 bot 工作区**；只有走 computer MCP 的调用落到远端。官方文档亦直言「The agent process stays on your local machine; only Docker commands and the managed desktop container run on the VPS」。
3. **provider 漂移可裁定：canonical HEAD 是 Boat（boat.dev），"Box/box.ascii.dev" 是历史命名与遗留 API 路径**。【明确】README 技术表与架构图写 `Boat (boat.dev)`（`README.md:249,279`）；默认 API 基址却是 `https://ascii.dev/api/box/v1`（`server/included-services.ts:22`），env 名仍是 `OMB_BOX_API`（同文件 `:94`）；`server/config.ts:652` 明确「Persisted under the historical config key "box" (ascii.dev renamed Box to Boat)」。全仓仅剩一处 `box.ascii.dev`：试用账单链接 `https://box.ascii.dev/box/dashboard`（仅出现在 `server/boat-errors.test.ts:16,24`）。结论：清空电脑选型时按「Boat 为 provider 品牌名 + `/api/box/v1` 为历史契约路径」处理；fork/旧 README 的 "Box box.ascii.dev" 不代表 HEAD。

## 二、四类电脑提供者（HEAD）

| 提供者 | 代码入口 | 运行位置与隔离 | 持久性 |
|---|---|---|---|
| Boat 云电脑 | `server/boat.ts`（每 bot 一台、确定性命名；`findBoat:964`/`screenshotBoat:1447`/`POST /boxes/{id}/commands`）；凭据与 relay 见 `docs/cloud-pro.md:839-841` | 第三方托管 Linux 桌面；本机只存凭据，agent 进程不上去 | 停止=暂停计费但磁盘保留（`boat.ts:1-13` 头注）；`join` 每次新签 desktop URL |
| Local VM | `server/container-computer.ts` | 本机 Docker/Podman 容器内 XFCE + Cua Driver；镜像 `localhost/openmausbot/cua-local-vm:driver-0.20.0-v5`（源自 `docker.io/trycua/xfce-cua@sha256:274eb…`，`container-computer.ts:29-42`）；运行参数 4g/2cpu/pids 512/`--cap-drop ALL`+SETUID,SETGID/shm 512m，仅 1 个回环端口（6901 noVNC），唯一 bind 挂载 `/home/cua/workspace` | 工作区挂载持久（`~/.openmausbot/vm-home`、`vm-homes/<bot>`、`vm-homes/pool-N`），浏览器 profile 落 `workspace/.browser-profiles`（登录随之持久，镜像内脚本 0700 收紧）；`mode: shared/per-bot/pool` + `maxInstances`，空闲定时停机（`local-vm-idle.ts`） |
| 自有 VPS | `server/vps-computer.ts` | 经 SSH 别名驱动远端 x86_64 Docker；容器无端口、无宿主挂载、每次 attach 前校验；桌面文件系统「disposable」（`apps/docs/.../cloud-and-vps.mdx`、`docs/byo-vps.md:100-110`） | 容器停止保留文件系统；重建（含镜像升级）即清空 |
| This computer（宿主桌面） | `server/local-computer.ts` + `local-computer-proxy.ts` | Electron 主进程持有官方 `cua-driver` 嵌入式 daemon，harness 只拿私有 socket 的 MCP 代理 | 宿主本身；默认关闭、逐 bot 授权、失败即关闭（fail-closed） |

【明确】本次核对的 OpenMausBot 电脑实现使用 Cua Driver，并未采用 Cua Spaces。全仓检索 `cua spaces|spaces\.cua` 零命中；实际依赖是 `@trycua/cua-driver` npm 包（`package.json:101`，0.28.2）、官方 driver 二进制（Ubuntu 固定 0.19.3、VM 镜像内 0.20.0）和 driver 自带的 `cua mcp` stdio 代理。具体依赖和电脑工具路径见下列固定版本来源。

## 三、模型 → MCP 代理 → provider 的精确路径

四条路径都以**同一个名字 `computer`** 的 stdio server 注入到各引擎原生 MCP 配置（`turn-mcp.ts:32` 注释：「host and sandbox Cua connections expose Cua Driver's own MCP server」）：

1. **云电脑**：`harness-mcp-proxy computer`（本地子进程）→ `POST /api/internal/computer/mcp`（loopback + turn 能力令牌）→ `cloudComputerRpc`（`server/cloud-computer-tools.ts:106-126`）→ `boat.runCommand`（`POST /boxes/{id}/commands`，命令用 `xdotool`/`bash` 拼装）或 `screenshotBoat`。工具集固定 10 个：`screenshot/get_screen_size/click/move/drag/type_text/key_press/scroll/open_url/exec`。安全检查顺序「参数 schema → 人工控制闸门 → 读 boxId → 调用前后各验一次能力仍有效」写在同一函数注释里。
2. **This computer**：`local-computer-proxy`（校验 descriptor 后 `runMcpBridge`，`server/local-computer-proxy.ts`）→ `cua-driver mcp --embedded --socket <私有 socket>`（`electron/cua.mjs:257-260`）。**无 shell 工具**（Cua Driver 工具面只有 start_session/click/type_text/get_window_state/…/screenshot 等）。
3. **Local VM**：`container-mcp`（刻意「定义零工具、不解析 MCP」的透明桥）→ `docker|podman exec <容器> cua mcp --socket /run/user/1000/openmausbot-cua.sock`。VM 的 shell 走另一条：agents MCP 的 **`vm_exec`** → `/api/internal/vm-exec` → `containerExec`（默认 60s、上限 300s，超时在容器内用 `timeout` 真正终止，`server/index.ts:18765-18792`）。
4. **VPS**：`vps-container-mcp` → `docker -H ssh://<alias> exec … cua mcp --socket`，另有 `docker version` 存活探针（区分「桌面忙」与「VPS 不可达」）。同样**无 shell 工具**。

【明确】因此「远端 GUI ≠ 全 runtime 隔离」在本仓库成立：云电脑有 `exec`、Local VM 有 `vm_exec`，但 VPS 与宿主桌面路径没有 OMB 提供的远端 shell；bot 的 shell/文件若来自引擎原生工具，一律在宿主机 bot 工作区。`attach_file`（agents MCP，`agents-catalog.ts:359-363`）存在的理由正是「`/home/cua/workspace/...` 这类路径宿主打不开」，需要显式搬回聊天附件库。

## 四、绑定、生命周期、并发与人工接管

- **绑定单位**：`bot.computer ∈ {cloud, vm, local, browser, off}` 是 **per bot** 设置（`server/new-bot-defaults.ts:29`），可随时改而不换模型；**每次 turn** 只挂一个地点，租约按 **thread/turn** 授予。
- **惰性创建/唤醒**：云电脑与 VPS 的工具在派发时就挂上，但机器在**本 turn 第一次电脑调用**时才创建/唤醒（`mountBotBoat`/`attachBotBoat`，`server/index.ts:8449-8519`；`boatTurnLifecycleAction` 决定 attach/provision/wake）。启动预算 150s（`index.ts:8438`）；「一次没碰屏幕的闲聊不产生 Boat 调用、不计计划小时」。
- **独占与排队**：`bindTurnComputer`（`index.ts:3026` 起）+ `computerCallGate`（`8191` 起）实现「一台桌面同时只有一个 turn 在开」。调用等待：单次调用最多 **45s**（`CONTROL_WAIT_MS`）内等待持有者；等到了但超 **5s**（`CONTROL_ACT_WITHIN_MS`）才拿到的手**不执行**、回一句「重试即立刻生效」，避免迟到的点击落到已变化的界面；整 turn 等待上限 **30 分钟**（`COMPUTER_WAIT_MAX_MS`，到点 park 而非失败）。Local VM 的租约是可续期 TTL（`local-vm-lease.ts`，per-bot 模式每 bot 一条 lane；pool 模式座位亲和 30 分钟，`local-vm-seat-pool.ts`）。
- **人工查看/接管**：`computer-control.ts` 规定只有人能 take/release（`POST /api/bots/:id/computer/control`），bot 只能发「Sign in needed」卡请求人手；人持有时 bot 的电脑调用被**拒绝而非排队**，等回后也不补执行（`control-client.ts` 的 `CONTROL_HANDED_BACK` 等固定话术）。预览用截图轮询/帧（`computer-observation.ts` 去重同一帧）；云看板走各家 viewer、VPS 走临时 SSH 隧道内 noVNC、Local VM 是 127.0.0.1 的 viewer 端口。
- **共享/团队**：团队级云电脑（`team-computers.ts`，按 section 分配、一次一个 turn）；「借出电脑」是 desktop app 主动登记+逐操作授权。

## 五、对 omp_bot 的最小可复用模式

本仓库已有 `features.hostTools(runtime)` 工具工厂（`src/orchestrator.mjs:705`）与 `set_host_tools` RPC（`src/rpc-client.mjs:720`），可复用 OpenMausBot 的结构而无需换 OMP 回合：模型与原生 shell 留在本机，电脑工具作为受控宿主工具或私有 MCP 暴露；目标 ID 不进入模型可见 schema，由服务端绑定；每次调用检查单目标租约和人工接管状态；首次调用才开机，机器和回合生命周期分开；远端产物显式下载回本机。竞品的 45s/5s/30min 是它的等待阈值，本项目应按实际运行定值。若希望 shell/文件操作也离开宿主机，必须把这些工具换成远端实现。

## 六、来源表（permalink 均指向 `34cbd59bb46341839febcb5ed5b014b11be9e102`）

| 事实 | 来源 |
|---|---|
| 架构图/技术表写 Boat (boat.dev) | [README.md](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/README.md#L249) |
| Boat 默认 API = ascii.dev/api/box/v1；env OMB_BOX_API | [included-services.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/included-services.ts#L22) |
| 品牌改为 Boat，config 键仍为 box | [config.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/config.ts#L652) |
| 每 bot 一台 Boat、stop 保留磁盘、join 生成 URL | [boat.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/boat.ts#L1) |
| 云电脑工具集与 RPC 检查顺序 | [cloud-computer-tools.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/cloud-computer-tools.ts#L15) |
| 回环代理与 turn 能力令牌 | [index.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/index.ts#L8347) |
| boxId 只由服务端设置，调用时解析 | [能力记录](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/index.ts#L2271)、[目标解析](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/index.ts#L18497) |
| 同名 computer MCP 注入引擎 | [turn-mcp.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/drivers/turn-mcp.ts#L32) |
| select_computer 的地点选择与 pending 语义 | [agents-catalog.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/drivers/agents-catalog.ts#L303) |
| vm_exec / attach_file | [工具契约](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/drivers/agents-catalog.ts#L345)、[vm-exec 路由](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/index.ts#L18765) |
| 宿主桌面 gate 与嵌入式 driver | [local-computer.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/local-computer.ts#L22)、[electron/cua.mjs](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/electron/cua.mjs#L257) |
| Local VM 镜像、挂载、端口、工作区 | [container-computer.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/container-computer.ts#L29) |
| Local VM 透明 MCP 桥 | [container-mcp.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/container-mcp.ts) |
| VPS 透明 MCP 桥 | [vps-container-mcp.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/vps-container-mcp.ts) |
| 等待阈值与电脑调用闸门 | [control-client.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/control-client.ts#L25)、[computerCallGate](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/index.ts#L8191) |
| 人工接管规则 | [computer-control.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/computer-control.ts#L1) |
| 租约、座位池、空闲停机 | [lease](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/local-vm-lease.ts)、[seat-pool](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/local-vm-seat-pool.ts)、[idle](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/local-vm-idle.ts) |
| 团队与借出电脑 | [team-computers.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/team-computers.ts)、[shared-computers.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/shared-computers.ts) |
| 每 bot computer 枚举 | [new-bot-defaults.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/new-bot-defaults.ts#L29) |
| Local VM 模式与 maxInstances | [config.ts](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/server/config.ts#L49) |
| 官方电脑集成文档 | [computer-use-integration.md](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/docs/computer-use-integration.md)、[cloud-and-vps.mdx](https://github.com/milind-soni/OpenMausBot/blob/34cbd59bb46341839febcb5ed5b014b11be9e102/apps/docs/content/docs/computers/cloud-and-vps.mdx) |

## 七、未测与不确定项

- 【未测】全部运行时行为：未启动 OpenMausBot，未跑任何 Boat/VPS/Local VM/宿主桌面调用；等待/接管/预览的时延与成功率均未实测。
- 【未测】未直连 Boat API，`/boxes/*` 的字段、配额、TTL 契约只据仓库代码与官方自述。
- 【未测】Cua Driver 的工具名清单转引自 `docs/computer-use-integration.md`（0.19.3 时代 `cua-driver list-tools` 输出），HEAD 的 npm SDK 为 0.28.2，未核对该版本工具面差异。
- 【未测】「借出电脑」路径只读了工具描述与 `shared-computers.ts` 头部规则，未追完整鉴权链。
- 【推测】`platform: "linux"` 描述符字段的消费方（各 driver 的审批规则）未逐一追读；「作用域 `scope:"local-computer"` 仅宿主桌面」有 contracts 注释，未验证全部 driver 行为。
- 【推测】团队云电脑的 contention 细节（`teamComputerInUse`）只读函数本体，未追所有调用点。

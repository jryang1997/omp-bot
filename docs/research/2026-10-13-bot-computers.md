# Bots 独立电脑可行性与接入建议

研究日期：2026-10-13。范围为 Cua Spaces、OpenMausBot 的电脑机制，以及本仓库接入位置。本轮是调研，没有安装虚拟化软件、创建云资源或修改应用代码。

主代理核对的当前 Git HEAD 为 OpenMausBot `34cbd59bb46341839febcb5ed5b014b11be9e102`、Cua `32f353c80be5e07cc9d9aecf627963b1bbefbe18`。网页和在线文档是本次读取时的官方表述；独立源码核对另见同目录的 `2026-10-13-openmausbot-computers.md` 与 `2026-10-13-cua-spaces.md`。

后续实施与实机验收见 [Bot 独立电脑验收](2026-10-13-computer-verification.md)。下文保留调研当时的前置状态；当前已走 QEMU/WHPX 与官方 SDK，在本机完成持久双 VM 和工作台验收。

## 结论

能做。推荐保留本地 OMP 的模型、会话和群聊编排，给每个 Bot 绑定一台持久的 Linux 桌面，把截图、点击、输入、命令和文件操作都发到那台电脑。工作台显示桌面并提供人工接管。这个方案有官方 API 和参考应用支持，尚未在本机验证桌面端到端运行。

采用本地 OMP 加远端电脑时，Windows 上的编排服务和模型进程仍须运行。电脑可以保留状态，但关闭本地服务不等于 Bot 会继续在云端独立思考；把 OMP 完整迁到客机是另一种实现。

Cua Spaces 的稳定桌面 App 当前面向 macOS 26，macOS VM 还需要 Apple silicon。已核对 GitHub [0.8.0-beta.3 预发布资产](https://github.com/trycua/cua/releases/tag/cua-spaces-v0.8.0-beta.3)，其中已有 Windows x64/arm64 Electron 安装包；普通 Windows 安装脚本仍跳过 Spaces App。正式 CLI/SDK 已提供 Windows 路径，官方 quickstart 用 Docker 运行 Linux 桌面并按地址和 token 注册。推荐使用 CLI/SDK 加自己的工作台，不以 beta GUI 作为运行依赖。[S1][S2]

当前本机运行前置不齐：PATH 内没有 Docker、Podman、cua、cua-driver；`wsl.exe --status` 返回 50，解码后的原文是“未安装适用于 Linux 的 Windows 子系统”。这证明标准启动路径当前不可用，不能宣布本机容器桌面已准备好；没有查验 PATH 之外的容器安装或其他远端主机。

## 三个产品分别负责什么

| 产品 | 职责 | 对本项目的意义 |
|---|---|---|
| Cua Driver | 控制已有桌面的窗口、截图、输入和辅助功能树 | 装在 Windows 主机上会控制现有 Windows 桌面；独立电脑需要另一个执行环境 |
| Cua Spaces / Sandbox | 创建或连接 VM、容器或远端机器，提供桌面、shell、文件和 streaming | 可作为每个 Bot 的电脑后端；不同 runtime 的隔离强度不同 |
| Cua Cloud / Fleets | 托管或扩展机器容量，按使用计费 | 是可选计算资源来源，个人 Spaces 免费不包含免费云算力 |

以上分别见官方项目 README、Spaces quickstart、SDK 架构说明和官网价格。[S1][S2][S3][S4]

## OpenMausBot 怎么处理电脑

官方文档区分 Boat 云 Linux 桌面、Local VM、自有 VPS 和本机 Cua Driver。Local VM 实际是 Docker/Podman 容器化 Linux 桌面，Windows 文档优先推荐 Podman。支持 `localVm.mode = per-bot` 和 `maxInstances`，工作目录和浏览器 profile 使用持久挂载，重建桌面不删除这些目录。VPS 使用 SSH 别名驱动远端 Linux Docker；模型进程留在本机，远端只跑 Docker 和桌面。VPS 文档明确说明该桌面文件系统应视为可丢弃，重要结果需先取出。[S5][S6]

本机控制由 Electron 主进程启动嵌入式 Cua Driver，模型通过 MCP 使用它；远端电脑用单独的 MCP 代理。内嵌浏览器使用 Electron `WebContentsView` 和每 Bot 的持久 session partition。它使用 Cua Driver 并不表示它使用 Cua Spaces 作为电脑后端。[S7]

固定 HEAD 的源码核对进一步确认：Boat 现品牌为 `boat.dev`，API 仍保留 `ascii.dev/api/box/v1` 和历史 `box` 配置名。核心电脑工具的 schema 不让模型传电脑 ID，目标来自服务端 `InternalCapability.boxId`；人工接管时拒绝 bot 电脑调用，归还后不补执行先前输入。云电脑有远端 `exec`，Local VM 另有 `vm_exec`，而模型原生 shell 仍在宿主机。具体路径与固定版本来源见 [OpenMausBot 源码报告](2026-10-13-openmausbot-computers.md)。

可复用的结构是“电脑生命周期与模型生命周期分开、每 bot 绑定目标、模型通过工具操作、UI 提供查看与接管”。本地模型进程加远端 GUI 工具不能自动证明所有 shell 和文件操作都已隔离。

## Cua 的可用接口与参考应用

官方 SDK 的 `embedded().spaces()` 或连接 daemon 的 Spaces 对象可创建或添加电脑；`spaces.add(url, token, name)` 接已有 `cua-spacesd`，`spaces.space(id)` 取得固定电脑对象。`space.bash` 在客机执行命令；`list_tools` / `call_tool` 调用客机 Cua Driver 或指定服务。官方 Linux 镜像 `ghcr.io/trycua/linux:24.04` 带 `cua-spacesd`，客机服务端口为 3211。[S2][S8][S9]

SDK 支持截图、鼠标、键盘、shell、files；`cua sb view NAME` 可打开 HTML5 桌面 viewer。Viewer ticket 有范围和过期时间，官方实现默认一小时、最多 24 小时。`openStream` / `attachStream` 可取编码画面，浏览器用 WebCodecs 解码。Windows CLI 的存在不能换算成已验证本机 Docker、图形输入、编码和登录均成功。[S9][S10]

持久性必须明确选择。`Sandbox.ephemeral` 退出时删除电脑；`create` 的电脑保留直到删除，断开连接不会停止电脑。删除会销毁其状态，远端 direct 类型删除只忘记登记。AWS/GCP 的 stop/start 保留磁盘，云资源默认还可能有 TTL；Modal 不支持 stop/start，最长 24 小时，不适合作为无需同步的永久个人桌面。[S3][S11]

官方有两个直接参考：

- Cua Bots 是 SwiftUI 的每 bot 一个 Space 示例，源码在 `samples/cua-bots-macos`。其页面明确说明演示截图使用 scripted mock provider，规则靠模型指令而非硬执行，不能把演示当成自治审批已可靠落地。[S12]
- OpenKoalaBots 的 TypeScript 版本是 Node server 加 web UI，源码在 `samples/openkoalabot-example-ts`。该样例目录采用仓库默认 MIT，Swift/Tauri 版本另有 FSL 许可。文档说这些示例是多个 bot 的长驻线程共用 Space，需要改为本项目需要的每 bot 独立绑定。[S13][S15]

Cua 的 `agent_start` 示例是 Claude Code/Codex 等已有 harness，不是 OMP 的适配器。我们可继续使用自己的 OMP 回合，通过受控工具调用 Space，无需更换模型执行循环。若要把 OMP 进程本身放进客机，则需另外适配 RPC、模型认证和会话存储，不能当成现成能力。[S8]

## 本仓库接在哪里

当前独立目录由 `src/bot.mjs:87` 的 `runtimeDirs` 生成。`BotRuntime.start` 仍通过本地 `RpcClient` 启动 OMP，工作目录不同并不是 OS 边界。`_buildArgs` 在 chat 档使用 `--no-tools --no-extensions`，其他档使用原生工具。README 也明确说明 supervised/full 都不是 OS 沙箱。

已有两条可复用接入点：

1. `src/features/native.mjs:303` 的 Bot 私有 `.omp/mcp.json`，`putMcp` 会在空闲时重建 runtime，原生 MCP 运行时负责工具调用。可以用它验证固定 Space 的 MCP 代理。
2. `src/orchestrator.mjs:683` 的工具工厂已经接 `features.hostTools(runtime)`；`src/bot.mjs:330` 注册宿主工具，`src/rpc-client.mjs:975` 支持进度和取消信号。正式电脑适配器可在该处以闭包持有电脑 ID，复用现有 Run 台账。

附件和成果还需要补齐远端路径：`src/features.mjs:90` 当前把本机附件交给本机 OMP；`collectArtifacts` 扫本机目录。远端执行需要显式上传到所属电脑，再下载成果进入现有不可变成果库，不能让 Bot 报一个 Linux 路径就算交付完成。

## 推荐实现约束

以下是设计建议，未实施。

- Bot 记录绑定 `provider`、固定 `computerId` 和运行位置。默认每 Bot 一台持久电脑，私聊/群聊保留各自会话。若这些会话共享桌面，GUI 输入租约必须按 computerId 排他，不能只锁 botId::scope。
- 电脑的创建、暂停、恢复和删除由编排器管理。关闭聊天不删除电脑；重建前持久保存工作目录、浏览器 profile 和成果。首次建议按需开机，避免所有 Bot 永久占 RAM。
- 电脑工具不接受可由模型任意指定的目标 ID，服务端从 Bot 绑定解析目标。官方 `cua mcp --sandbox NAME` 只是默认目标，每次调用仍能覆盖 `sandbox`；permissions 限工具组，不能据此宣称“只能操作自己的电脑”。[S14]
- 增加明确的远端执行工具集合，让 shell、read/write、浏览器、截图/输入指向客机。若保留原生本地 bash/read/eval 或本机浏览器，则应明确显示仍有本机权限。凭提示词“请只在远端工作”不能构成边界。
- 人工接管复用现有暂停语义，但暂停范围覆盖使用同一电脑的全部会话，并等待正在执行的输入或进程达到已知状态。归还后才继续自动输入。多 cursor 展示本身不能替代业务动作的互斥。
- 首次登录在 Bot 的客机浏览器里由人接管完成，profile 仅绑定该 Bot 的持久目录。Mac 的 Keyvault/Teleport 演示不能作为 Windows 登录迁移已经可用的依据；不自动复制用户整份浏览器或模型凭据。[S1][S8]
- 模型需能消费截图或辅助功能树。图片编码、原生 MCP image 回传、实际模型的图片工具调用能力都列为运行验收项。

验证顺序应为：一台临时桌面内运行命令并检查客机标记；查看截图、点击输入并观察状态变化；上传资料、生成并下载成果；停启验证文件与 profile；两 bot 隔离、同电脑跨 scope 互斥、人工接管后自动输入停止。全部完成才把该执行模式称为已验证沙箱。

## 成本、许可与数据路径

个人在自有电脑运行 Spaces 免费；relay 当前 early access 免费。自有云资源由云厂商收费，模型 token 另计。官网 Cua Fleet 报 CPU $0.044625/vCPU/hour、内存 $0.0223125/GiB/hour，是托管容量价格，不是本地 Spaces 的月费。自有 AWS/GCP Linux 桌面文档估算约 $0.03–$0.04/hour，未包含网络，停止仍有磁盘费用；以最终区域和计费页为准。[S1][S4][S11]

SDK、普通 CLI/daemon、Driver 和 Lume 是 MIT；Spaces App、客机 `cua-spacesd`、Keyvault、Teleport 和 viewer 等是 FSL-1.1-MIT。FSL 允许使用、修改、自托管，限制 competing commercial use；托管或代运营 Spaces 服务需商业许可。因此不能因为采用 MIT SDK 就把官方 Spaces 镜像和 viewer 全部当 MIT 重新分发。[S15]

官方 README/stream guide 与 LICENSING.md 对 streaming protocol/transport 的许可表述有冲突。已直接核对 Cua `32f353c8` 的 [cua-media-protocol/LICENSE](https://github.com/trycua/cua/blob/32f353c80be5e07cc9d9aecf627963b1bbefbe18/libs/cua/crates/cua-media-protocol/LICENSE) 和 [cua-media-transport/LICENSE](https://github.com/trycua/cua/blob/32f353c80be5e07cc9d9aecf627963b1bbefbe18/libs/cua/crates/cua-media-transport/LICENSE)，两者均为 FSL-1.1-MIT；MIT 的 `cua-proto` StreamService 和 SDK 编码媒体接收接口不能代表整个 streaming 实现都是 MIT。官网还明确说明 relay 会终止 TLS，能读取转发中的桌面、输入和文件，但不保存；Space 的 Teleport bundle 另外端到端加密。直接连本机或自有地址不走 relay。[S1][S15]

## 实际检查与未测

实际执行：

- `node ompbot.mjs version --json` 成功。应用 0.1.0，Node 24.19.0，SQLite 可用，原生 OMP 18.10.3。`liveBackend: null`，本轮没有连接正在运行的 Bot 后端。
- `where.exe docker podman wsl cua cua-driver` 只找到系统 wsl.exe。PATH 中其余四个没有找到。
- WSL status 退出 50；list 退出 1；原始中文输出因 UTF-16LE 显示乱码，另用 buffer 解码确认“未安装适用于 Linux 的 Windows 子系统”。
- 读取了当前应用的启动参数、工具注册、MCP 配置、附件成果和接管代码；读取上述一手网页。没有运行 OpenMausBot 或 Cua 桌面，没有本机电脑成功率、资源占用、成本或登录持久性的实测。

## 直接来源

- [S1 Cua Spaces 官网](https://spaces.cua.ai/)
- [S2 Spaces quickstart](https://cua.ai/docs/spaces/quickstart)
- [S3 How sandboxes work](https://cua.ai/docs/cua-sdk/concepts/how-sandboxes-work)
- [S4 Cua 官网与 Fleet 价格](https://cua.ai/)
- [S5 OpenMausBot Local VM](https://github.com/milind-soni/OpenMausBot/blob/main/apps/docs/content/docs/computers/local-vm.mdx)
- [S6 OpenMausBot cloud and VPS](https://github.com/milind-soni/OpenMausBot/blob/main/apps/docs/content/docs/computers/cloud-and-vps.mdx)
- [S7 OpenMausBot computer integration](https://github.com/milind-soni/OpenMausBot/blob/main/docs/computer-use-integration.md)
- [S8 Use Spaces from an agent](https://cua.ai/docs/spaces/guides/use-from-an-agent)
- [S9 Control the desktop](https://cua.ai/docs/cua-sdk/guides/desktop)
- [S10 Stream a desktop](https://cua.ai/docs/spaces/guides/stream-a-desktop)
- [S11 Your cloud 与资源成本](https://cua.ai/docs/cua-sdk/guides/your-cloud-resources)
- [S12 Cua Bots](https://cua.ai/docs/spaces/examples/cua-bots)
- [S13 TypeScript/Rust/Swift 示例](https://cua.ai/docs/spaces/examples/other-languages)
- [S14 MCP grants 与 default sandbox](https://cua.ai/docs/cua-cli/guides/mcp-server)
- [S15 许可目录与边界](https://github.com/trycua/cua/blob/main/LICENSING.md)

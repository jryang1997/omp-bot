# Cua Spaces 独立电脑调研（Spaces 通道）

研究日期：2026-10-13。代码/文档基线：trycua/cua `main` @ `32f353c80be5e07cc9d9aecf627963b1bbefbe18`（2026-10-13T01:01:48Z）。本轮只读官方文档、仓库源码与 GitHub 发布资产，未安装软件、未创建资源、未改动应用代码。
标记：**明确**＝官方文档/仓库/发布资产直接支撑；**推测**＝由多条直证推导；**未测**＝本机未运行验证。

## 1. 结论摘要

- **明确**：Spaces 的稳定发布通道目前只有 macOS 应用（SwiftUI，dmg/pkg）；Windows/Linux 桌面应用只在 `0.8.0-beta.*` 预发布里以 Electron 形式发出（Windows NSIS、Linux AppImage/deb），正式 `install.ps1` 会**跳过安装 Spaces 应用**，但会装 `cua` CLI。
- **明确**：Windows 主机跑本地 Linux 桌面的官方路径是 CLI/SDK + 容器引擎（Docker/Podman）或 QEMU（Windows 上走 WHPX）；macOS guest 只能由 Mac 主机提供，Linux/Windows 主机会拒绝（`host_capability_missing`）。
- **明确**：官方自带“每个 bot 一台电脑”的参考实现（Cua Bots：每 bot 一个 Space，`Spaces.create(on: local|cloud, reuse)`），以及第三方语言样本（OpenKoalaBots 的 TS/Rust/Swift，注意它们是多 bot 共用一个 Space）。
- **明确**：MCP/SDK 层没有“把某个 bot 硬锁到某个 Space”的参数。只能组合：每 bot 一个 MCP 进程 + 工具级权限（`--permissions`）+ computer 工具默认目标（`--sandbox`），`space` 仍由每次调用传入。
- **成本**：本机与自有机器上的 Spaces 免费、无需账号；relay 早期免费；Cua Cloud 按 vCPU/GiB·小时计费；自有云由云厂商计费。
- **许可**：SDK/CLI/Driver/Lume 为 MIT；Spaces 应用、`cua-spacesd`、Keyvault、Teleport、Cua Volume、streaming client 为 FSL-1.1-MIT（源码可见，禁 Competing Use）。内部驱动自家 bot 不需要商用许可；对外提供托管/同类服务才需要。

## 2. 发布通道与平台现状（明确）

| 组件 | 稳定版 | 预发布（0.8.0-beta.*） | 证据 |
|---|---|---|---|
| Spaces 应用 macOS | dmg + pkg（0.7.2，含 Sigstore） | Electron 版 dmg/zip | [cd workflow][W1] |
| Spaces 应用 Windows | **不发**（Tauri job 被 `vars.CUA_SPACES_LINUX_WINDOWS` 关闭；install.ps1 跳过） | `Cua-Spaces-Setup-0.8.0-beta.3.exe`（x64/arm64 NSIS） | [workflow 头注释 + 发布资产][W1][R1] |
| Spaces 应用 Linux | **不发** | AppImage + deb（x64/arm64） | [cd workflow][W1] |
| `cua` CLI | 全平台：darwin/linux/windows（`cua-cli-0.4.1-windows-x64.zip`、`-arm64.zip`） | — | [release-artifacts.json][R2] |
| `cua-spacesd`（宿主/客机守护） | Linux systemd / macOS LaunchAgent / Windows 计划任务 | — | [unattended access][D1]、[spacesd README][G1] |
| 宿主运行时 | 容器（gVisor `runsc` 若装了，否则 `runc`，Docker/Podman）、QEMU（KVM/HVF/WHPX/TCG）、Lume（仅 Apple silicon） | — | [local runtimes][D2]、[runtime support][D3] |

关键点：**Windows 上有 GUI（Electron beta）与 CLI（正式）两条路，但“每 bot 一个桌面 + 工作台”不能依赖稳定 GUI 应用**；官方 Quickstart 的说法是 Windows 走 CLI，Docker 提供本地 Linux Space。

## 3. 每个 bot 一台 Space：API 与持久化语义

| 目的 | CLI | MCP 工具 | SDK（Python/TS/Swift/Rust 同名） |
|---|---|---|---|
| 创建 | `cua spaces create linux --name bot-1`（`--on local\|cloud\|host:<机器>`） | `create_space` | `spaces.create(options)` |
| 登记已有机器 | `cua spaces add host:3211 --token T --name x` | `add_space` | `spaces.add(url, token, name)` |
| 列举/解析 | `cua spaces ls` | `list_spaces` | `spaces.list()` / `spaces.space(id)` |
| 关机/开机 | `cua spaces stop\|start` | `stop_space` / `start_space` | `spaces.stop/start` |
| 删除/忘记 | `cua spaces delete\|rm` | `delete_space` / `remove_space` | `spaces.delete/remove` |
| 执行/文件 | `cua sb exec/cp`、`space_bash` | `space_bash`、`space_write`、`send_file`、`upload`/`download` | `space.bash()`、`space.files()` |
| 桌面控制 | `cua sb screenshot`、`cua do` | `computer_*`（截图/点击/输入/窗口/辅助功能/剪贴板/shell/文件） | `space.screen()/mouse()/keyboard()`、`list_tools/call_tool` |
| 客机内跑 harness | `cua agent` | `agent_start/agent_message/agent_events/agent_status/stop` | `space.agentStart(...)`（TS 里是 `startThread`） |
| 直播 | `cua viewer`（FSL） | `stream_endpoint`、`open_space_viewer`、`show_space_pip` | `space.open_stream()` / `attach_stream()`（编码帧） |

持久化（**明确**，来自 [lifecycle 文档][D4] 与 Spaces 生命周期参考）：

- 本地 Space 创建后**一直存在直到删除**；断开连接不停机（连接与实例寿命分离）。
- `stop_space`：容器/QEMU 为 suspend（保内存，原地恢复）；Lume 为 stop（保磁盘，下次冷启动）；自有云的 stop 停止算力计费但磁盘继续计费；**Modal 云沙箱不能停/启，最长 24 小时**（不适合当常驻桌面）；Fleet 云 Space、direct 添加的机器不能关机。
- 删除即销毁客机内状态；`remove_space` 仅取消登记，实例继续运行。
- 跨实例/跨重建的数据靠 [Cua Volume][D5]：`agents/<bot>/`（memory、outputs、inbox）、版本化、写 `agents/` 会被密钥扫描；**Windows 客机暂无挂载**（只能用 `volume_*` 工具），Linux 客机挂 `/volume`。
- 官方“每 bot 一台”的落法（[Cua Bots][D6]）：每 bot 一个 `bot-<name>` Space + 每轮把 Volume 家目录同步进/出 Space。实例内文件不跨删除存活；持久的东西放 Volume 或宿主目录。

## 4. 用 OMP 自己的 agent loop 驱动（不采用 Cua agent loop）

- **明确**：`cua mcp` / `cua daemon mcp` 是 stdio MCP 服务，暴露 `computer_*`（截图、点击、输入、窗口、辅助功能树、剪贴板、文件、shell）与 Spaces 工具；`computer_shell`/`computer_file_write` 在沙箱上就是 `space_bash`/`space_write` 的实现。SDK 侧还有 `MediaSession`（编码帧，MIT）与 spacesd gRPC 客户端。
- **明确**：权限是**工具级**：`--permissions`（`spaces:all`、`spaces:readonly`、`computer:all`、`computer:readonly`、`skills:*`，或单个 `spaces:<tool>`）；`--sandbox`/`CUA_SANDBOX` 只是 computer 工具的**默认目标**，每次调用仍可传 `sandbox`。**没有**“只允许访问某个 Space”的白名单参数（[MCP 指南][D7]、[CLI 参考][D8]）。
- **推测**：因此“每 bot 独占一台”应由我们自建：每 bot 起一个 `cua mcp --sandbox local:bot-N --permissions computer:all,spaces:space_bash,...` 进程，并在编排层校验 `space` 参数；或用 MIT SDK 直接调用。
- **文档冲突（未测）**：`agent_start` 的 reference 列出 9 个 harness（claude-code、gemini-cli、google-antigravity、goose、hermes、openai-codex、openclaw、opencode、pi），而指南只说 ready 的是 claude-code/openai-codex——运行时以 `agent_capabilities` 为准。凭证：指南说 daemon 会把宿主 `~/.claude/.credentials.json` 拷进 Space（`CUA_SPACES_AGENT_CREDENTIALS_HOME=none` 可关），`agent_start` 参考却写 “host credential files are never copied”。两者矛盾，必须实机确认。
- **流**：`stream_endpoint`/`open_stream` 返回 ticket（默认 60 s，最多 10 min），媒体经 WebSocket `/media` 或 QUIC；**编码帧与 `cua-proto` StreamService 是 MIT**，已解码的 `space.stream_session`、HTML5 viewer、`cua viewer` 属 FSL，未注册处报 `HostCapabilityMissing`。[stream 指南][D9]
- **隐私**：官方承认 relay 终止 TLS，可读到经过它的桌面流、输入与文件（不存储）；本机/局域网直连不经过 relay（[relay 安全][D10]）。

## 5. Windows 主机 go/no-go

**明确（文档层）**：

1. Quickstart 前置就是 “macOS, Linux or Windows + Docker”；CLI 管理的本地 Linux Space 用 Docker（装了 `runsc` 用 gVisor，否则 `runc`）或 QEMU；**managed runtime 仅 macOS**。([quickstart][D11])
2. 运行时表：容器→Docker/Podman；VM→QEMU 在 Windows 用 **WHPX**；`Image.windows()` 在带 Hyper-V 的 Windows 主机走 Hyper-V，否则 QEMU。([local runtimes][D2])
3. `cua host setup` 的 Windows 服务形态存在（计划任务 `Cua\SpacesdHost`），且文档把 “Linux 或 Windows 主机” 当作合法宿主（它们只是拒绝 macOS guest）。([unattended][D1]、[spare Mac 指南][D12])
4. CLI 的 Windows 二进制已正式发布（x64/arm64）。

**推测**：Windows 上可用的“每 bot 一台”形态是 **Docker Desktop(WSL2)/Podman 里的 `ghcr.io/trycua/linux:24.04` 容器桌面**（XFCE on Xvfb，3211 端口跑 spacesd）；gVisor 在 Windows 上很可能不可用（`runsc` 是 Linux 沙箱，文档全文未提 WSL/Docker Desktop 后端）。

**未测 / 未知**：本机无 Docker/Podman/`cua`、WSL 未安装，无法验证容器桌面启动、截图、输入与编码；`cua runtime doctor` 在 Windows 上的真实结论未知；“Windows 主机为别的设备提供（`--provide-spaces`）Linux Space”未见明文；Windows 上 Keyvault 的解锁方式（Touch ID 明确是 macOS 路径，其他情况应是口令，未证实）。

## 6. 许可（按目录裁决）

权威是 [LICENSING.md][L1]（自述列出仓库内**每一个** LICENSE 文件）+ 各目录 LICENSE：

- **MIT**：根 `LICENSE.md` 为默认；SDK 及语言包、`cua` CLI、`cua daemon`、Cua Driver、Lume、`cua-proto`（含 `StreamService`）、SDK `MediaSession`、`@trycua/cua/spaces/pip`。**`samples/openkoalabot-example-ts` 不在 FSL 表中 → 根 MIT**（2026-10-13 核对 `main` 该目录清单：只有 README/package/src/test/web/tsconfig，无 LICENSE 文件；可参照其 Node server + web UI 结构）。
- **FSL-1.1-MIT**（源码可见、非 OSI）：四个 Spaces 应用（Tauri/SwiftUI/Electron/web UI）、`cua-spacesd` 与 `cua-relay`、app-core、Keyvault、Teleport（含 bundle 格式与 end-to-end seal）、Cua Volume、streaming（`cua-media-protocol`、`-transport`、`-client`、`-codec`、HTML5 viewer、`cua-viewer`、`cua-logging`）、`cua-spaces-ext/ffi/cli`、`libs/spaces-app-swift`；以及链接这些的样例：**Cua Bots（macOS/iOS）、Infinite Canvas、OpenKoalaBots 的 Swift 与 Tauri 版**。
- 裁决 parent 发现的冲突：README/web 说“streaming wire 是 MIT”只对**protobuf 契约与 SDK 编码帧 API**成立；`cua-media-protocol/-transport` 实现是 FSL。[LICENSING.md][L1] 与目录 LICENSE 优先，文档措辞不精确。
- FSL 条款：可自用、复制、修改、自托管，限制 Competing Use，即把 Spaces 或其实质等价物作为商业产品/服务提供给别人；每个 release 两年后转 MIT。条款明确列出内部使用为 Permitted Purpose；对外托管或代运营服务需按 [COMMERCIAL.md][L2] 核对商业许可。商标另见 [TRADEMARKS.md][L3]。

## 7. 成本（明确为官方报价；推算另标）

- 本机 Space、自有机器 Space：**免费**（无账号也可，直连模式）；relay 在 early access 期间免费。([主页 FAQ][W2]、[spaces README][G2])
- **Cua Cloud（Fleet）**：按用量 **CPU $0.044625/vCPU·h、Memory $0.0223125/GiB·h**（[官网 pricing][W2]）。**推算**：2 vCPU/4 GiB 常驻约 **$0.18/小时 ≈ $4.3/天**（不含停机后的磁盘）；App 内只显示余额与“加余额”，付款在网站。
- **自有云**（AWS/GCP/Modal）：由云厂商计费，官方给 Linux 家族约 **$0.03–0.04/小时**（t4g/e2 small-medium），Modal 约 **$0.24/小时**；这些 BYOC 后端目前不提供 macOS/Windows/Omarchy Space。BYOC 资源默认寿命为 **8 小时**，`--ttl-hours 0` 可保留至手动删除，Modal 最多 24 小时。Fleet 的 claim/续期机制是另一个通道，不应混为同一个 TTL。([your-cloud-resources][D13]、[your-cloud](https://cua.ai/docs/cua-sdk/guides/your-cloud))
- 需要账号的场景：relay 与云端；纯本地/直连不需要。

## 8. 未测与后续验证清单

1. Windows 主机 + Docker Desktop 起 `trycua/linux:24.04` 容器桌面：启动时间、3211 连通、`cua runtime doctor` 结论、gVisor 是否可用。
2. 每 bot 一个 MCP 进程的权限收窄是否实际挡住越权（`--sandbox` 只是默认值）。
3. `agent_start` 凭证复制的真实行为（两份官方文档互相矛盾）。
4. Keyvault/Teleport 在 Windows 宿主下的可用性（签名应用要求、口令解锁）。
5. 本地 Space 长期运行的内存/磁盘占用与是否有官方自动挂起策略（Tauri README 只提到 auto-suspend 影响估算）。

## 来源

- [W1] Cua Spaces 发布工作流（“MACOS ONLY FOR NOW”、Windows 计划任务/签名、electron 三平台）：<https://github.com/trycua/cua/blob/main/.github/workflows/cd-cua-spaces.yml>
- [W2] Cua Spaces 主页 FAQ 与 pricing 段（免费范围、relay、Fleet $/vCPU·h）：<https://spaces.cua.ai/>、<https://cua.ai/#pricing>
- [R1] 0.8.0-beta.3 发布资产（含 `Cua-Spaces-Setup-0.8.0-beta.3.exe`）：<https://github.com/trycua/cua/releases/tag/cua-spaces-v0.8.0-beta.3>
- [R2] release-artifacts.json（CLI Windows zip、0.7.2 仅 darwin）：<https://github.com/trycua/cua/releases/download/cua-spaces-v0.8.0-beta.3/release-artifacts.json>
- [D1] 无人值守访问（Windows 计划任务、`cua host setup`）：<https://cua.ai/docs/spaces/guides/unattended-access>
- [D2] 本地运行时（WHPX、gVisor/runc、managed runtime 仅 macOS）：<https://cua.ai/docs/cua-sdk/guides/local-runtimes>
- [D3] Runtime support（容器/VM/云矩阵）：<https://cua.ai/docs/cua-sdk/reference/runtime-support>
- [D4] Sandbox 生命周期（保留、suspend/stop、TTL）：<https://cua.ai/docs/cua-sdk/guides/lifecycle>
- [D5] Cua Volume（每 agent 家目录、Windows 无挂载）：<https://cua.ai/docs/spaces/guides/cua-volume>
- [D6] Cua Bots 示例（每 bot 一个 Space、Volume 布局、限制）：<https://cua.ai/docs/spaces/examples/cua-bots>
- [D7] MCP 指南（权限组、agent_setup、凭证）：<https://cua.ai/docs/cua-cli/guides/mcp-server>
- [D8] `cua mcp` / `cua daemon mcp` 参考（`--sandbox` 为默认目标）：<https://cua.ai/docs/cua-cli/reference/cli/mcp>、<https://cua.ai/docs/cua-cli/reference/cli/daemon>
- [D9] 流媒体指南（ticket、codec、FSL 解码客户端）：<https://cua.ai/docs/spaces/guides/stream-a-desktop>
- [D10] relay 可见性：<https://cua.ai/docs/spaces/guides/relay-security>
- [D11] Quickstart（Windows 安装、Docker 前置）：<https://cua.ai/docs/spaces/quickstart>
- [D12] 自有机器提供 Spaces（宿主限制、`host_capability_missing`）：<https://cua.ai/docs/start-here/host-spaces-on-your-spare-mac>
- [D13] 自有云资源与费用：<https://cua.ai/docs/cua-sdk/guides/your-cloud-resources>
- [G1] cua-spacesd README（平台服务、端口 3211/3212）：<https://github.com/trycua/cua/blob/main/libs/cua-spacesd/README.md>
- [G2] 仓库 README（Spaces 免费、FSL 说明）：<https://github.com/trycua/cua/blob/main/README.md>
- [G3] Spaces 应用 Tauri README（Windows/Linux 发布说明）：<https://github.com/trycua/cua/blob/main/apps/cua-spaces/README.md>
- [G4] Electron 桌面壳 README（Windows/Linux 桥、Keyvault 提示）：<https://github.com/trycua/cua/blob/main/apps/cua-spaces-desktop/README.md>
- [L1] 许可目录与 MIT/FSL 边界：<https://github.com/trycua/cua/blob/main/LICENSING.md>
- [L2] 商业许可（对外托管需授权）：<https://github.com/trycua/cua/blob/main/COMMERCIAL.md>
- [L3] 商标：<https://github.com/trycua/cua/blob/main/TRADEMARKS.md>
- [X1] OpenKoalaBots（TS，根 MIT；多 bot 共享 Space）：<https://github.com/trycua/cua/blob/main/samples/openkoalabot-example-ts/README.md>

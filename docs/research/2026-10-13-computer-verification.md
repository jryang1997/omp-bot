# Bot 独立电脑验收

2026-10-13。每 Bot 持久 Linux VM 已在本机完成端到端验收。模型和会话继续使用本地 OMP，桌面、命令和文件由官方 Cua SDK 操作固定客机。

## 使用入口

在工作台打开 Bot 的「电脑」页，点「绑定电脑」。源码运行前执行 `npm run setup:computers`。当前本机资源已准备，Windows x64 使用 QEMU 11.1.0、WHPX `kernel-irqchip=off`、Cua SDK 0.4.1 和固定 digest 的官方 Linux 镜像。每台默认 2 个 vCPU、2048 MiB RAM。

停止保留磁盘和浏览器 profile。退出应用只断开管理连接，运行中的 VM 仍占用资源。电脑保持公网 NAT。模型进程留在本机，关闭 OMP 不会让 Bot 继续自行工作。

## 主代理实际检查

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 真实双 VM、真实模型和 HTTP 全流程 | 13/13 PASS，246.63 秒，`magpie/codex/gpt-6.1-sol` | `.scratch/bot-computers/smoke-proof.json` |
| 永久消费者回归 | 11/11 PASS，真实 HTTP 与受控客机协议夹具 | `test/computers.mjs` |
| 既有全套测试 | `npm test` PASS，含原生 gate、私聊委派、群聊和重启续接 | 当前会话 `artifact://546` |
| 最后控制改动后的既有集成 | computers 10/10、runs 44/44、features 53 项 PASS。随后附件断流用例将 computers 扩为 11/11，单独通过 | 当前会话测试输出 |
| 实际工作台 | 查看、放大、接管、文本、排队按键、归还、成果预览和下载通过。390px 页面无横向溢出 | `.scratch/bot-computers/gui-proof.json`、`gui-input-proof.json` |
| 两个 owner 切换控制 | generation 3 的待发输入在新 generation 5 下未重放 | `.scratch/bot-computers/gui-proof.json` |
| 实际 Unicode 输入 | 生产后端在终端重复 6 次和实际 Chromium 中保留中文、emoji | `.scratch/bot-computers/clipboard-proof.json` |
| 崩溃重连与镜像保护 | Node 退出后重连同一活 VM；错误 key 和禁用命令被拒；过期 PID 不误杀；同尺寸镜像改动被拒 | `.scratch/bot-computers/lifecycle-proof.json` |
| 验收脚本清理 | 服务退出后确认两台客机停止，再删除临时数据目录，实际通过 | `.scratch/bot-computers/smoke-cleanup-proof.json` |
| 实际包内 VM | 实际 `omp-bot.exe` 加 `app.asar` 启动客机，命令输出 `PACKAGED_GUEST_OK`，截图 1280×800，确认停机 | `.scratch/bot-computers/packaged-proof.json` |
| 资源提取 | 已核验发布缓存解包、镜像复制与许可复制成功，19.35 秒 | `.scratch/bot-computers/setup-cached-release-proof.json` |

13 项实机验收覆盖两个 Bot 的截图和物理输入、模型从图像读取随机文件名、实际 dumpTools、跨 Bot 文件与附件隔离、中文输入、旧代拒绝、终止真正的客机子进程、私聊与群聊互斥、运行中接管、浏览器 localStorage 停启保留、native write 审批、人工接管与关机时的纯聊天、编排服务重启恢复。

电脑任务的实际工具清单为 `computer_screenshot`、`computer_input`、`computer_shell`、`computer_files`、`computer_upload_attachment`、`computer_publish_file` 和团队工具。宿主 `bash/read/eval/browser`、用户 MCP、扩展与技能未进入模型。纯聊天保留原有受控资料读取工具，没有电脑工具。

## 独立审查与修复

安全和控制审查分别使用独立上下文，最终均为 PASS。没有可核验的不同模型家族执行证据，不声称跨模型一致。

修复了接管之后旧自动输入仍落到客机、归还未等待在途输入、普通 RPC 断流未标记未知效果、接管后遗留 spool、旧 UI 队列套用新代号、文字发送期间排队回车丢失、慢 QMP 被误认孤儿、PID 复用误报和无界 serial 宿主文件输出。

官方逐字 Unicode 输入曾把“电脑”写成“脑脑”。文字改为通过 SDK 粘贴到最初聚焦窗口。终端使用 Ctrl+Shift+V，其他窗口使用 Ctrl+V。客机剪贴板保留最近输入内容；宿主剪贴板不参与。

只解包 DLL 不足以运行官方 SDK。打包完整解包 `@trycua`、`@ubjs` 与原生库，从物理 `app.asar.unpacked` 加载 SDK。实际 Electron 44.7.0、Node 24.21.0 包内客机已通过。

## Windows 交付

- [便携版](../../release-computer-final/omp-bot-0.1.1-portable.exe)，1,584,775,493 字节。
- [安装版](../../release-computer-final/omp-bot-0.1.1-setup.exe)，1,585,039,433 字节。

两份文件实际 Authenticode 状态均为 `NotSigned`。核心电脑模块与最终 `app.asar` 字节逐一相同，最终重建后的包再次实际开机、运行命令、截图和停机通过。SHA-256 见 `.scratch/bot-computers/delivery-manifest.json`，源码比对见 `package-source-proof.json`。

## 限制

本机正常下载官方 QEMU 资产未在 300 秒探针期限内完成。已核验缓存解包和本机资产复用通过，最终包携带电脑运行资源，不依赖首次运行下载。未验证全新 Windows 主机的系统功能开启和安装卸载；程序未做 Authenticode 签名。

持久性实测使用 Chromium profile 的 localStorage，没有自动迁移宿主浏览器登录，也未验证任意网站登录续期。SDK 和 CLI 为 MIT，镜像内 `cua-spacesd` 为 FSL-1.1-MIT，运行资源随包带上游许可原文。

复跑完整实机检查使用 `npm run smoke:computers -- --model magpie/codex/gpt-6.1-sol`。默认创建临时 Bot 和电脑，完成后确认停机再删除临时数据目录；`--home` 或 `--keep` 保留数据。证据和逐项决策保存在 `.scratch/bot-computers/`。

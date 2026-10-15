# Ego (lite) 官方资料调研（ego-browser 通道）

研究日期 2026-10-13。来源调研基于 lite.ego.app、github.com/citrolabs/ego-lite main、ego-browser-benchmark-framework 与本机 Windows 0.5.2.15 随包文件。主代理另用已安装的 Windows CLI 运行自建页面功能探针，结果见 `2026-10-13-browser-efficiency.md`；没有安装或迁移登录。
标记：**明确**＝官方直证；**推测**＝由直证推导；**未测**＝本机无法验证。

## 1. 结论摘要

- **公开口径对实际（平台）**：官方文档与下载页只给 macOS，Windows/Linux 标 Planned（Roadmap、README closed beta、官网 Get pinged）。但**本机实测**已有 Windows 安装 0.5.2.15（C:/Program Files/Citro Labs/ego lite/Application/0.5.2.15/，含 ego-browser.exe 与打包 skill）。文档口径落后于实际分发；Linux 客机兼容未证。[P1][P4][P6][R1][L1]
- **明确（连接）**：ego-browser 需与 ego lite 同机；容器/虚拟机/远程要宿主桥（host-execution bridge），官方无远程协议。[H1]
- **明确（隔离）**：Space 是同一进程内工作区，官方明确它不是新窗口、不是第二个 Chrome profile、不是无头；建 Space 时可指定 profileId。硬性「每 bot 独立账号」无来源可证。[P3][A1]
- **明确（来源冲突）**：Space 页称每任务独立 BrowserContext（自有 cookies/storage）；skill 的 clearing-state 参考称同 profile 的 cookie jar 与缓存被该 profile 下所有 task space 共享。本调研不裁决。[P3][S3]
- **明确（控制面）**：语义 snapshot（可访问性树→@N ref）＋page.evaluate＋page.cdp/task.cdp 原始 CDP；省轮次靠单次 Node 脚本组合多步操作。[D1][D2][A1]
- **明确（许可）**：仓库（skill/SDK）MIT；浏览器本体单独免费下载；基准框架 MIT；个人免费，团队 Business 定制价。[G1][P4][B1]
- **明确（性能口径不一）**：首页 3.45×、README 2.5×、skill 页 20–50%；Real-World Bench 称 31 任务完成 30。工具对比原始数据未发布。[P2][P6][P7][P1]

## 2. 平台与跨机连接

- **明确**：安装脚本仅 macOS；官方对 Docker/SSH/云要求 harness 跑本机、配宿主桥，或浏览器与 agent 同机。[S2][H1]
- **明确（公开产物）**：下载页与 README 只给 macOS DMG；GitHub releases 公开资产只有 skill 包（v2.0.0 的 ego-browser-v2.0.0.zip）与源码包，均未见 Windows 安装包。[P6][R2]
- **本机实测**：Windows 0.5.2.15 已安装，版本号高于公开 changelog 末条 0.5.1.13；打包 skill 为 v2.0.0（2026-09-09），含 PowerShell/cmd 用法与 local-ego-daemon。[L1][L2]
- **未测**：server name 选实例能否跨机、该 Windows 版能否被 Linux/QEMU 客机远程驱动，均无公开文档、未验证。[H1][P5]

## 3. Space / Profile 与登录隔离（决策核心）

- **明确**：Space 共享同一进程但互不打断、复用已有登录；profiles() 列 profile，profileId 仅建新 Space 时生效；changelog 称任务可按 Profile 运行。[P3][A1][P5]
- **明确**：没有「每 bot 自动绑定独立账号」的机制或承诺，最多是建 Space 时手动选 profile。[A1][P5]

## 4. 控制面行为

- **明确**：snapshot 节点名是 AX 角色；@N 由 CDP backendNodeId 编号，仅对最近一次 snapshot 有效；稳定定位用 loc=css:/role:/href:、text=、xpath= 或 CSS；CSS 进开放 shadow root；动作先顶层文档再 frame；多匹配判歧义。[D1][D2]
- **明确（文档冲突）**：v1 写 snapshotText() 默认 full_page；v2 参考写 page.snapshot() 默认 only_within_viewport（含可见 iframe），subtree 需 iframe ref。[D1][A1]
- **明确**：page.evaluate 回调在页面内、拿不到 Node 变量；无 timeout 参数，安全超时用 executionStopped/mayHaveLateEffects 判断。[A1]
- **明确**：page.cdp() 走该 Page 目标会话（Page/Runtime/DOM/Network/Input 等），task.cdp() 限 Target/Browser 域，raw CDP 使 ref 失效；changelog 已修 CLI CDP 桥允许 Target.createTarget 的问题。[A1][D2][P5]
- **明确**：snapshot 与 screenshot 默认二选一；receipt 只报已派发动作与即时 popup/dialog。[A1]

## 5. 并发与多客户端

- **明确**：文档站 meta 称 100+ 并发；README 举例 10 个并行 Space；并发曾故障并修复（0.4.7.4 断连、0.5.0.28 runtime 启动、0.4.6.12 CDP 回调断开同主机任务）。[P2][P5][P6]
- **明确**：多 agent/多实例靠不同 Space/Profile 与 CLI server name。[P5][P6]

## 6. 官方性能/令牌主张与样本口径

| 主张 | 来源 | 样本/口径 |
|---|---|---|
| 3.45× faster vs agent-browser | 首页 | 未给任务数与方法 |
| up to 2.5×、4 个复杂任务 | README | 只有一张图 |
| 内部基准同任务快 20–50% | skill 页 | 未公开 |
| 31 任务完成 30、最快、轮次最少、成本最低 | product-introduce | 同模型同评分，链公开框架 |
| 每页 200–400 tokens | 产品/定价页 | 无分布与测量方法 |
| 6 路并发 0.9GB/6 进程/0.6s 对 15GB/84/2.5s | Space 页 | 自述「不是精确基准」 |
| 经验累积后最多 5× | skill/README | 标注 coming soon |

- **明确**：公开框架给受控比较协议（固定 provider/模型/浏览器/skill/judge、并发；tokens/turns/cost 取自 session JSONL），自我限定「不是通用排行榜」；默认适配器称 macOS。[B1]
- **明确**：已发布报告只有 16 模型 × 31 任务的模型对比（154 rubrics/模型，重算自 tasks.jsonl 与会话日志，自列并发不统一等局限），不是工具对比。[B2]
- **未测**：3.45×、2.5×、30/31 的原始数据未发布，无法复核。

## 7. 不能得出的结论

1. 无本机延迟/令牌/成功率对照。Windows 0.5.2.15 已实跑语义读取、输入、点击和精确数据断言；截图超时，不能算全部验收通过。
2. Space 间 cookie 语义无法裁决。
3. 远程/跨机连接（含 server name 语义）未文档化。
4. snapshot 质量与 token 分布无公开数据。

## 建议（条件式）

- 通道必须由 Linux/QEMU 客机远程驱动，或要求每 bot 硬性独立账号：无官方路径，不建议采用。
- macOS 或本机 Windows 可作为宿主浏览器候选。Windows 基础语义探针已通过，但尚无相对 CUA/OMP 的性能数据；共享登录身份与截图异常仍需解决。证据见 `2026-10-13-browser-efficiency.md`。

## 来源

- [P1] 产品介绍：<https://lite.ego.app/document/en/docs/product-introduce>
- [P2] 文档站首页（meta 称 100+；3.45×）：<https://lite.ego.app/>
- [P3] Space 文档：<https://lite.ego.app/document/en/docs/space>
- [P4] 定价页（免费范围、200–400 tokens）：<https://lite.ego.app/enterprise>
- [P5] Changelog：<https://lite.ego.app/changelog>
- [P6] README（2.5×、并行示例、MIT、平台）：<https://github.com/citrolabs/ego-lite>
- [P7] skill 页（20–50%）：<https://lite.ego.app/document/en/docs/skills>
- [H1] Harness 指南（宿主桥/远程限制）：<https://lite.ego.app/document/en/docs/custom-agent-harness>
- [D1] ego-browser 文档：<https://lite.ego.app/document/en/docs/ego-browser>
- [D2] SKILL.md：<https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md>
- [A1] API 参考（v2）：<https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/api.md>
- [S2] 安装参考（macOS-only）：<https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/install.md>
- [S3] clearing-state 参考：<https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/clearing-state.md>
- [B1] 基准框架 README：<https://github.com/citrolabs/ego-browser-benchmark-framework>
- [B2] 2026-08-04 报告：<https://github.com/citrolabs/ego-browser-benchmark-framework/blob/main/reports/ego-benchmark-model-metrics-2026-08-04.md>
- [G1] LICENSE（MIT）：<https://github.com/citrolabs/ego-lite/blob/main/LICENSE>
- [R1] Roadmap（Windows/Linux Planned）：<https://lite.ego.app/roadmap>
- [R2] v2.0.0 发布资产（skill zip）：<https://github.com/citrolabs/ego-lite/releases/expanded_assets/v2.0.0>
- [L1] 本机实测（仅读取）：`C:/Program Files/Citro Labs/ego lite/Application/0.5.2.15/`（ego-browser.exe、ego-skills/、local-ego-daemon/）
- [L2] 打包 skill：`.../0.5.2.15/ego-skills/ego-browser/SKILL.md`（version 2.0.0，2026-09-09）

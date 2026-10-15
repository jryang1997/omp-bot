# 团队架构重构 本机 omp bot 团队与共享 Linux 电脑

Label: wayfinder:map
Status: resolved

## Destination

产出一份能交给 `/to-spec` 的架构结论。下面四条都要有实测或用户确认作依据。

1. bot 是跑在 Windows 本机的 omp agent。绑定电脑只给它加能力，不关掉 omp 原生工具、技能和扩展。
2. 所有 bot 共用一台 Linux 虚拟机。每个 bot 在里面有自己的用户、工作目录和屏幕，`/workspace` 共享。隔离强度有明确定义。
3. 身份、技能、记忆按 team 目录分层。团队共识在上层，个人内容在 bot 自己的目录。技能从共享库里按 bot 选择启用。
4. 头像换成 OpenMausBot 的吉祥物体系。许可、移植方式和产品范围已确定。

到达标准是下表每张票都 resolved，Fog 里没有会推翻上面四条的问题。

## Notes

- 用户在 2026-10-15 否决了"omp 搬进虚拟机"。bot 住在本机第一层，虚拟机是分给它们的一台电脑，bot 可以在里面自己装 pi 之类的工具。
- 原来 6 个待验证问题里，"本机怎么驱动客机里的 omp RPC"和"auth broker 与 magpie 是否兼容"随这个决定一起消失。
- 与既有决定冲突，spec 里要明确推翻。
  - `.scratch/bot-computers/spec.md` 的标题是"每个 Bot 的独立电脑"，完成条件 2 要求电脑模式下没有本机 bash/read/eval。新方向正好相反。推翻理由是这条限制让 bot 一拿到电脑就失去 omp 原生能力。
  - `src/persona.mjs` 逐文件关闭了项目级 AGENTS.md。team 目录方案要在 team 树内打开它。
  - `src/bot.mjs` 的 `runtimeDirs` 按 bot × scope 切工作目录。新方案每个 bot 一个目录，私聊群聊共用。
- 现成可复用的部分。
  - `bot.skills` 白名单已经接到 `--skills`（`src/bot.mjs`），技能面板已能装 bot 私有技能（`src/features/native.mjs`）。
  - omp 原生支持 `skills.customDirectories` 和 `includeSkills`，共享库不用复制进每个 bot 目录。空的 `includeSkills` 表示全部，空白名单必须改用 `--no-skills`。
  - omp 会话开头只注入技能名和描述，正文按需加载。选择性分配主要换来专注和更少误触发，省下的 token 不多。
  - DS Bot 的团队记忆只允许 Main Bot 和群管理员写，其他 bot 用 message_bot 转告。可作为共识层写入规则的参考。
  - 现有 6 个客机工具已通过 13/13 实机验收（`.scratch/bot-computers/smoke-proof.json`），改成加法后可以直接沿用。
- 头像现状。`web/vendor/ds-bot/characters.js` 原样来自 DS Bot，与 Fei2411/DeepSeek-Bot 当前版本逐字相同。形状和颜色按 bot id 确定性分配，只有 idle/working 两态，用户不能选也不能上传。README 的上游链接还写着 FeiZhuLulu，应改成 Fei2411。
- 术语缺口，留给 `/domain-modeling`。共享电脑、屏幕、团队目录、共识层、技能库。

## Decisions so far

- D1 omp 留在 Windows 本机，bot 就是本机 omp agent。用户确认。
- D2 所有 bot 共用一台 Linux 虚拟机，按 bot 隔离工作目录。用户确认。
- D3 电脑能力是加法。保留现有 6 个客机工具，绑定电脑后不再加 `--no-tools --no-extensions --no-skills`。由 D1 推出，细节见 05。
- D4 技能用"共享库加每 bot 白名单"，不全量加载。用户确认，推翻了此前"共享库全量"的建议。
- D5 身份用分层 AGENTS.md。记忆每个 bot 一个库，私聊群聊通用。用户确认。
- D6 头像改用 OpenMausBot 吉祥物体系。用户确认。调研结论见 [12](issues/12-avatar-research.md)，Apache-2.0 可用，有一个来源待核实。
- D7 隔离只防误操作。客机里每 bot 一个 Linux 用户，不给免密 sudo，装系统包要审批；宿主侧不加强制隔离。见 [03](issues/03-isolation-goal.md)。
- D8 每个 bot 在客机里一个 Linux 用户、一块 Xvfb 屏、一个官方 cua-spacesd 实例。沙盒实测两屏并发互不串、跨令牌被拒，现有 SDK 调用方式不用改。见 [01](issues/01-per-bot-screens.md)。
- D9 共享文件以宿主 `team/workspace` 为唯一权威。omp-bot 内置 Node SFTP 服务，客机用 sshfs 无缓存挂到 `/workspace`。沙盒实测双向即时可见、并发追加不丢；小文件慢 16 倍，依赖和构建产物放客机本地盘。见 [04](issues/04-host-guest-files.md)。
- D10 team 目录是 git 仓库，omp 找 AGENTS.md 停在 team 根上。overlay 只关用户级 AGENTS.md，bot 读到 team 和自己两层，按通用到具体排列。身份挪进 `team/bots/<id>/AGENTS.md`，persona.md 只留团队工具说明。见 [06](issues/06-agents-md-boundary.md)。
- D11 技能库放 `team/skills/`，overlay 用 `customDirectories` 指向它，白名单沿用 `bot.skills` 到 `--skills`。私有技能要并进白名单，同名时库里那份赢，所以装技能时禁止重名。每个技能约占 110 字符，描述只露前 100 字符左右。见 [07](issues/07-skill-library-allowlist.md)。
- D12 记忆用 mnemopi，`scoping: global` 加 `bank: bot-<id>`，库文件放 `team/.memory/`。不再改 `PI_CODING_AGENT_DIR`，`memory-config.mjs` 基本删掉，autolearn 关掉。团队共识只写 `team/AGENTS.md`，由 Main Bot 和用户写。见 [08](issues/08-memory-per-bot.md)。
- D13 team 目录在 `~/.ompbot/team`，git 由 omp-bot 按每次改动提交，记忆、工作区、会话不进 git。bot 私有文件在 `bots/<id>/work`，单独挂进客机。旧数据只复制不删。用户授权按建议定。见 [09](issues/09-team-directory.md)。
- D14 审批收成 3 档，只聊天、本机改东西先问我、全部放手。共享电脑里除装系统包外都不问，装系统包走一个新的客机工具，每次要用户批准。chat 迁到只聊天，yolo 迁到全部放手，其余迁到先问我。付款、对外发送、删账号数据写进 `team/AGENTS.md` 作约定。用户选 B。见 [05](issues/05-two-machine-tools.md)。
- D15 旧的每 bot 电脑自动复制进共享电脑对应用户的 `~/old-computer/`，不覆盖、可跳过重复。旧磁盘保留，用户点"删除旧电脑"才删。用户选 A。见 [11](issues/11-existing-computers.md)。
- D16 头像拿吉祥物、10 种身体、10 种颜色、表情、随状态变化的表情、上传和裁切，不做 AI 生成。直接替换 DS Bot 角色。Main Bot 固定 star 身体和专用颜色。见 [14](issues/14-avatar-scope.md)。
- D17 网站登录全员共用。用户在专门的登录屏登录一次，omp-bot 把 cookie 发布到 root:team 只读的共享库，bot 浏览器启动前并入自己的 profile。只同步 cookie，不开调试端口。用户选 A，沙盒实测通过。见 [02](issues/02-shared-browser-login.md)。
- D18 共享电脑默认 4 vCPU、8 GiB、64 GiB 动态磁盘，内存可调 4 到 16 GiB，vCPU 2 到 8。每个座席主要花在浏览器上，一个真实页面 0.4 到 0.6 GiB，屏幕本身约 50 MiB，不做自动休眠。多个 spacesd 要加 `--quic-port 0`。见 [10](issues/10-shared-computer-size.md)。
- D19 头像用 `<omp-mascot>` 自定义元素，引擎从上游原样取出，画面与上游逐像素相同，gzip 26 KB。只有工作中、有未读或刚发生事件的头像才动，48px 以下 30 帧。吉祥物形象是上游的商标，发布前要等上游回复，不同意就换画面、留引擎。见 [13](issues/13-mascot-port-prototype.md)。

## Fog

- 中文记忆召回要靠嵌入模型，沙盒没测出来。不推翻 D12，实施时在常驻进程里验，验不过就给 bot 配多语言嵌入模型。见 08。
- 吉祥物商标等上游回复。不推翻目的地第 4 条，上游不同意时换画面、留引擎。见 13。

## Out of scope

- 应用内登录，替代终端 `omp login`。omp 留在本机后它与本架构无关，另开 effort。
- 云电脑和付费云资源。
- 安卓伴侣、飞书渠道。它们是宿主侧功能，架构换了照常工作。
- 实施。本 effort 只产出架构结论，实施走 `/to-spec`、`/to-tickets`、`/implement-spec`。

## Tickets

| # | Type | 题目 | Blocked by | Status |
| --- | --- | --- | --- | --- |
| [01](issues/01-per-bot-screens.md) | research | 共享电脑里每个 bot 的屏幕 | | resolved |
| [02](issues/02-shared-browser-login.md) | prototype | 共享浏览器登录与多屏并行 | 01 | resolved |
| [03](issues/03-isolation-goal.md) | grilling | 隔离要防到什么程度 | | resolved |
| [04](issues/04-host-guest-files.md) | research | 本机 omp 怎么碰到客机里的文件 | | resolved |
| [05](issues/05-two-machine-tools.md) | grilling | 两台机器的工具同时在场 | 03, 04 | resolved |
| [06](issues/06-agents-md-boundary.md) | research | AGENTS.md 往上找的边界 | | resolved |
| [07](issues/07-skill-library-allowlist.md) | prototype | 共享技能库加每 bot 白名单 | | resolved |
| [08](issues/08-memory-per-bot.md) | research | 记忆每 bot 一库与共识写入 | | resolved |
| [09](issues/09-team-directory.md) | grilling | team 目录放哪、怎么管 | 06, 07, 08 | resolved |
| [10](issues/10-shared-computer-size.md) | research | 共享电脑的规格 | 01, 02 | resolved |
| [11](issues/11-existing-computers.md) | grilling | 已有的每 bot 电脑怎么办 | 02, 03, 09 | resolved |
| [12](issues/12-avatar-research.md) | research | OpenMausBot 头像的许可、功能与移植成本 | | resolved |
| [13](issues/13-mascot-port-prototype.md) | prototype | 吉祥物原生 DOM 移植 | 12 | resolved |
| [14](issues/14-avatar-scope.md) | grilling | 头像拿哪些功能 | 13 | resolved |

建议先做 01 和 03。01 决定"共用一台、每 bot 一块屏"能不能成立，03 决定后面所有隔离设计的力度。04 是这个方向最大的体验风险，可以并行。

2026-10-15 进度。14 张票全部 resolved，Fog 里剩下的两条都不推翻目的地，地图到达终点，交给 `/to-spec`。

# 05 两台机器的工具同时在场

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 03, 04

## Question

bot 既有本机 bash/read/edit，又有 computer_shell/files/screenshot/input。模型怎么分清自己在哪台机器上做事，审批怎么覆盖两边。

## Facts

- 现在绑定电脑会加 `--no-tools --no-extensions --no-skills`，并关掉项目 MCP。见 `src/bot.mjs` 和 `src/features/native.mjs` 的披露文案。D3 要去掉这层门控。
- 执行模式 chat/supervised/full 乘审批档 always-ask/write/yolo，共 9 种组合。

## Options to discuss

- 客机工具的名称和描述写明"Linux 电脑"，本机工具写明"Windows 本机"。共识层 AGENTS.md 再写一遍两台机器的分工。
- 审批对两边一视同仁，还是客机侧放宽。客机是可以弄坏重来的电脑。
- 借这次把 9 种组合收成用户能懂的 2 到 3 档。

## Done when

工具面清单、审批规则、要删的门控代码列进 Answer。

## Answer

2026-10-15 用户选 B 并收成 3 档。

### 工具面

- 绑定电脑不再收窄。本机保留 omp 原生工具、扩展、技能和 MCP，客机工具加在上面。
- 客机工具的描述开头统一写"在 Linux 共享电脑里"，本机原生工具不改名。`team/AGENTS.md` 写一段两台机器的分工。本机是用户的 Windows，改用户文件；共享电脑是 bot 自己的 Linux，装软件、开浏览器、跑构建都在那里，依赖和构建产物放客机本地盘。
- 新增一个客机工具，用来申请装系统包。bot 在客机里没有免密 sudo，装系统包只能走它，它每次都要用户批准（D7）。

### 审批

收成 3 档，替代执行模式乘审批档的 9 种组合。

| 档 | 本机 | 共享电脑 |
| --- | --- | --- |
| 只聊天 | 没有执行工具 | 不可用 |
| 本机改东西先问我 | 原生 write 审批 | 除装系统包外都不问 |
| 全部放手 | 不问 | 除装系统包外都不问 |

- 旧组合迁移。chat 归"只聊天"。审批档是 yolo 的归"全部放手"，其余归"本机改东西先问我"。
- 付款、对外发送、删除账号数据前先问用户，写进 `team/AGENTS.md`。这是约定，不是拦截。

### 要删的门控

- 绑定电脑时加的 `--no-tools --no-extensions --no-skills`。
- 绑定电脑时关项目 MCP、逐个关用户 MCP 的 overlay 段。
- 电脑档的运行时工具面校验和对应的披露文案。chat 档的保留。

## Comments

- 2026-10-15 用户授权按建议定的部分。
  - 客机工具的名称和描述都写明"Linux 共享电脑"，本机工具写明"Windows 本机"。`team/AGENTS.md` 再写一段两台机器的分工，包括依赖和构建产物放客机本地盘（04）。
  - 删掉绑定电脑时加的 `--no-tools --no-extensions --no-skills` 和关项目 MCP 的门控，`src/features/native.mjs` 里的披露文案一起改。
- 待用户定。客机侧审批放不放宽，9 种组合要不要收成 3 档。问题、利弊和建议已发给用户。

# 05 两台机器的工具同时在场

Type: grilling
Label: wayfinder:grilling
Status: open
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

## Comments
# 08 记忆每 bot 一库与共识写入

Type: research
Label: wayfinder:research
Status: open
Blocked by:

## Question

记忆改成每 bot 一库、私聊群聊通用之后，现在的私有 agentDir 和 33 KB 的 memory-config.mjs 还要不要。团队共识由谁写进去。

## What to check

- mnemopi 按 cwd 分库。cwd 改成每 bot 一个目录后，能否不再改 `PI_CODING_AGENT_DIR`，直接用用户的 agent 目录和模型注册表。能的话 memory-config.mjs 可以删。
- `per-project-tagged` 召回时会合并全局库。全局库是用户所有项目共用的，bot 会不会读到用户写代码时留下的记忆。会的话用 `mnemopi.dbPath` 给团队单独一个全局库。
- 共识写入规则。DS Bot 只让 Main Bot 和群管理员写团队记忆，其他 bot 用 message_bot 转告。对照我们的 `team/AGENTS.md`，决定共识层用 AGENTS.md、全局记忆库，还是两者分工。
- 私聊里说的事会不会在群聊里被说出来。这是私聊群聊通用的代价，要给出缓解办法。

## Done when

记忆目录布局、可删代码、共识写入规则写进 Answer。

## Comments
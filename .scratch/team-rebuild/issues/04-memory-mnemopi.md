# 04: 记忆改用 mnemopi，每 bot 一库

**What to build:** 开启记忆的 bot 改用 mnemopi，按 bot id 分 bank，库文件在 `team/.memory/`。删掉私有 agentDir、私有 models.yml 生成和记忆前置门槛。omp-bot 发给 bot 的消息标上场景和发送者。在常驻进程里验中文召回，选定嵌入模型。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] overlay 的记忆段是 mnemopi、global、`bot-<id>`、team 内的 dbPath，autolearn 关，模型角色钉在选定模型
- [ ] 子进程环境里没有 `PI_CODING_AGENT_DIR`
- [ ] 开启记忆不再因为前置条件被拒，`memory_prereq_missing` 不再出现
- [ ] 私聊和群聊消息带场景和发送者标签
- [ ] 嵌入模型的选择和实测写进 CHANGELOG

# 02: 旧数据复制进 team 目录

**What to build:** 升级后第一次启动时，把每个 bot 旧的按 scope 分开的工作目录、会话和私有技能复制进 team 目录的新位置，旧 local 记忆摘要复制进 `work/old-memory/` 并在身份块里提示。只复制不删，可重复执行，有完成标记。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 私聊工作目录合并到 `bots/<id>/work`，群聊的放进 `work/rooms/<scope>/`
- [ ] 旧会话出现在 `sessions/<scope>/`，bot 续上原来的对话
- [ ] 旧私有技能出现在 `bots/<id>/.omp/skills/`
- [ ] 旧记忆摘要在 `work/old-memory/`，身份块里有一句提示
- [ ] 旧目录原样保留，第二次启动不再复制，新文件不被覆盖

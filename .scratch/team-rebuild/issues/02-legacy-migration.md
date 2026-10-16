# 02: 旧数据复制进 team 目录

**What to build:** 升级后第一次启动时，把每个 bot 旧的按 scope 分开的工作目录、会话和私有技能复制进 team 目录的新位置，旧 local 记忆摘要复制进 `work/old-memory/` 并在身份块里提示。只复制不删，可重复执行，有完成标记。

**Blocked by:** 01

**Status:** done

- [x] 私聊工作目录合并到 `bots/<id>/work`，群聊的放进 `work/rooms/<scope>/`
- [x] 旧会话出现在 `sessions/<scope>/`，bot 续上原来的对话
- [x] 旧私有技能出现在 `bots/<id>/.omp/skills/`
- [x] 旧记忆摘要在 `work/old-memory/`，身份块里有一句提示
- [x] 旧目录原样保留，第二次启动不再复制，新文件不被覆盖

落地记录：
- `src/team.mjs` 加了 `migrateLegacyBot` 和 `TeamDir.migrate`，启动时在建目录之后、补身份块之前跑。只复制，目标已有同名文件就跳过，符号链接不复制。
- 私聊 `work` 合到 `bots/<id>/work`，群聊的进 `work/rooms/<scope>/`。旧 `work/.omp` 不原样搬：`skills` 并进 `bots/<id>/.omp/skills/`（群里装的也并进来），私聊的 `mcp.json` 进 `bots/<id>/.omp/`，免得升级后 MCP 配置消失。
- 会话复制进 `sessions/<scope>/` 并保留修改时间。实机发现 omp 续接时按会话头里的 cwd 找 AGENTS.md，旧目录还在就读不到 team 两层，所以副本的会话头改成新 cwd，旧文件不动。
- 旧记忆只带 `memory_summary.md`、`MEMORY.md`、`learned.md` 里非空的，放 `work/old-memory/<scope>/`；`raw_memories.md` 是原料不带。有这个目录时身份块里多一句提示，表单改身份后提示还在。
- 标记是 team 根上的 `.omp-bot-migrated.json`，记着每个 bot 复制、跳过、失败的数目，随提交进历史。单个文件失败记进标记，不挡启动；整个 bot 读不下来就不留标记，下次再试。全新安装也留标记，和建目录合成一次提交。
- 证据：`test/team.mjs` 新增 5 个 02 测试，20/20；实机用升级前的代码（2631e32）造数据，再用新代码启动，`proof/migrate-e2e.json` 全 pass（会话续上、旧记忆提示进系统提示词、cwd 是新路径）；13 个测试文件全过。


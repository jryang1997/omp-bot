# 01: bot 在 team 目录里启动

**What to build:** 新的团队目录模块。omp-bot 启动时建好 team 目录、团队 AGENTS.md 模板和 git 仓库。每个 bot 的 omp 进程以 `team/bots/<id>` 为 cwd 启动，会话按 scope 放在 `sessions/<scope>/`，身份写在自己的 AGENTS.md 身份块里，overlay 打开项目级上下文文件，persona.md 只剩团队工具说明。改身份后下一轮对话自动换上新的系统提示词，team 目录的改动自动提交。

**Blocked by:** None - can start immediately

**Status:** ready-for-agent

- [ ] 第一次启动建出 spec 里的目录树、`.gitignore` 和团队 AGENTS.md 模板，再次启动不覆盖用户改过的模板
- [ ] 有 git 时是一个真正的仓库并有初始提交，没有 git 时有 `.git` 骨架
- [ ] bot 启动参数里的 cwd、`--session-dir` 是新路径，私聊和群聊共用 cwd、会话分开
- [ ] 身份块往返，表单改动只改块内，块外内容保持原样，文件里改块内内容能回填花名册
- [ ] overlay 只关用户级 AGENTS.md、CLAUDE.md、GEMINI.md
- [ ] persona.md 不再包含名字、角色、专属指令和说话方式
- [ ] 任一层 AGENTS.md 内容变化后进程复用签名改变
- [ ] omp-bot 改动 team 目录后多一次 git 提交
- [ ] 现有测试全部通过

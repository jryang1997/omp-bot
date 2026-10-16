# 01: bot 在 team 目录里启动

**What to build:** 新的团队目录模块。omp-bot 启动时建好 team 目录、团队 AGENTS.md 模板和 git 仓库。每个 bot 的 omp 进程以 `team/bots/<id>` 为 cwd 启动，会话按 scope 放在 `sessions/<scope>/`，身份写在自己的 AGENTS.md 身份块里，overlay 打开项目级上下文文件，persona.md 只剩团队工具说明。改身份后下一轮对话自动换上新的系统提示词，team 目录的改动自动提交。

**Blocked by:** None - can start immediately

**Status:** done

- [x] 第一次启动建出 spec 里的目录树、`.gitignore` 和团队 AGENTS.md 模板，再次启动不覆盖用户改过的模板
- [x] 有 git 时是一个真正的仓库并有初始提交，没有 git 时有 `.git` 骨架
- [x] bot 启动参数里的 cwd、`--session-dir` 是新路径，私聊和群聊共用 cwd、会话分开
- [x] 身份块往返，表单改动只改块内，块外内容保持原样，文件里改块内内容能回填花名册
- [x] overlay 只关用户级 AGENTS.md、CLAUDE.md、GEMINI.md
- [x] persona.md 不再包含名字、角色、专属指令和说话方式
- [x] 任一层 AGENTS.md 内容变化后进程复用签名改变
- [x] omp-bot 改动 team 目录后多一次 git 提交
- [x] 现有测试全部通过

落地记录：
- 新模块 `src/team.mjs`（TeamDir、teamPaths、身份块）。omp-bot 启动时建树、写一次模板、git init；没有 git 时建 `.git` 骨架，界面弹一次"装上 Git 后才有改动历史"。
- bot 的 cwd 是 `team/bots/<id>`，会话在 `sessions/<scope>/`。persona.md、isolate.yml、旧 agentDir 暂留 `home/bots/<id>/<scope>`，只放生成文件，不进 team 目录；04 再删。
- 身份块用 HTML 注释包住。表单只重写块内；文件里改块内会回填花名册并提交。bot 或用户在块外的改动不单独提交，跟着下一次 omp-bot 提交进历史。
- 同一轮里的多次改动合并成一次提交，说明用"；"连接。
- 签名加了 `context=` 摘要，任一层 AGENTS.md 变了下一轮换进程、续上会话。
- 证据：`test/team.mjs` 15/15；实机 omp 18.10.3 + 模拟模型 `proof/context-e2e.json` 全 pass；13 个测试文件全过，smoke-gui 55/55。


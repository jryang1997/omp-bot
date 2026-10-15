# 08 记忆每 bot 一库与共识写入

Type: research
Label: wayfinder:research
Status: resolved
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

## Answer

记忆换成 mnemopi，按 bot id 分库，库文件放进 team 目录。私有 agentDir 不再需要，`memory-config.mjs` 只留十来行。团队共识只走 `team/AGENTS.md`，不建团队记忆库。

### 实测

omp 18.10.3，同 06 的模拟环境。team 是 git 仓库，bot 的 cwd 是 `team/bots/<名>`，HOME 下只有 `models.yml`，没有设 `PI_CODING_AGENT_DIR`。为了结果可复现，用 `llmMode: none` 和 `noEmbeddings: true`，记忆存对话原文、全文检索。脚本和结果见 `omp-lab/memory-lab.mjs`、`omp-lab/memory-proof.json`。

- 默认的 per-project 按 cwd 分库。bot a 两个会话同时写，模拟私聊和群聊，bot b 同时写一条。a 召回自己的两条，b 只召回自己的一条。
- per-project-tagged 会读到用户的全局库。用户在自己项目里写进全局库的一条，bot 在 tagged 下召回了，per-project 下没有。
- per-project 的库名是 `<cwd 末段>-<绝对路径哈希>`，只看 cwd，不看 git 根（`pi-coding-agent/src/mnemopi/config.ts`）。把 team 目录整体搬走以后，per-project 一条都召回不到。
- `scoping: global` 加 `bank: bot-<id>` 不看路径。所有 bot 共用一个 SQLite 文件，三个进程同时写不丢，各自只召回自己的。搬走 team 目录后照样召回。
- `dbPath` 能把库放进 team 目录，和用户自己的记忆完全分开。
- 中文只靠全文检索不够。"冰淇淋""菠萝味的冰淇淋"能召回"我最喜欢菠萝味的冰淇淋"，"我喜欢什么口味的冰淇淋""我爱吃什么"召回不到。

### 推荐配置

每个 bot 的 overlay 写成这样。

```yaml
memory:
  backend: mnemopi
mnemopi:
  scoping: global
  bank: bot-<id>
  dbPath: <team>/.memory/mnemopi.db
  embeddingVariant: multilingual   # 待验，见下
autolearn:
  enabled: false
modelRoles:        # 沿用现有的 memoryModelRoles
  default: <选定模型>
  smol: <选定模型>
  memory: <选定模型>
```

- 名字叫 global，在这里的意思是这个 bot 只有一个库，私聊群聊、不同项目都用它。正好是 D5。
- `team/.memory/` 写进 team 仓库的 `.gitignore`。备份、迁移、删除 team 目录时记忆跟着走。
- 关掉 autolearn。它学到的技能写死在 `<agentDir>/managed-skills`，而且这个目录总会被发现（`src/autolearn/managed-skills.ts`、`src/discovery/builtin.ts`）。不改 agentDir 时，bot 学到的技能会出现在用户自己的 omp 里。记忆照常由 mnemopi 自动保存，bot 要新技能就写进自己的 `.omp/skills/`。
- mnemopi 的 smol 模式按 memory 角色选模型。现有的 `memoryModelRoles` 已经把它钉在 bot 选定的模型上，不会跑到用户别的提供方。

### 可删的代码

- `src/memory-config.mjs` 768 行，只留 `splitSelector` 和 `memoryModelRoles`，挪进 `persona.mjs`。私有 `models.yml` 生成、凭据剥离、前置检查都删掉。
- `src/bot.mjs` 里的 `agentDir`、`PI_CODING_AGENT_DIR` 和 `writePrivateMemoryConfig` 调用。会话文件本来就用 `--session-dir` 放在 bot 目录里，不受影响。
- `src/orchestrator.mjs` 和 `src/features/native.mjs` 里的 `memory_prereq_missing` 门槛。模型直接用用户的注册表，选的模型不可用时 omp 自己会报错。
- overlay 里 `backend: local` 那一段换成上面的配置。

### 共识写入

- 共识只写 `team/AGENTS.md`。它每次会话都完整进系统提示词，在 git 里有历史，用户能直接打开改。记忆召回是模糊检索，每次最多 8 条，共识放进去不一定被想起来。
- 沿用 DS Bot 的规矩。只有 Main Bot 和用户改 `team/AGENTS.md`，其他 bot 用 message_bot 转告 Main Bot。D7 只防误操作，所以这是约定，不做权限拦截。改错了靠 git 回滚，要不要每次改动自动提交留给 09。
- AGENTS.md 在会话开始时拼进系统提示词。常驻会话要重开才读到新版本，实施时要定什么时候重开。
- 以后真要团队记忆库，`bank` 能把它和用户的全局库隔开，实测团队库那条两个 bot 都召回、用户那条都没召回。现在不做。

### 私聊里的事会不会在群里说出来

会。同一个库，每个会话第一轮自动召回。实测私聊那条在 bot 的任何会话里都被召回。缓解办法如下。

- omp-bot 给每条进来的消息标上场景和发送者，例如"私聊，张三"或"群聊，产品群"。记忆存原文时来源跟着进库。
- `team/AGENTS.md` 写一条规矩。来自私聊的事在群里不主动提，除非本人在场并同意。
- 记忆面板能看、能删单条记忆。mnemopi 支持按条修改和遗忘。
- 更强的办法是群聊会话关掉自动召回，只留模型主动查。代价是 bot 在群里记性变差。先不做，交给用户定。

### 待验

- 中文语义召回要靠嵌入模型。沙盒里一次性的 `-p` 进程每次都在建索引时退出，日志一直是 resuming interrupted embedding rebuild，没测出来。要在 omp-bot 的常驻进程里比较 multilingual-e5-small 和默认 large 的下载体积、内存和召回效果。
- smol 模式抽取事实时花多少 token，抽完还留不留来源标注。
- Windows 上 `dbPath` 用带中文用户名的路径。

## Comments
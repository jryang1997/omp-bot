# 06 AGENTS.md 往上找的边界

Type: research
Label: wayfinder:research
Status: resolved
Blocked by:

## Question

bot 以 `team/bots/<名>` 为工作目录启动时，omp 会读到哪些 AGENTS.md，在哪里停。

## Why it matters

`src/persona.mjs` 现在逐文件关掉了项目级 AGENTS.md，用来防止 bot 的 workspace 指向用户项目时把项目规则带进来。team 方案要在 team 树里打开它，又不能顺着往上读到用户主目录或别的仓库。

## What to check

- 在 omp 18.10.3 实测三种布局各读到哪些文件。team 目录是 git 仓库；不是 git 仓库；外层还套着一个 git 仓库。
- bot 的 workspace 指向用户项目时，cwd 和 workspace 是否分开。cwd 决定上下文文件，工具仍能操作 workspace。
- `--append-system-prompt` 注入的 persona.md 还要不要。理想状态是只留 omp-bot 必须注入的团队工具说明，身份全部归 AGENTS.md。

## Done when

每种布局读到的文件清单写进 Answer，并给出 team 目录的推荐布局。

## Answer

team 目录做成 git 仓库，omp 往上找 AGENTS.md 就停在 team 根上。overlay 只关用户级 AGENTS.md，不再关项目级。这样 bot 读到 team 和自己两层，读不到用户主目录和别的仓库。

### 实测

omp 18.10.3，HOME 指向一个隔离目录，模型换成本地模拟服务，记录 omp 真正发出的系统提示词。脚本和结果见 `omp-lab/context-lab.mjs`、`omp-lab/context-proof.json`，可以重跑。每层 AGENTS.md 里放一个标记，看系统提示词里出现了哪些。bot 的 cwd 都是 `team/bots/xiaozhi`。

| 布局 | 读到的 |
| --- | --- |
| A team 是 git 仓库，外面一层有 AGENTS.md | 用户级、team、bot |
| B team 不是 git 仓库 | 用户级、外层、team、bot |
| C team 不是 git 仓库，套在外层仓库里 | 用户级、外层仓库根、team、bot |
| D team 是 git 仓库，又套在外层仓库里 | 用户级、team、bot |
| E 布局 A 加 `--add-dir` 指向带 AGENTS.md 的用户项目 | 用户级、team、bot、用户项目 |
| F 布局 A 加 omp-bot 现在的 overlay | 什么都不读 |
| G 布局 A，overlay 只关 `context-file:user:AGENTS.md` | team、bot |

- 往上找停在最近的 git 仓库根。不是仓库就一路找上去，所以 team 必须 `git init`，嵌套在别的仓库里也照样停在内层。
- 系统提示词的 `<repo-rules>` 里按 team、bot 的顺序排，先通用后具体，每段带文件路径。正好是共识层在上、个人在下。
- `disabledExtensions` 的 `context-file:project:AGENTS.md` 一关就是全部项目级文件，不能按路径挑。现在的 overlay 因此把 team 层也关掉了（F）。
- 基础系统提示词约 1.06 万字符，两层 AGENTS.md 只占它们自己的长度。

### cwd 和 workspace

omp-bot 现在就是分开的。cwd 是 bot 自己的目录，用户选的项目用 `--add-dir` 加进来，工具照样能读写它。新方案沿用。

代价是 E。打开项目级 AGENTS.md 以后，`--add-dir` 进来的项目里的 AGENTS.md 也会被读到。omp 没有只关这一处的开关。我的建议是接受它。bot 在用户项目里干活，本来就该守那个项目的规则。要不要这样，交给 09 号票问用户。如果用户不要，退路是继续关项目级文件，由 omp-bot 把 team 和 bot 两层拼进 `--append-system-prompt`。

### persona.md

还要，但只留 omp-bot 必须注入的内容，例如 message_bot 这些团队工具怎么用、渠道消息的格式。名字、角色、性格、做事规矩全部挪到 `team/bots/<名>/AGENTS.md`。这样用户在文件里改身份就能生效，不用经过 omp-bot 的表单。

### 推荐布局

```
team/                 git 仓库
  AGENTS.md           团队共识
  bots/<id>/AGENTS.md 个人身份
```

overlay 的 `disabledExtensions` 只留 `context-file:user:AGENTS.md`。目录名用 bot 的稳定 id，不用显示名，原因见 08。

## Comments
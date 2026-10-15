# 06 AGENTS.md 往上找的边界

Type: research
Label: wayfinder:research
Status: open
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

## Comments
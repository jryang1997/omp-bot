# 04: 可纠正的团队记忆（借 OpenMausBot、nanobot）

**What to build:** bot 可以提议一条团队事实（带来源），你或 Main Bot 接受后才写进共识层。替换旧事实时带版本，旧事实中途变了就拒绝。

**Blocked by:** 01

**Status:** done

- [x] 提议工具和待确认列表，接受、拒绝都有接口
- [x] 接受时检查版本，冲突就拒绝并提示重提
- [x] 接受后写进 team 目录并自动提交
- [x] 面板能看、能点

落地记录：

- e8a0661：`src/team-facts.mjs` 读写 team/AGENTS.md 文末的团队事实块（注释标出起止，每条 `- 事实（来源：…）`）。编排器 `proposeTeamFact`、`decideTeamProposal`、`addTeamFact`、`listTeamFacts`、`listTeamProposals`，台账新类别 `team_proposals`（pending、accepted、rejected、conflict）。工具 `propose_team_fact` 给所有助手，`review_team_proposals` 只给主助手，调用时再核对一次身份。接口只给主人。测试 `test/team-memory.mjs` 7 条，http-boundaries 加 7 条。变异 `proof/mutate-04.py` 9/9 抓到。
- 2de176f：任务页「团队事实待确认」和「现在的团队事实」（可纠正）。截图 `proof/ui/shot-team-facts.mjs` 10/10，覆盖接受写文件、撞车提示重提、纠正后旧说法再提被拒。
- 版本用"旧事实原文"代替 revision 号：替换时按文件现状核对那一条还在不在。用户直接手改文件也按现状判断，不会被覆盖。验收两条都过：纠正后旧事实不再写回；两个助手同时替换同一条，后一个被拒并提示重提。
- 只聊天档也给 `propose_team_fact`：它只记一条待确认，不改任何东西。runs.mjs 里钉死工具面的断言跟着改了。
- skip: 撞车后自动叫提议的助手重提（它不在等结果，为记账叫醒它不划算；任务页和主助手都看得到原因）
- skip: 用户手改文件删掉的旧说法不算"纠正过"（看不到手改的意图，只拦经过接受或纠正的）
- skip: 按工作区隔开团队事实（团队事实本来就是全队共享；提议里的来源可能带私聊信息，所以接口只给主人）
- skip: nanobot 那种按历史游标批量整理（plan 里只借了"用文件现状判断"这一条）

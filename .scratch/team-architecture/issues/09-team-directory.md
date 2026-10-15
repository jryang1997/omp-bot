# 09 team 目录放哪、怎么管

Type: grilling
Label: wayfinder:grilling
Status: open
Blocked by: 06, 07, 08

## Question

team 目录放在哪，要不要 git，用户怎么查看和编辑，旧数据怎么迁过来。

## Points

- 放在 `.ompbot/` 下面，还是用户看得见的位置。
- git init 给 omp 一个确定的仓库边界，也让用户能看到"这周学会了什么"，学错了能回滚。要定谁来 commit、多大粒度。
- 旧的 `bots/<id>/<scope>/{work,sessions,agent}` 怎么迁。sessions 仍按 scope 分开；work 和记忆合成一份时怎么去重。

## Done when

目录树、git 规则、迁移步骤写进 Answer。

## Comments

- 来自 06、07、08 的输入，问用户之前先读。
  - team 根必须 `git init`，否则 omp 会顺着往上读到外层的 AGENTS.md（06 布局 B、C）。
  - 打开项目级 AGENTS.md 以后，`--add-dir` 进来的用户项目的 AGENTS.md 也会被读到（06 布局 E）。要问用户接不接受。我建议接受。
  - bot 目录名用稳定 id，不用显示名。记忆按 `bank: bot-<id>` 存，和路径无关，但 06 的规则文件和 07 的私有技能都按目录找。
  - 记忆库放 `team/.memory/`，要 gitignore。如果用户想把 team 目录放进 OneDrive 之类的同步盘，要提醒 SQLite 和同步盘一起用可能损坏。
  - 共识只由 Main Bot 和用户写 `team/AGENTS.md`。要定改动是否自动 commit，粒度多大。
  - 旧的 local 记忆是生成的摘要文件，不能直接导进 mnemopi。迁移时可以把摘要里还有用的内容整理进各 bot 的 AGENTS.md，或者开一次会话让 bot 自己 retain。
  - 群聊会话要不要关自动召回，防止私聊内容被说出来（08）。

# 09 team 目录放哪、怎么管

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 06, 07, 08

## Question

team 目录放在哪，要不要 git，用户怎么查看和编辑，旧数据怎么迁过来。

## Points

- 放在 `.ompbot/` 下面，还是用户看得见的位置。
- git init 给 omp 一个确定的仓库边界，也让用户能看到"这周学会了什么"，学错了能回滚。要定谁来 commit、多大粒度。
- 旧的 `bots/<id>/<scope>/{work,sessions,agent}` 怎么迁。sessions 仍按 scope 分开；work 和记忆合成一份时怎么去重。

## Done when

目录树、git 规则、迁移步骤写进 Answer。

## Answer

2026-10-15 用户授权"能给建议的都按建议来"，下面按建议定。

### 位置

`~/.ompbot/team`，跟着 `OMPBOT_HOME` 走。Windows 资源管理器不会隐藏点开头的目录，界面再加一个"打开 team 目录"按钮。不放"文档"和"桌面"，这两个目录常被 OneDrive 接管，SQLite 记忆库和同步盘一起用可能损坏。

### 目录树

```
~/.ompbot/team/           git 仓库
  AGENTS.md               团队共识，Main Bot 和用户写
  .gitignore              忽略 .memory/、workspace/、bots/*/sessions/、bots/*/work/
  skills/<名>/SKILL.md    共享技能库
  workspace/              挂到客机 /workspace
  .memory/mnemopi.db      所有 bot 的记忆，按 bank: bot-<id> 分开
  bots/<id>/
    AGENTS.md             个人身份
    .omp/skills/          私有技能
    work/                 私有文件，挂到客机里这个 bot 的 ~/work
    sessions/<scope>/     会话仍按私聊、群聊分开
```

- 目录名用 bot 的稳定 id，改显示名不动目录。
- 04 留下的问题按它的建议定。`bots/<id>/work` 单独挂进客机，`uid=bot-<id>,umask=0077`，只有这个 bot 能看。
- `--add-dir` 带进来的项目 AGENTS.md 照读。bot 在用户项目里干活就守那个项目的规则。

### git 规则

- omp-bot 负责提交，bot 不直接跑 git。
- `AGENTS.md`、`skills/`、`bots/*/AGENTS.md`、`bots/*/.omp/skills/` 每次改动提交一次，提交信息写清谁改的、为什么改。
- 界面能看历史、能回滚单次改动。
- 记忆、共享工作区、会话不进 git。

### 迁移

旧数据是 `~/.ompbot/bots/<id>/<scope>/{work,sessions,agent}`。只复制，不删旧目录，用户确认后再清理。

1. 身份。花名册里的名字、角色、说明写成 `bots/<id>/AGENTS.md`。
2. 会话。`<scope>/sessions` 搬到 `bots/<id>/sessions/<scope>/`，续接不受影响。
3. 工作文件。私聊 scope 的 `work` 放进 `bots/<id>/work/`，其他 scope 放进 `bots/<id>/work/from-<scope>/`。不做自动去重，同名文件都保留。
4. 记忆。旧的 local 记忆是生成的摘要，不能直接导入。迁移时给每个开过记忆的 bot 开一次会话，把摘要交给它 retain 进新库。原文件保留。
5. 私有技能搬到 `bots/<id>/.omp/skills/`，和库里重名的改名并提示用户。

### 群聊召回

群聊照常自动召回。私聊内容外泄靠 08 的三条缓解，消息标场景和发送者、AGENTS.md 写规矩、面板能删记忆。

## Comments

- 来自 06、07、08 的输入，问用户之前先读。
  - team 根必须 `git init`，否则 omp 会顺着往上读到外层的 AGENTS.md（06 布局 B、C）。
  - 打开项目级 AGENTS.md 以后，`--add-dir` 进来的用户项目的 AGENTS.md 也会被读到（06 布局 E）。要问用户接不接受。我建议接受。
  - bot 目录名用稳定 id，不用显示名。记忆按 `bank: bot-<id>` 存，和路径无关，但 06 的规则文件和 07 的私有技能都按目录找。
  - 记忆库放 `team/.memory/`，要 gitignore。如果用户想把 team 目录放进 OneDrive 之类的同步盘，要提醒 SQLite 和同步盘一起用可能损坏。
  - 共识只由 Main Bot 和用户写 `team/AGENTS.md`。要定改动是否自动 commit，粒度多大。
  - 旧的 local 记忆是生成的摘要文件，不能直接导进 mnemopi。迁移时可以把摘要里还有用的内容整理进各 bot 的 AGENTS.md，或者开一次会话让 bot 自己 retain。
  - 群聊会话要不要关自动召回，防止私聊内容被说出来（08）。

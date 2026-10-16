# omp_bot

omp_bot 的领域用语。模型历史与面向用户的展示状态分别命名。

## 领域用语

**会话投影**
用户在私聊或群聊中看到的消息、任务状态和执行过程的展示状态。它可以根据已保存的记录与实时事件重新形成，不是模型历史的权威来源。

**团队目录**
omp-bot 数据目录下的 `team/`，一个 git 仓库。上层是共识层、技能库和共享工作区 `workspace/`，下层 `bots/<id>/` 是每个 bot 的身份、私有技能、私有文件 `work/` 和会话。bot 的 omp 进程 cwd 是 `team/bots/<id>`。路径只由 `src/team.mjs` 给出。
_不要说_：bot 目录、私有 agentDir（0.1.x 的旧结构）。

**共识层**
`team/AGENTS.md`，所有 bot 共用的规矩：说话方式、征求同意、两台机器的分工、共享电脑规则。omp 当项目级上下文读，只有用户和 Main Bot 改，omp-bot 只在第一次创建时写模板。和每个 bot 的 `bots/<id>/AGENTS.md`（个人身份）合起来是 bot 读到的两层。
_不要说_：团队记忆。共识只走这个文件，不进记忆库。

**身份块**
`bots/<id>/AGENTS.md` 里由 omp-bot 管理的一段，HTML 注释标出起止，内容是名字、角色和专属指令。表单只重写这一块，块外的内容属于用户和 bot。

**技能库**
`team/skills/<name>/SKILL.md`，所有 bot 共用的技能，经 overlay 的 `skills.customDirectories` 交给 omp。每个 bot 用白名单（`bot.skills`）勾选，null 表示库里全部。私有技能放 `bots/<id>/.omp/skills/`，总是加载。库里和任何私有技能不许重名。

**共享电脑**
所有 bot 共用的一台 Linux 虚拟机（QEMU），默认 4 vCPU、8 GiB、64 GiB 动态磁盘。bot 绑定电脑就是在共享电脑上得到一个座席。最后一个座席停掉后自动关机。
_不要说_：bot 的电脑、独立电脑（0.1.x 每个 bot 一台，现在叫旧电脑）。

**座席**
一个 bot 在共享电脑里的份：自己的 Linux 用户（team 组，主目录 0700，没有 sudo）、Xvfb 屏幕和 spacesd。电脑 id 指的就是座席。`/workspace` 挂本机的 `team/workspace`，`~/work` 挂这个 bot 的 `team/bots/<id>/work`。

**管理通道**
共享电脑里 root 运行的 spacesd。座席层经它跑 `guest/omp-seat` 建座席、挂文件、装包、发布登录、解旧电脑的包。模型碰不到它。

**登录屏**
共享电脑里第 17 个座席，用户 `omp-login`，不属于任何 bot。用户在上面登录网站点「完成」，cookie 发布到 root:team 只读的共享登录库，所有 bot 的浏览器下次启动时并进来。

**旧电脑**
0.1.x 每个 bot 一台的虚拟机。升级后它的 `/work` 和主目录自动复制到对应座席的 `~/old-computer/`，磁盘保留到用户点「删除旧电脑」。

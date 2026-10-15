# 团队架构重构 本机 bot 团队与一台共享 Linux 电脑

Status: ready-for-agent

来源是 wayfinder 地图 `../team-architecture/map.md` 的 D1 到 D19，每条结论的实测都在那边对应的票里。

## Problem Statement

用户在 Windows 上用 omp-bot 养了一支 bot 团队。现在有四件事让它不好用。

- bot 一绑定电脑就变弱。为了让它只用客机工具，omp-bot 关掉了本机的 omp 原生工具、扩展、技能和 MCP，bot 拿到电脑反而失去了原本的能力。
- 每个 bot 一台虚拟机，每台 2 vCPU、2 GiB。bot 一多，宿主内存先撑不住。bot 之间也没法在同一台电脑上交接文件，用户登录过的网站每台都要重新登。
- bot 的身份、技能和记忆散在各自的私有目录里，按私聊、群聊分开。团队共识没有地方写，一个 bot 私聊里学到的东西到了群里就忘了。技能只能逐个装进每个 bot。
- 头像是 DS Bot 的角色，只有两种状态，用户不能选也不能上传。

## Solution

bot 继续住在 Windows 本机，是本机的 omp agent。所有 bot 共用一台 Linux 虚拟机，当作分给团队的一台电脑，每个 bot 在里面有自己的 Linux 用户、屏幕和主目录，`/workspace` 大家共用。绑定电脑只是在本机能力之上加客机工具。

团队的文件放在一个 team 目录里。上层是团队共识、共享技能库和共享工作区，下层是每个 bot 自己的身份、私有技能、文件和会话。每个 bot 一个记忆库，私聊群聊通用。

审批收成 3 档。头像换成 OpenMausBot 的吉祥物，可以选身体、颜色、表情，也可以上传图片。

## User Stories

1. 作为用户，我想让绑定了电脑的 bot 仍然能用本机的 omp 工具、技能和 MCP，这样它拿到电脑不会变弱。
2. 作为用户，我想让所有 bot 共用一台 Linux 电脑，这样宿主只多跑一台虚拟机。
3. 作为用户，我想让每个 bot 在共享电脑里有自己的屏幕，这样几个 bot 能同时开浏览器干活，不互相抢鼠标。
4. 作为用户，我想让每个 bot 在共享电脑里有自己的主目录，别的 bot 读不到，这样一个 bot 的误操作不会删掉别人的东西。
5. 作为用户，我想在本机的 team 工作区和共享电脑的 `/workspace` 看到同一份文件，这样我在 Windows 里放的资料 bot 马上能用，bot 做好的东西我马上能拿。
6. 作为 bot，我想在共享电脑里用 `~/work` 访问我在本机的私有文件夹，这样两台机器上的私有文件是同一份。
7. 作为 bot，我想在共享电脑里装软件、开浏览器、跑构建都不用等用户批准，这样我能连续把事做完。
8. 作为用户，我想在 bot 要往共享电脑装系统包时被问一次，这样系统层面的改动我心里有数。
9. 作为用户，我想在一块专门的登录屏上登录一次网站，之后所有 bot 打开浏览器都是登录状态。
10. 作为用户，我想在 bot 不小心退出共享网站时，只要在登录屏重登一次就让所有 bot 恢复。
11. 作为 bot，我想保留我自己在别的网站上的登录，这样共享登录同步时不会冲掉我的。
12. 作为用户，我想让旧的每 bot 电脑里的文件自动搬进共享电脑，这样换架构不丢东西。
13. 作为用户，我想自己决定什么时候删掉旧电脑的磁盘，这样我确认搬完了再删。
14. 作为用户，我想在一个 `team/AGENTS.md` 里写团队共识，所有 bot 每次会话都读到它。
15. 作为用户，我想直接在文件里改 bot 的身份，或者继续用界面上的表单改，两边都生效。
16. 作为 Main Bot，我想能改 `team/AGENTS.md`，其他 bot 要改共识时来找我，这样共识有人把关。
17. 作为用户，我想看到 team 目录每次改动的历史，改错了能回滚。
18. 作为用户，我想把一个技能装进共享技能库，再给需要的 bot 勾选，不用每个 bot 装一遍。
19. 作为用户，我想让每个 bot 只看到分给它的技能，这样它不被无关技能干扰。
20. 作为用户，我想 bot 自己写的私有技能照样能用，而且不会和库里的重名。
21. 作为用户，我想让 bot 在私聊里记住的事在群里也记得，这样我不用每个场合都重说一遍。
22. 作为用户，我想让 bot 的记忆和我自己 omp 的记忆分开，这样 bot 读不到我的私人记忆。
23. 作为用户，我想让 bot 在群里不主动提私聊里的私事。
24. 作为用户，我想把 team 目录整个拷走或备份，记忆、身份、技能都跟着走。
25. 作为用户，我想只在三种权限里选一种，只聊天、本机改东西先问我、全部放手，不用理解执行档乘审批档的 9 种组合。
26. 作为老用户，我想升级后每个 bot 自动落到对应的新档位，不用重新设置。
27. 作为用户，我想 bot 在付款、对外发消息、删除账号数据前先问我。
28. 作为用户，我想从 10 种身体和 10 种颜色里给 bot 选形象。
29. 作为用户，我想给 bot 选一个固定表情，或者让它随运行状态自动换表情。
30. 作为用户，我想给 bot 上传一张图片当头像，并能裁切、缩放。
31. 作为用户，我想一眼认出 Main Bot，它的形象固定，别的 bot 用不了。
32. 作为用户，我想在侧边栏一眼看出哪个 bot 正在工作，工作中的头像会动，其余静止。
33. 作为用户，我想群头像也用新的吉祥物拼出来。
34. 作为老用户，我想升级后已有 bot 自动有一个吉祥物形象，不用一个个去选。
35. 作为系统设置了减少动态效果的用户，我想头像不再晃动。
36. 作为用户，我想共享电脑默认规格能撑住五六个 bot 同时开浏览器，内存和 CPU 可以按我的宿主调整。
37. 作为用户，我想在界面上看清共享电脑的状态，以及每个 bot 的屏幕是否就绪。
38. 作为用户，我想在任何一个 bot 的屏幕上接管鼠标键盘，用完交还。
39. 作为维护者，我想有一份 ADR 写明为什么推翻"电脑模式下不能有本机工具"，免得以后有人改回去。
40. 作为维护者，我想 README、CHANGELOG 和术语表跟上新架构。

## Implementation Decisions

### 团队目录

- team 目录在 omp-bot 数据目录下，默认 `~/.ompbot/team`。结构如下。

  ```
  team/                     git 仓库，omp 往上找 AGENTS.md 停在这里
    AGENTS.md               团队共识
    .gitignore              .memory/ workspace/ bots/*/sessions/ bots/*/work/
    skills/<name>/SKILL.md  共享技能库
    workspace/              共享工作区，客机挂到 /workspace
    .memory/mnemopi.db      所有 bot 的记忆库，按 bank 分
    bots/<id>/AGENTS.md     个人身份
    bots/<id>/.omp/skills/  私有技能
    bots/<id>/work/         私有文件，客机挂到 ~/work
    bots/<id>/sessions/<scope>/  会话，scope 是 private 或 room_<群 id>
  ```

- bot 的 omp 进程 cwd 是 `team/bots/<id>`，私聊群聊同一个 cwd，会话目录按 scope 分开。用户选的项目目录仍用 `--add-dir` 加进来。
- 一个新的团队目录模块负责建目录、写模板、生成身份、提交 git、迁移旧数据。它对外给出每个 bot 的各类路径，别的模块不再自己拼路径。
- 有 git 就 `git init`，每次 omp-bot 改动 team 目录后自动提交一次，提交信息写改了什么。没有 git 时手工建一个空仓库的 `.git` 骨架，让 omp 照样停在 team 根上，界面提示装 Git 才有改动历史。omp 判断仓库根只看有没有名为 `.git` 的条目。
- `bots/<id>/AGENTS.md` 里有一段由 omp-bot 管理的身份块，用 HTML 注释标出起止，内容是名字、角色和专属指令。表单改动只重写这一块，块外的内容属于用户和 bot，omp-bot 不碰。用户在文件里改了身份块，下次读花名册时以文件为准回填表单。
- `team/AGENTS.md` 第一次创建时写入模板。内容包括说话方式和征求同意的默认规矩（从现在的 persona 挪过来）、两台机器的分工、共享电脑使用规则、付款等事项先问用户、私聊的事在群里不主动提、只有 Main Bot 和用户改这个文件。之后 omp-bot 不再改它。
- persona.md 只留团队工具和渠道消息格式的说明。
- overlay 只关用户级的 AGENTS.md、CLAUDE.md、GEMINI.md，项目级都打开，bot 读到 team 和自己两层。
- 进程复用签名加上两层 AGENTS.md 的内容摘要。文件变了，下一轮对话前重启进程并续上原会话，让新内容进系统提示词。
- 旧数据只复制。旧的 `bots/<id>/<scope>/work` 合并进 `bots/<id>/work`，私聊的放在根上，群聊的放进 `rooms/<scope>/`。旧会话复制进 `sessions/<scope>/`。旧的私有技能复制进 `.omp/skills/`。迁移完成在 team 目录里留一个标记，重复启动不再迁移。
- 旧的 local 记忆不导入 mnemopi。把旧记忆摘要复制进 `bots/<id>/work/old-memory/`，身份块里提示 bot 需要时去读。

### 技能库

- overlay 写 `skills.customDirectories` 指向 `team/skills`，白名单沿用 `bot.skills`，通过 `--skills` 传给 omp。
- 白名单为 null 表示库里全部技能。私有技能总是并进白名单。并完为空时传 `--no-skills`。
- 安装技能时选"装进共享库"或"只给这个 bot"。库里和任何 bot 的私有技能都不允许重名，重名直接拒绝并说明。

### 记忆

- 开启记忆的 bot 用 mnemopi，`scoping: global`、`bank: bot-<id>`、`dbPath` 指向 `team/.memory/mnemopi.db`，autolearn 关掉，记忆模型角色钉在 bot 选定的模型上。
- 不再改 `PI_CODING_AGENT_DIR`。私有 models.yml 生成、凭据剥离和 `memory_prereq_missing` 门槛全部删掉。
- 嵌入模型实施时在常驻进程里验中文召回，选 multilingual 系列里内存可接受的一档写进 overlay，结论写进 CHANGELOG。
- omp-bot 发给 bot 的每条消息带上场景和发送者，例如"私聊，张三"或"群聊，产品群"，记忆存原文时来源跟着进库。

### 审批

- 用户只看到 3 档，只聊天、本机改东西先问我、全部放手。内部仍存执行档和审批档，3 档各对应一种组合，分别是 chat、supervised 加 write、full 加 yolo。
- 读取花名册和接收接口参数时把任意旧组合归一。chat 归只聊天，审批档 yolo 归全部放手，其余归本机改东西先问我。
- 共享电脑工具在 overlay 里全部 allow，只有装系统包的工具设为 prompt。omp 在任何审批档下都尊重用户级的 prompt，所以全部放手档也会问。

### 电脑能力改成加法

- 删掉绑定电脑时加的 `--no-tools --no-extensions --no-skills`，删掉绑定电脑时关项目 MCP、逐个关用户 MCP 的 overlay 段。chat 档的收窄和运行时工具面校验保留。
- 电脑档的运行时工具面校验和对应披露文案删掉，改成说明本机和共享电脑两套工具都在。
- 客机工具描述开头写"在 Linux 共享电脑里"。新增一个装系统包的客机工具，参数是包名列表，按 Debian 包名规则校验，由管理通道以 root 运行 apt。
- 客机工具的路径不再限制在 `/work` 和 `/tmp`，权限交给客机的 Linux 用户。默认工作目录是 `~/work`，工具接受 `~` 开头的路径。

### 共享电脑

- 现有的虚拟机后端保留，改成能被一个新的座席层调用。座席层对外接口和现在的电脑后端一样，仍按电脑 id 区分，电脑 id 现在指一个 bot 的座席。这样上层的租约、接管、工具和界面都不用改。
- 共享虚拟机只有一台，默认 4 vCPU、8 GiB、64 GiB 动态磁盘，可调范围是内存 4 到 16 GiB、vCPU 2 到 8 且不超过宿主逻辑核数减 2。QEMU 启动时预先转发 17 个座席端口，16 个给 bot，1 个给登录屏。
- 管理通道就是客机里 root 运行的那个 spacesd。座席层通过它运行客机里的座席脚本，给 bot 建用户、起屏幕和 spacesd、挂文件、装包、发布登录。
- 每个座席是一个 Linux 用户，加入 team 组，主目录 0700，没有 sudo。用户自己的 Xvfb 屏只认自己的 X cookie，spacesd 用自己的令牌，加 `--quic-port 0`。令牌由宿主生成，写进客机时只给这个用户读。
- 停止一个 bot 的电脑只停它的座席进程。最后一个座席停掉后关虚拟机。
- 状态里给出虚拟机状态和这个座席是否就绪。

### 共享文件

- omp-bot 内置一个 SFTP 服务，基于 `ssh2` 包，只监听 127.0.0.1，只认一把由 omp-bot 生成的密钥。它导出两类根，`team/workspace` 和每个 bot 的 `bots/<id>/work`，按 SFTP 用户名区分，拒绝 `..` 和越出根的符号链接。
- 客机通过 QEMU 用户网络的 10.0.2.2 连回宿主。`/workspace` 由 root 用 sshfs 挂载，归 team 组可写。每个 bot 的 `~/work` 以该 bot 用户身份挂载，只有它能读写。挂载参数关闭缓存。
- 依赖和构建产物放客机本地盘，写进 `team/AGENTS.md`。

### 共享登录

- 登录屏用户 `omp-login` 有自己的屏幕和 spacesd，不属于任何 bot。界面上"登录网站"打开它，用户接管、登录、点"完成"。
- "完成"时座席层经管理通道运行 `omp-login-sync publish`，把 cookie 发布到 root:team 只读的共享库。
- 客机的 Chromium 启动钩子给所有 profile 加 `--password-store=basic` 和 256 MiB 磁盘缓存上限，并以 bot 用户身份运行 `omp-login-sync sync`，把共享 cookie 并进自己的 profile。只同步 cookie，不开调试端口。
- 客机脚本随仓库发布，客机镜像构建时装进去。已有镜像由座席层在第一次就绪时经管理通道补装。

### 旧电脑迁移

- 共享电脑第一次就绪后，座席层依次处理每台旧的每 bot 电脑。开机，把 `/work` 和主目录打包，经宿主中转，以 bot 用户身份解到它座席的 `~/old-computer/`，不覆盖已有文件，已复制过的跳过，完成后关机。
- 旧磁盘和记录保留。界面上每台旧电脑有"删除旧电脑"，用户点了才删。

### 头像

- 头像用一个原生自定义元素，引擎从 OpenMausBot 原样取出，打包成一个文件放进 web 的 vendor 目录，替换 DS Bot 角色文件。打包脚本放在 scripts 里，记录上游 commit。
- 花名册加头像字段，包括身体、颜色、表情、裁切方式、上传图片地址、缩放和焦点。已有 bot 按 id 确定性分配颜色，身体默认 cursor，默认身体是一个常量。
- Main Bot 固定 star 身体和颜色 `#4D6BFE`，这个颜色不在 10 色里，接口拒绝其他 bot 用它，也拒绝改 Main Bot 的形象。
- 运行状态对表情的映射：空闲 idle，思考 thinking，调用工具 working，等审批 alerting，出错 sad，刚完成 happy 一下再回 idle。用户选了固定表情时只在工作中切换到 working。
- 侧边栏和列表里只有工作中、有未读或刚发生事件的头像才动，其余暂停。48px 以下 30 帧。滚出视口的不画。
- 上传图片走现有附件接口，只接受 PNG、JPEG、GIF、WebP。裁切方式有吉祥物、圆形、圆角、方形，缩放 1 到 3 倍。
- 群头像用现在的座位布局，每个座位放一个吉祥物或图片。
- NOTICE 写明来源、commit、Apache-2.0 和 "Made with Blob Studio"，附上游 LICENSE。产品里不出现 OpenMausBot 和 MausBot 的名字，吉祥物不当 omp-bot 的图标。
- README 里 DS Bot 的上游链接从 FeiZhuLulu 改成 Fei2411。

### 文档

- 新增 ADR，推翻 `.scratch/bot-computers/spec.md` 完成条件 2，理由是那条限制让 bot 一拿到电脑就失去 omp 原生能力。
- 术语表补共享电脑、座席、团队目录、共识层、技能库。
- README 和 CHANGELOG 更新。

## Testing Decisions

- 好测试只看外部行为，例如启动参数、overlay 内容、磁盘上的文件、接口返回和客机里的真实效果，不看私有函数。
- 团队目录模块用临时目录测。建目录和模板，身份块往返，块外内容不被改，git 提交，没有 git 时的骨架，迁移只复制、可重复、不覆盖。参照现有 `test/unit.mjs` 的写法。
- BotRuntime 的启动参数和 overlay 用现有单元测试的方式断言。绑定电脑时没有 `--no-tools`，技能白名单并入私有技能，记忆段是 mnemopi，审批段有装包 prompt，cwd 和会话目录是新路径。
- 3 档归一用表驱动测试覆盖 9 种旧组合，再经 HTTP 接口测一次，参照 `test/http-boundaries.mjs`。
- 座席层用一个替身虚拟机后端测接口语义，状态、建座席、停座席、最后一个停掉关机。再在沙盒里用真实的 Xvfb、spacesd 和座席脚本跑一遍端到端，替身只换掉 QEMU，参照 wayfinder 的 `screens-proof/` 和 `size-proof/`。
- SFTP 服务在沙盒里用真实 sshfs 挂载测双向读写、改名、并发追加、越界拒绝和错误密钥拒绝，参照 `files-proof/`。
- 共享登录沿用 `login-proof/` 的假网站测试，改成调用仓库里的正式脚本。
- 头像用 Playwright 截图测渲染，测接口校验 Main Bot 和颜色规则，测已有 bot 的默认形象。
- 现有 12 个测试文件全部保持通过。真实 QEMU 和 Windows 上的端到端留给用户实机跑 `smoke:computers`，最终报告列出步骤。

## Out of Scope

- 应用内登录模型提供方，替代终端 `omp login`。
- 云电脑和付费云资源。
- 安卓伴侣、飞书渠道的改动。
- AI 生成头像。
- 团队记忆库。共识只走 `team/AGENTS.md`。
- 按网站分配登录。登录全员共用。
- 用 localStorage 或 IndexedDB 保存登录状态的网站。
- 宿主侧的强制隔离。隔离只防误操作。

## Further Notes

- 吉祥物形象是 Supamaus Software Private Limited 的商标。给上游的 issue 草稿在 `../team-architecture/mascot-proto/upstream-issue-draft.md`，由用户发。上游回复前可以本地实现和自用，发布版本前要等回复。上游不同意就保留引擎，换掉身体和脸。
- 记忆默认仍是关，和现在一样。开启后不再有前置门槛。
- 真实 QEMU、WHPX 内存占用、Windows 上的 SFTP 回连和镜像补装只能实机验证。

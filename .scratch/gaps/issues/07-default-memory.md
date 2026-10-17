# 07: 默认轻量记忆

**What to build:** 不下 2.7GB 模型也能有每 bot 记忆。

**Blocked by:** 无

**Status:** done

- [x] 不换记忆后端。bot 自己的长期笔记记进工作目录 AGENTS.md 身份块后面
- [x] persona 里加一句：记什么（偏好、约定、踩过的坑）、记在哪、带日期和来源、别碰身份块、别记密钥
- [x] `test/team.mjs` 断言这句在；删掉这句的变异抓到

## Comments

查了 OMP 的五种记忆后端（docs/memory.md）。

- `local`：启动时让模型读旧会话做抽取和合并，要花 token；只处理闲了 12 小时以上的会话，bot 是一个常驻会话，效果差。仓库以前就用过 local，后来迁走了（team.mjs 里的 old-memory 迁移）。
- `autolearn`：会带上 `manage_skill` 和常驻提示，还要配记忆后端，影响面大，在这里没法实跑验证。
- `mnemopi`：现在的"开启记忆"，要下嵌入模型，保持不动。

更直接的路已经在仓库里：OMP 每次开会话都读 bot 工作目录的 AGENTS.md；身份块外面本来就留给"你和用户"（BOT_AGENTS_TAIL），omp-bot 不碰；team 目录有 git，笔记有版本历史，主人能直接看能改。缺的只是告诉 bot 可以这么记。零下载，零后台 token，按 bot 天然隔离。

代价：AGENTS.md 一改，进程复用签名就变，下一回合重启进程（会话照常续接），提示缓存失效一次。笔记不常写，可以接受。chat 档不能写文件，这句话写的是"能写文件时"。

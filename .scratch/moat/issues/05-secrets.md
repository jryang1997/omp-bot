# 05: 秘密不进模型（借 Muse、dots，用 OMP secrets）

**What to build:** 打开 OMP 自带的秘密占位符。核实共享电脑里没有绕过宿主的出站凭据。

**Blocked by:** 无

**Status:** done

- [x] 弄清 OMP secrets 的配置方式和默认值
- [x] overlay 打开它，证明发给模型的内容里只有占位符
- [x] 共享电脑里凭据的核查结论

落地记录：

- 调研：OMP 的 `secrets.enabled` 默认关。打开后秘密来源有四种：用户 agent 目录的 `secrets.yml`、`<cwd>/.omp/secrets.yml`（cwd 是 `team/bots/<id>`）、名字像密钥的环境变量值、内置凭据模式（`sk-`、`ghp_` 之类）。发给模型前换成 `$$…$$` 形式的占位符，工具执行前换回。
- d3cd9e1：overlay 三档都写 `secrets: enabled: true`。团队 `.gitignore` 加 `bots/*/.omp/secrets.yml`；老团队启动时补上缺的会话目录、mcp.json、secrets.yml 忽略行，用户的行不动，单独提交。测试 team.mjs 2 条、seats.mjs 1 条。变异 `proof/mutate-05.py` 6/6 抓到。
- 证明 `proof/secrets/prove-secrets.mjs`（结果在 `prove-secrets.txt`）8/8：用 omp-bot 生成的真实 overlay 跑真实 omp 18.10.3 和假模型服务，秘密放在 bot 的 secrets.yml、OMP_ 前缀环境变量和用户消息里的 ghp_ 令牌。打开时模型请求里三种原文都没有、有占位符；去掉 secrets 两行三种都泄露。
- 验收改写：本地会话 jsonl 里仍是原文，这是 OMP 的设计（工具要原文）。所以验收改成"发给模型的内容里没有，本地会话文件有、不进 git"。
- 共享电脑核查结论：经管理通道进客机的只有 OMP_SEAT_TOKEN、OMP_SEAT_LISTEN 和 OMP_SHARE_*（座席令牌、自己的 SFTP 钥匙 0400、workspace 钥匙 root 管）。没有模型密钥和 OMPBOT_TOKEN，`computer_shell` 不带宿主环境。已知缺口：客机直接上网、共用网站 cookie，浏览器动作不经宿主审批（设计如此，只有装包要批）。
- skip: 会话文件脱敏（OMP 的设计，续接会话和工具都要原文；靠不进 git 兜住）
- skip: Sentinel 式出站代理（客机直接上网加共用 cookie 是已知缺口，记成研究项，不自建）
- skip: 工作台里配秘密的界面（在 secrets.yml 里配就够，先不做）

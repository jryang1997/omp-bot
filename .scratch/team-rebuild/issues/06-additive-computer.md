# 06: 绑定电脑只加能力

**What to build:** 绑定电脑的 bot 保留本机 omp 原生工具、扩展、技能和 MCP，客机工具加在上面。客机工具在两种可执行档里都不弹审批，描述写明在 Linux 共享电脑里。电脑档的工具面校验和披露文案换成两套工具都在的说明。

**Blocked by:** None - can start immediately

**Status:** done

- [x] 绑定电脑的 bot 启动参数里没有 `--no-tools`、`--no-extensions`、`--no-skills`
- [x] overlay 不再因为绑定电脑关项目 MCP 或用户 MCP
- [x] overlay 把所有客机工具设为 allow
- [x] chat 档的收窄和工具面校验不变
- [x] 客机工具描述以"在 Linux 共享电脑里"开头
- [x] 能力面板和运行时文案不再说电脑模式没有本机工具

落地记录：收窄只剩 chat 档（BotRuntime.narrowedTools）。客机工具名移到 src/constants.mjs，overlay 按 COMPUTER_PROMPT_TOOLS 写 prompt，其余 allow（装包工具在 07 加入）。顺带删掉 computer_host_escape_denied 委派边界：绑定电脑的 bot 自己就有本机工具，这条边界没有意义了。POLICY_VERSION 升到 3，旧进程不会被复用。smoke-computers 的审批步骤改成断言共享电脑命令不弹审批，待实机跑。

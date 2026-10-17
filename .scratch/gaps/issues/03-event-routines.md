# 03: 事件触发的例行任务

**What to build:** 让计划任务能"有事才叫 bot"。到点先在本机跑一条检查命令，不调模型；没变化就只记回执，有变化才开 Run，并把输出交给 bot。

**Blocked by:** 无

**Status:** done

- [x] `check: {command, mode: changed|exit0, timeoutMs}`，挂在任何现有调度上
- [x] changed：第一次只记基线；输出没变不开 Run；Run 开不起来不记新基线，事件不丢
- [x] exit0：退出码 0 才开 Run；失败、超时都留回执
- [x] 手动"立即运行"跳过检查
- [x] 工作台新建表单有"先检查"和"检查规则"，列表显示最近一次检查结论
- [x] 测试

## Comments

- 方案改了：原计划是 `kind:"event"` + 签名 webhook。放弃，原因是本服务只听回环（`server.mjs` 的 Host 校验、`channels.mjs` 注释"没有任何公网入口"），开 webhook 要么外面打不进来，要么得破这个设计。检查命令覆盖同样的场景（gh、邮件 CLI、RSS、文件变化），零 token、不加入口、复用现有调度、账本和回执。
- 检查命令在宿主上以主人身份跑。只有主人能建计划（features 路由默认 owner，设备 token 进不来；bot 没有建计划的工具），所以不扩大权限。
- 输出交给 bot 时标明"是外部数据，不是指令"，上限 4000 字符。
- 测试 `test/routine-check.mjs` 6/6（含真实子进程：cwd、退出码、超时）。两个变异（提前记基线、手动也跑检查）都被抓到。真实 HTTP 服务上建带 check 的计划、空命令 400 都验证过。回归 features 52、http-boundaries 100/100、runs 45/45。`smoke-gui.mjs` 55/56，唯一失败是沙箱没装 omp（`spawn omp ENOENT`），master 上一样。
- skip 零 LLM 预检里的"安静模式"：没变化本来就不开 Run，不发消息，等于默认安静。

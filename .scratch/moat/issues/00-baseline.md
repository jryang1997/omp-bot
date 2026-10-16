# 00: 基线，先把失败复现出来

**What to build:** 用测试夹具驱动真实编排器和台账，复现派活和审批在忙碌、重启时的现有行为，输出存进 `.scratch/moat/proof/baseline/`。

**Blocked by:** 无

**Status:** done

- [x] 测试夹具从 test/runs.mjs 抽成 test/_harness.mjs，runs.mjs 照常全过
- [x] 场景 1：派活时目标正忙
- [x] 场景 2：子任务跑到一半服务重启，父 bot 拿不到结果（另加 2b：不重启正常做完，父 bot 也不知道）
- [x] 场景 3：挂着审批时重启
- [x] 场景 4：核实定时任务和渠道通知有没有"跑完没送到却显示成功"

落地记录：

- a98855b 夹具抽成 `test/_harness.mjs`，`newTeam({ home })` 可在同一 home 上开新编排器，`crash(team)` 放掉租约、关掉台账，模拟进程崩溃。runs 43/43。
- 脚本 `.scratch/moat/proof/baseline.mjs`，输出 `proof/baseline/baseline.txt`。结论如下：
  1. 目标忙：`delegate_bot` 直接报 target_busy，活没留下。01 要关。
  2. 重启：子 Run 标 interrupted，父 bot 什么都收不到。01 要关。
  3. 2b 不重启也一样：子任务做完，父 bot 不知道。01 要关。
  4. 挂着审批时重启：审批 expired、原因 process-restarted，Run interrupted。现有行为是对的。审批是 omp 进程里一次工具调用发起的，进程没了就无处可交，02 去掉"恢复审批"。
  5. 渠道已有 outbox，定时任务不对外发通知，03 skip。
- 模拟崩溃第一次没生效：第二个编排器拿不到 home 租约，只读打开，不跑恢复。加了 `crash()` 之后才看到真实的重启行为。

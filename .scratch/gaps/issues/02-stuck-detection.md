# 02: 卡住/死循环检测

**What to build:** 编排器给每次工具调用算指纹（工具名+参数+结果）。同一指纹连续出现 3 次，steer 一句换策略；之后再重复，取消这次 Run 并说明原因。

**Blocked by:** 无

**Status:** done

- [x] 指纹只用确定性数据，不调模型
- [x] 第 3 次 steer，第 6 次取消（常量 `STUCK_STEER_AT`、`STUCK_CANCEL_AT`）
- [x] 测试：重复调用触发，结果变了不触发，交替打转也抓

## Comments

- 实现：`src/stuck.mjs` 纯函数检测器；`orchestrator._watchStuck` 吃原始 `tool_execution_start/end` 帧（形状照 OMP `packages/agent/src/types.ts`），命中发 `run_stuck` 事件（进台账和 SSE），steer 走现有 `steerRun`，取消走现有 `cancelRun`，原因写进 Run 的 error。
- 指纹 = 工具名 + 参数 + 结果 content + isError。details 不算，里面常有耗时。按整次 Run 计数，A、B 交替也能抓。
- 取消阈值从 5 放到 6：轮询等部署这类正常等待结果常一样，留余地。参数一样结果变了不算重复。
- 测试 `test/stuck.mjs` 7/7。两个变异（去掉接线、去掉"每指纹只 steer 一次"）都被抓到。回归 unit、runs 45/45、delegation 17/17、workbench-runs 7/7、ledger 10/10、work-budget 7/7、team-memory 7、features 52、computers 13/13、http-boundaries 100/100。
- 夹具 `frames` 步骤加 `hang`：先挂等待再发帧，帧触发的取消才找得到回合。
- 已知旧问题，与本改动无关：`test/shutdown.mjs` 崩、`test/channels.mjs` 28/34，在 master eb492cc 上一样。
- skip OMP advisor 当默认哨兵：每次评审花 token；确定性检测零成本。需要时可在 overlay 开 `advisor.enabled`。
- OMP 没有自带的重复调用检测（在 can1357/oh-my-pi 搜 doom loop、repeated tool call、loop detect 都是 0 条）。

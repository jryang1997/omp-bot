# 00: 基线，先把失败复现出来

**What to build:** 用测试夹具驱动真实编排器和台账，复现派活和审批在忙碌、重启时的现有行为，输出存进 `.scratch/moat/proof/baseline/`。

**Blocked by:** 无

**Status:** ready-for-agent

- [ ] 测试夹具从 test/runs.mjs 抽成 test/_harness.mjs，runs.mjs 照常全过
- [ ] 场景 1：派活时目标正忙
- [ ] 场景 2：子任务跑到一半服务重启，父 bot 拿不到结果
- [ ] 场景 3：挂着审批时重启
- [ ] 场景 4：核实定时任务和渠道通知有没有"跑完没送到却显示成功"

# 03: 事件触发的例行任务

**What to build:** routines 加 `kind:"event"`。外部用签名 webhook 打进来就跑一次，复用现有账本和 Run 流程。

**Blocked by:** 无

**Status:** todo

- [ ] 签名校验（HMAC），坏签名 401
- [ ] 同一事件 id 不重复跑（幂等）
- [ ] 测试

## Comments

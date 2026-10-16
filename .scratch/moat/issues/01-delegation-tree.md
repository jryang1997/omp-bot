# 01: 派活不丢（借 OpenMausBot、Orca、Hermes）

**What to build:** 升级已有的 `delegate_bot`，不新开工具。目标忙就排队；子任务结束后结果交回派活的 bot，由它接着验收；重启后按规则恢复。

**Blocked by:** 00

**Status:** ready-for-agent

- [ ] 目标忙时排队，空了按顺序开跑，不报错
- [ ] 子任务结束写一条交付记录，父 bot 被唤醒，收到结果和子 Run id
- [ ] 交付有状态（pending、delivered、dropped），重复交付不重复唤醒
- [ ] 重启：排队的继续排；中断的子任务交回"中断"结果，不自动重跑；未送达的补送
- [ ] 交回前重查父 bot 还能不能看到目标 bot（撤权后不越界）
- [ ] 工作台能看到派出去的活、状态和交回结果

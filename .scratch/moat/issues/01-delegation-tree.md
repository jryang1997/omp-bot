# 01: 派活不丢（借 OpenMausBot、Orca、Hermes）

**What to build:** 升级已有的 `delegate_bot`，不新开工具。目标忙就排队；子任务结束后结果交回派活的 bot，由它接着验收；重启后按规则恢复。

**Blocked by:** 00

**Status:** done

- [x] 目标忙时排队，空了按顺序开跑，不报错
- [x] 子任务结束写一条交付记录，父 bot 被唤醒，收到结果和子 Run id
- [x] 交付有状态（pending、delivered、dropped），重复交付不重复唤醒
- [x] 重启：排队的继续排；中断的子任务交回"中断"结果，不自动重跑；未送达的补送
- [x] 交回前重查父 bot 还能不能看到目标 bot（撤权后不越界）
- [x] 工作台能看到派出去的活、状态和交回结果

落地记录：

- 91d8fe8 后端：派活记录 `delegations`（state queued/running/returned，delivery pending/delivered/dropped）；`startRun` 加内部参数 `allowFinishedParent`，排队的活在父回合结束后仍挂在原父 Run 下；任一 Run 落定后推进排队和待交付；`_recover` 末尾对账派活。
- 9cc6c40 工作台：任务页"助手之间派的活"和详情抽屉；`GET /api/delegations` 只给主人，设备 403。
- 测试 `test/delegation.mjs` 11/11，全量 16/16；`proof/mutate-01.txt` 10 个变异全部抓到；`proof/baseline/after-01.txt` 场景 1、2、2b 都是"窗口已关"；`proof/ui/` 截图 9/9。
- 变异中发现交回时自己查父 bot 租约是多余的（`startRun` 的 scope 准入已经会拒），删掉，保留一处真相。
- skip: 计划里写父回合还在跑时用 OMP `follow_up` 插进去。改成等父 bot 空了起新 Run，原因：follow_up 进的是一个可能马上结束的回合，"已送达"说不清；统一走 scope 准入更简单。
- skip: 群聊里派的活也交回到派活 bot 的私聊，不回群。原因：群回合是群的 scope，往群里插消息会打扰别的成员；用户在私聊和工作台都看得到。

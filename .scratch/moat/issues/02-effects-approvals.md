# 02: 动作不重、审批不串（借 Rakazo、Paperclip、IronClaw）

**What to build:** 我们自己的 host tool 在有副作用前写效果记录，键是 run、工具、参数指纹和出现次数。审批绑定参数指纹。重启后挂着的审批按条件恢复或明确作废。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 台账加效果记录：planned、executing、done、unknown
- [ ] 重启时停在 executing 的记 unknown，不重发
- [ ] 审批绑定参数指纹，改了参数原批准不生效
- [ ] 重启后挂着的审批：能恢复的恢复，不能的写清原因

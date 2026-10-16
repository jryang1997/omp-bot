# 02: 动作不重、审批不串（借 Rakazo、Paperclip、IronClaw）

**What to build:** 我们自己的 host tool 在有副作用前写效果记录，键是 run、工具、参数指纹和出现次数。

00 核实：审批由 omp 进程里一次具体工具调用发起，参数在那一刻就定了，进程没了请求也没了，重启后作废并写原因是对的。所以去掉"审批绑定参数"和"重启恢复审批"两条，01 做完后再评估效果记录还值不值得单独做。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 台账加效果记录：planned、executing、done、unknown
- [ ] 重启时停在 executing 的记 unknown，不重发
- skip: 审批绑定参数指纹（omp 原生审批本来就是一次调用一个请求）
- skip: 重启恢复审批（进程没了，无处可交；现有作废加原因是对的）

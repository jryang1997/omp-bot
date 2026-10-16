# 02: 动作不重、审批不串（借 Rakazo、Paperclip、IronClaw）

**What to build:** 我们自己的 host tool 在有副作用前写效果记录，键是 run、工具、参数指纹和出现次数。

00 核实：审批由 omp 进程里一次具体工具调用发起，参数在那一刻就定了，进程没了请求也没了，重启后作废并写原因是对的。所以去掉"审批绑定参数"和"重启恢复审批"两条，01 做完后再评估效果记录还值不值得单独做。

**Blocked by:** 01

**Status:** done

- [x] 台账加效果记录：in_flight、done、unknown（没有 planned，见下）
- [x] 重启时停在 in_flight 的记 unknown，不重发
- skip: 审批绑定参数指纹（omp 原生审批本来就是一次调用一个请求）
- skip: 重启恢复审批（进程没了，无处可交；现有作废加原因是对的）

落地记录：

- 评估：台账早有 `run.sideEffects` 的 in_flight 约定，reconcile 也会按它落 reconciliation_required，但没有任何调用方写。电脑变更类工具在执行中崩溃只记 interrupted，看不出外部动作做没做。所以做精简版，复用 `run.sideEffects`，不新开效果表。
- 02ac054：orchestrator `beginSideEffect`/`endSideEffect`（键 `工具#次数`，已落定的留最近 20 条，在飞的全留）；ledger reconcile 把 in_flight 改成 unknown；computers 六个变更类工具在动作前 begin、成功 ok、报错 error、断流 unknown。测试：runs 两条（半路崩溃落对账不重跑；落定后崩溃记中断），computers 两条断言，delegation 一条（子任务半路崩溃交回写明结果未知）。变异 `proof/mutate-02.py` 6/6 抓到。
- 423538f：任务详情「外部动作」区块；顺手修了原生会话接口报错时整个详情加载失败（这正是最需要看详情的时候）。截图 `proof/ui/shot-effects.mjs` 5/5，`effects-detail.png`。去掉 try/catch 时截图脚本超时失败，证明检查有效。
- skip: 参数指纹（我们不重放回合，键只用来标出哪一步没落定，不需要靠参数判重）
- skip: planned 状态（工具调用到 begin 之间没有外部动作，多一档没有信息）
- skip: 只读工具（截图、读屏）不记；`computer_files` 读写同一个工具，一律按变更记，宁多勿漏
- skip: fake backend 没有截图工具，只读路径没有单测覆盖
- skip: 审批绑定参数、重启恢复审批（00 已核实，见上）

# P1-OM5 · Runtime.open

重启重排、已有外部动作拒绝自动重跑、最多一次重跑、恢复未报告终态

证据类型 `SRC`。本轮未执行项目代码或测试。

[固定提交源码](https://github.com/milind-soni/OpenMausBot/blob/a9fd31ef9cff142fd9506d7b919793eac608c71b/server/runtime/runtime.ts#L76-L120)

完整源文件 [本地快照](原研究包 evidence/source-files)，SHA256 `81f0d6f16c02c1029aae4b95f4bb9fe641df6a7561c58bbe95f10ff39c36819d`。

```text
    76    open(): void {
    77      if (this.opened) return;
    78      this.opened = true;
    79      const now = this.clock.now();
    80      // Deepest first: a child's fate marks its parent before the parent's own turn is judged.
    81      const live = this.store.all({ nonTerminal: true }).sort((a, b) => b.depth - a.depth);
    82      this.withBatch(() => {
    83        for (const snapshot of live) {
    84          const n = this.store.get(snapshot.id);
    85          if (!n || isTerminal(n)) continue;
    86          if (n.status === "needs_input") {
    87            this.store.update(n, { kind: "restart_reconciled", at: now, detail: "needs_input: parked again" });
    88            this.touch(n);
    89            this.safe("park", () => this.runner.park(n, n.question ?? "", true));
    90            continue;
    91          }
    92          if (n.status !== "running") continue;
    93          const handedOut = childrenSince(this.store, n).length > 0;
    94          const outward = handedOut ? [] : this.outwardOf(n);
    95          if (handedOut) {
    96            n.status = "waiting"; n.restart = "cut"; n.lastActivityAt = now;
    97            this.store.update(n, { kind: "restart_reconciled", at: now, detail: "waiting: cut after handing out work" });
    98            this.touch(n);
    99          } else if (outward.length > 0) {
   100            this.store.update(n, { kind: "restart_reconciled", at: now, detail: "failed: outward action done" });
   101            this.settle(n, "failed", "interrupted", outwardDetail(outward));
   102          } else if (n.restart === "rerun") {
   103            this.store.update(n, { kind: "restart_reconciled", at: now, detail: "failed: cut twice" });
   104            this.settle(n, "failed", "interrupted", CUT_TWICE);
   105          } else {
   106            n.restart = "rerun"; n.restarts += 1; n.lastActivityAt = now;
   107            n.status = this.store.children(n.id).length ? "resume" : "queued";
   108            this.store.update(n, { kind: "restart_reconciled", at: now, detail: `${n.status}: rerun ${n.restarts}` });
   109            this.touch(n);
   110          }
   111          const parent = n.parentId ? this.store.get(n.parentId) : undefined;
   112          if (parent && !isTerminal(parent) && !parent.restart) {
   113            parent.restart = "teammates";
   114            this.store.update(parent, { kind: "restart_reconciled", at: now, detail: `${parent.status}: teammates cut` });
   115            this.touch(parent);
   116          }
   117        }
   118        for (const n of this.store.all()) if (isTerminal(n) && n.reportedAt === undefined) this.reportDue.add(n.id);
   119      });
   120    }
```

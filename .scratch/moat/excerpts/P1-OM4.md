# P1-OM4 · Runtime.tickBody

过期、卡住、权限关闭、报告重试、全部子任务交回后恢复父任务

证据类型 `SRC`。本轮未执行项目代码或测试。

[固定提交源码](https://github.com/milind-soni/OpenMausBot/blob/a9fd31ef9cff142fd9506d7b919793eac608c71b/server/runtime/runtime.ts#L238-L295)

完整源文件 [本地快照](原研究包 evidence/source-files)，SHA256 `81f0d6f16c02c1029aae4b95f4bb9fe641df6a7561c58bbe95f10ff39c36819d`。

```text
   238    private tickBody(): void {
   239      const now = this.clock.now();
   240      const mono = this.clock.monotonic();
   241      const live = this.store.all({ nonTerminal: true });
   242      // Deepest first, so each node fails with its own reason.
   243      for (const snapshot of [...live].sort((a, b) => b.depth - a.depth)) {
   244        const n = this.store.get(snapshot.id);
   245        if (!n || isTerminal(n)) continue;
   246        if (n.status === "queued" && !n.continuation && now - this.since(n.lastActivityAt) > this.limits.queueMs) {
   247          this.cancelTree(n, n.executions > 0 ? "not resumed" : "never started", "failed", "expired");
   248        } else if (n.status === "needs_input" && this.inputExpires(n) && now - this.since(n.lastActivityAt) > this.limits.inputWaitMs) {
   249          this.cancelTree(n, "the person did not answer", "failed", "expired");
   250        } else if (n.status === "running") {
   251          const turn = this.turns.get(n.id);
   252          if (turn && mono - turn.activeAt > this.limits.turnStallMs) {
   253            this.cancelTree(n, `no activity for ${duration(this.limits.turnStallMs)}`, "failed", "stalled");
   254          }
   255        }
   256      }
   257      // Access is rechecked every tick, not only at dispatch, so no result crosses a boundary that closed under it.
   258      for (const snapshot of [...live].sort((a, b) => b.depth - a.depth)) {
   259        const n = this.store.get(snapshot.id);
   260        if (!n || isTerminal(n)) continue;
   261        const parent = n.parentId ? this.store.get(n.parentId) : undefined;
   262        const problem = this.safe("validate", () => this.runner.validate(n, parent));
   263        if (this.lastThrew || !problem) continue;
   264        this.cancelTree(n, problem, "failed", "refused");
   265      }
   266      for (const rootId of new Set(live.map(n => n.rootId))) {
   267        const root = this.store.get(rootId);
   268        if (!root || isTerminal(root)) continue;
   269        const anchor = Math.max(this.since(root.lastActivityAt), this.rootActivity.get(rootId) ?? 0);
   270        if (now - anchor <= this.limits.stallMs) continue;
   271        const tree = this.store.all({ rootId });
   272        if (tree.some(n => n.status === "needs_input" || (n.status === "queued" && n.continuation !== undefined))) continue;
   273        this.store.update(root, { kind: "stalled", at: now, detail: `no progress for ${duration(now - anchor)}` });
   274        this.cancelTree(root, `no progress for ${duration(this.limits.stallMs)}`, "failed", "stalled");
   275      }
   276      for (const id of Array.from(this.reportDue)) {
   277        const n = this.store.get(id);
   278        if (!n || !isTerminal(n)) { this.reportDue.delete(id); continue; }
   279        this.report(n, false);
   280      }
   281      for (const snapshot of live) {
   282        if (snapshot.status !== "waiting") continue;
   283        const n = this.store.get(snapshot.id);
   284        if (!n || n.status !== "waiting") continue;
   285        const kids = awaited(this.store.children(n.id));
   286        if (kids.length === 0 || !kids.every(c => isTerminal(c) && c.reportedAt !== undefined)) continue;
   287        if (!n.parentId && n.reply === "poll") {
   288          this.settle(n, "completed", "done");
   289        } else {
   290          n.status = "resume";
   291          this.store.update(n, { kind: "resume_due", at: now, detail: "resume" });
   292          this.touch(n);
   293        }
   294      }
   295      this.dispatchDue();
```

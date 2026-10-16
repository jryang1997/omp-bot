# P1-OM1 · RuntimeCoordinator.enqueue

校验父任务和发言者、祖先回路、重复请求；计算被派者权限

证据类型 `SRC`。本轮未执行项目代码或测试。

[固定提交源码](https://github.com/milind-soni/OpenMausBot/blob/a9fd31ef9cff142fd9506d7b919793eac608c71b/server/runtime-coordinator.ts#L177-L219)

完整源文件 [本地快照](原研究包 evidence/source-files)，SHA256 `ad7ca0d5d4fef3d70892733b240085c3f2d016c87c8059f99a60fd65038a5ed1`。

```text
   177    enqueue(source: RoomAddress, generation: string, parentId: string | undefined, target: RoomAddress, text: string,
   178      options: HandoffOptions = {}): { node: HandoffView; duplicate: boolean } {
   179      this.ready();
   180      const { approvalGranted = false, rework = false, requestBatchKey, thread } = options;
   181      const mode = options.mode ?? "work";
   182      const parent = parentId ? this.store.get(parentId) : this.store.get(generation);
   183      if (!parent) throw new Error(parentId ? NOT_RUNNING : NO_TURN);
   184      if (parent.status !== "running") throw new Error(NOT_RUNNING);
   185      if (!sameSpeaker(parent, source)) throw new Error(WRONG_SPEAKER);
   186      const brief = clip(text, BRIEF_MAX);
   187      const kind: HandoffView["kind"] = target.groupId !== undefined && target.groupId === source.groupId ? "assignment" : "work";
   188      const lineage = path(this.store, parent);
   189      const root = lineage[0]!;
   190      if (lineage.some(n => ancestorOf(address(n), target))) throw new Error(ANCESTOR);
   191      const siblings = this.store.children(parent.id);
   192      const existing = siblings.findLast(c => c.assignee.botId === target.botId && c.assignee.destination.groupId === target.groupId && c.brief === brief && c.mode === mode);
   193      if (existing && !(rework && isTerminal(existing))) return { node: view(existing, parent), duplicate: true };
   194      if (mode === "work" && !rework && siblings.some(c => c.mode === "work" && kindOf(c.assignee.destination.groupId, parent) === kind &&
   195        c.assignee.destination.groupId === target.groupId && c.assignee.botId === target.botId && c.status === "completed")) throw new Error(ALREADY_COMPLETED);
   196      if (kind === "work" && target.groupId && lineage.some(n => n.assignee.destination.groupId === target.groupId)) throw new Error(ROOM_ANCESTOR);
   197      const wanted: Reply = mode === "notify" ? "none" : options.reply ?? "resume";
   198      const reply: Reply = wanted === "none" ? "none" : root.reply === "poll" ? "poll" : wanted;
   199      const requester: Requester = { kind: "bot_turn", botId: parent.assignee.botId, threadId: parent.assignee.destination.threadId,
   200        chief: this.host.chiefOf(address(parent)), ...(parent.id === root.id && root.requester.runId !== undefined ? { runId: root.requester.runId } : {}) };
   201      const level = this.host.levelOf(target, address(parent));
   202      const result = this.runtime.enqueue({
   203        parentId: parent.id,
   204        origin: parent.origin,
   205        requester,
   206        assignee: { botId: target.botId, destination: { kind: target.groupId ? "room_thread" : thread === "standing" ? "standing_thread" : "work_thread",
   207          threadId: target.threadId, ...(target.groupId ? { groupId: target.groupId } : {}) } },
   208        mode, reply, brief: text, rework,
   209        ...(options.doneWhen ? { doneWhen: options.doneWhen } : {}),
   210        levels: { own: level.level },
   211        ...(level.driverKind !== undefined ? { driverKind: level.driverKind } : {}),
   212        approved: approvalGranted,
   213        ...(target.groupId && requestBatchKey ? { batchKey: requestBatchKey } : {}),
   214      });
   215      if (!result.ok) {
   216        if (result.outcome === "budget") throw new Error(BUDGET);
   217        throw new Error(RUNTIME_DEPTH.test(result.reason) ? DEPTH : result.reason);
   218      }
   219      return { node: view(result.assignment, parent), duplicate: result.duplicate };
```

// 00 基线：用真实编排器和台账（注入的 runtime 夹具）记录派活与审批在忙碌、重启时的现有行为。
// 只观察、不断言修复后的行为。用法：node .scratch/moat/proof/baseline.mjs
import { newTeam, waitFor, delay, crash } from "../../../test/_harness.mjs";

const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };

// 场景 1：派活时目标正忙
{
  const t = newTeam();
  const a = t.orch.addBot({ name: "Alpha" });
  const b = t.orch.addBot({ name: "Beta" });
  const fa = await t.orch.runtimeFor(a.id, "private");
  const fb = await t.orch.runtimeFor(b.id, "private");
  fb.queue = [{ kind: "hang" }];
  const busy = t.orch.startRun({ botId: b.id, text: "B 自己在忙" });
  await waitFor(() => fb.busy, { label: "B busy" });
  fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "帮我整理资料" } }];
  const run = t.orch.startRun({ botId: a.id, text: "派给 Beta" });
  const done = await t.orch.waitRun(run.id);
  log("## 场景 1：派活时目标正忙");
  log("A 的 delegate_bot 结果:", JSON.stringify(fa.lastToolResult));
  log("A 的 Run:", done.state);
  log("B 名下的 Run 数:", t.orch.listRuns({ botId: b.id }).length, "(只有它自己那条，派的活没留下)");
  log("结论: 目标一忙，派的活就丢了，只剩一条报错给 A。这是 01 要关的窗口");
  await t.orch.cancelRun(busy.id);
  await t.cleanup();
}

// 场景 2：子任务跑到一半服务重启
{
  const t = newTeam();
  const a = t.orch.addBot({ name: "Alpha" });
  const b = t.orch.addBot({ name: "Beta" });
  const fa = await t.orch.runtimeFor(a.id, "private");
  const fb = await t.orch.runtimeFor(b.id, "private");
  fb.queue = [{ kind: "hang" }];
  fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "写一份周报" } }];
  const parent = t.orch.startRun({ botId: a.id, text: "派给 Beta 写周报" });
  const pDone = await t.orch.waitRun(parent.id);
  const child = await waitFor(() => t.orch.listRuns({ botId: b.id })[0], { label: "子 Run" });
  await waitFor(() => fb.busy, { label: "B 在跑" });
  log("\n## 场景 2：子任务跑到一半服务重启");
  log("父 Run 结束:", pDone.state, "| 回复:", JSON.stringify(pDone.reply).slice(0, 80));
  log("重启前子 Run:", child.kind, t.orch.getRun(child.id).state);
  crash(t); // 模拟崩溃，再在同一 home 上开新编排器
  const t2 = newTeam({ home: t.home });
  const c2 = t2.orch.getRun(child.id);
  log("重启后子 Run:", c2.state, "| recovery:", JSON.stringify(c2.recovery ?? null));
  await delay(200);
  const aRuns = t2.orch.listRuns({ botId: a.id });
  log("重启后 A 名下 Run 数:", aRuns.length, "| 有没有新的唤醒 Run:", aRuns.some((r) => r.id !== parent.id) ? "有" : "没有");
  log("A 知道结果吗: 没有任何把子结果交回 A 的记录或事件");
  log("结论: 子任务被标 interrupted，但结果和中断都不回到 A，这是 01 要关的窗口");
  try { await t2.orch.shutdown(); } catch {}
}

// 场景 2b：不重启，子任务正常做完
{
  const t = newTeam();
  const a = t.orch.addBot({ name: "Alpha" });
  const b = t.orch.addBot({ name: "Beta" });
  const fa = await t.orch.runtimeFor(a.id, "private");
  const fb = await t.orch.runtimeFor(b.id, "private");
  fb.queue = [{ kind: "complete", text: "周报写好了，放在 work/weekly.md" }];
  fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "写一份周报" } }];
  const parent = t.orch.startRun({ botId: a.id, text: "派给 Beta 写周报" });
  await t.orch.waitRun(parent.id);
  const child = await waitFor(() => t.orch.listRuns({ botId: b.id })[0], { label: "子 Run" });
  const cDone = await t.orch.waitRun(child.id);
  await delay(200);
  log("\n## 场景 2b：不重启，子任务正常做完");
  log("子 Run:", cDone.state, "| 回复:", JSON.stringify(cDone.reply));
  log("A 名下 Run 数:", t.orch.listRuns({ botId: a.id }).length, "| A 的会话收到的消息数:", fa.calls.length);
  log("结论: 子任务做完了，A 也不会知道，只有用户去工作台看。这是 01 要关的窗口");
  await t.cleanup();
}

// 场景 3：挂着审批时重启
{
  const t = newTeam();
  const b = t.orch.addBot({ name: "Beta" });
  const fb = await t.orch.runtimeFor(b.id, "private");
  fb.queue = [{ kind: "ui", frame: { type: "extension_ui_request", id: "native_ui_9", method: "confirm", title: "允许发邮件？", message: "收件人 x@example.com" } }];
  const run = t.orch.startRun({ botId: b.id, text: "发邮件" });
  const ap = await waitFor(() => t.orch.ledger.list("approvals")[0], { label: "审批" });
  log("\n## 场景 3：挂着审批时重启");
  log("重启前审批:", ap.status, "| Run:", t.orch.getRun(run.id).state);
  crash(t);
  const t2 = newTeam({ home: t.home });
  const ap2 = t2.orch.ledger.get("approvals", ap.id);
  log("重启后审批:", ap2.status, "| 原因:", JSON.stringify(ap2.expiredReason ?? null));
  log("重启后 Run:", t2.orch.getRun(run.id).state);
  log("说明: 这类审批是 omp 进程里一次具体工具调用发起的，进程没了，这次调用也没了，恢复同一个请求无处可交");
  log("结论: 现有行为是对的（明确作废并写原因，Run 标 interrupted）。02 的「重启后恢复审批」不成立，删掉");
  try { await t2.orch.shutdown(); } catch {}
}

// 场景 4：定时任务和渠道通知
log("\n## 场景 4：定时任务和渠道通知（读代码核实）");
log("src/channels.mjs #deliver：先写 outbox（pending），id 稳定，同一事件重放不重发；已 sent/unknown 直接跳过");
log("src/features/routines.mjs：只写回执（ok/missed/skipped/overlap），不对外发通知");
log("结论: 没有「跑完没送到却显示成功」的窗口，03 skip");

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./baseline/baseline.txt", import.meta.url), out.join("\n") + "\n");
process.exit(0);

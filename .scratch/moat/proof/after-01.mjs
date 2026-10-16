// 01 落地后重放基线场景 1、2、2b，结论按观察到的事实算，不写死。
// 用法：node .scratch/moat/proof/after-01.mjs
import { newTeam, waitFor, delay, crash } from "../../../test/_harness.mjs";

const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const verdict = (closed) => (closed ? "窗口已关" : "窗口仍在");

async function pair(t) {
  const a = t.orch.addBot({ name: "Alpha" });
  const b = t.orch.addBot({ name: "Beta" });
  return { a, b, fa: await t.orch.runtimeFor(a.id, "private"), fb: await t.orch.runtimeFor(b.id, "private") };
}

{
  const t = newTeam();
  const { a, b, fa, fb } = await pair(t);
  fb.queue = [{ kind: "gate", text: "B 自己的事" }, { kind: "complete", text: "资料整理好了" }];
  const busy = t.orch.startRun({ botId: b.id, text: "B 自己在忙" });
  await waitFor(() => fb.busy);
  fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "帮我整理资料" } }];
  await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派给 Beta" }).id);
  log("## 场景 1：派活时目标正忙");
  log("A 收到:", fa.lastToolResult.text, "| isError:", !!fa.lastToolResult.isError);
  fb.release();
  await t.orch.waitRun(busy.id);
  const rec = await waitFor(() => t.orch.listDelegations({}).find((d) => d.delivery === "delivered"), { label: "交回" });
  log("B 空了以后:", rec.result.state, JSON.stringify(rec.result.reply), "| 交回 A 的 Run:", rec.wakeRunId);
  log("结论:", verdict(!fa.lastToolResult.isError && rec.result.state === "completed"));
  await t.cleanup();
}

{
  const t = newTeam();
  const { a, b, fa, fb } = await pair(t);
  fb.queue = [{ kind: "hang" }];
  fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "写一份周报" } }];
  const parent = await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派给 Beta 写周报" }).id);
  await waitFor(() => fb.busy);
  crash(t);
  const t2 = newTeam({ home: t.home });
  const rec = await waitFor(() => t2.orch.listDelegations({}).find((d) => d.delivery === "delivered"), { label: "补送" });
  const wake = await t2.orch.waitRun(rec.wakeRunId);
  await delay(50);
  log("\n## 场景 2：子任务跑到一半服务重启");
  log("子 Run:", t2.orch.getRun(rec.childRunId).state, "| 交回结果:", rec.result.state);
  log("A 收到的第一行:", wake.text.split("\n")[0]);
  log("B 在新进程里被重跑:", t2.fake(b.id) ? "是" : "否");
  log("结论:", verdict(wake.botId === a.id && rec.result.state === "interrupted" && !t2.fake(b.id)));
  await t2.cleanup();
}

{
  const t = newTeam();
  const { a, b, fa, fb } = await pair(t);
  fb.queue = [{ kind: "complete", text: "周报写好了，放在 work/weekly.md" }];
  fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "写一份周报" } }];
  await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派给 Beta 写周报" }).id);
  const rec = await waitFor(() => t.orch.listDelegations({}).find((d) => d.delivery === "delivered"), { label: "交回" });
  await t.orch.waitRun(rec.wakeRunId);
  log("\n## 场景 2b：不重启，子任务正常做完");
  log("A 的会话收到的消息数:", fa.calls.length, "| 最后一条含子结果:", fa.calls.at(-1).text.includes("work/weekly.md") ? "是" : "否");
  log("结论:", verdict(fa.calls.at(-1).text.includes(rec.childRunId)));
  await t.cleanup();
}

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./baseline/after-01.txt", import.meta.url), out.join("\n") + "\n");
process.exit(0);

// test/resume.mjs — 续跑被重启打断的 Run：主人点"继续"，只续一次，不续结果未知的。
// 真实编排器与台账（临时 home），注入 runtime 夹具；重启用 crash() 模拟。

import assert from "node:assert/strict";
import { newTeam, crash, waitFor } from "./_harness.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`); }
}

/** 起一个挂住的 Run，然后模拟进程崩溃重启。返回新团队和那个 Run 的 id。 */
async function interruptedRun(text = "整理本周的 issue") {
  const t = newTeam();
  const bot = t.orch.addBot({ name: "Worker" });
  const fake = await t.orch.runtimeFor(bot.id, "private");
  fake.queue = [{ kind: "hang" }];
  const run = t.orch.startRun({ botId: bot.id, text });
  await waitFor(() => fake.busy, { label: "在跑" });
  crash(t);
  const t2 = newTeam({ home: t.home });
  return { t2, bot, runId: run.id };
}

await test("中断的 Run 续一次：新 Run 带原要求和核对提示，两边互相指向", async () => {
  const { t2, bot, runId } = await interruptedRun();
  try {
    assert.equal(t2.orch.getRun(runId).state, "interrupted");
    const out = t2.orch.resumeRun(runId);
    assert.equal(out.resumed, true);
    const done = await t2.orch.waitRun(out.run.id);
    assert.equal(done.state, "completed");
    assert.equal(done.source, "resume");
    assert.equal(done.resumeOf, runId);
    assert.equal(t2.orch.getRun(runId).resumedBy, out.run.id);
    assert.equal(t2.orch.getRun(runId).state, "interrupted", "旧 Run 不改状态");
    const prompt = t2.fake(bot.id).calls.at(-1).text;
    assert.match(prompt, /做完的不要重做/);
    assert.match(prompt, /整理本周的 issue/);
  } finally { await t2.cleanup(); }
});

await test("重复点继续：返回同一个新 Run，不开第二个", async () => {
  const { t2, bot, runId } = await interruptedRun();
  try {
    const first = t2.orch.resumeRun(runId);
    const second = t2.orch.resumeRun(runId);
    assert.equal(second.resumed, false);
    assert.equal(second.run.id, first.run.id);
    await t2.orch.waitRun(first.run.id);
    assert.equal(t2.orch.listRuns({ botId: bot.id }).length, 2, "旧 Run + 一个新 Run");
  } finally { await t2.cleanup(); }
});

await test("不是 interrupted 的不能续：完成的、结果未知的都 409", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "Done" });
    await t.orch.runtimeFor(bot.id, "private");
    const run = t.orch.startRun({ botId: bot.id, text: "hi" });
    await t.orch.waitRun(run.id);
    assert.throws(() => t.orch.resumeRun(run.id), (e) => e.status === 409 && e.code === "not_interrupted");
    assert.throws(() => t.orch.resumeRun("run_nope"), (e) => e.status === 404);
  } finally { await t.cleanup(); }
});

await test("派出去的子任务不在这里续（已作为中断交回派活方）", async () => {
  const { t2, runId } = await interruptedRun();
  try {
    t2.orch.ledger.updateRun(runId, { parentRunId: "run_parent" });
    assert.throws(() => t2.orch.resumeRun(runId), (e) => e.code === "resume_unsupported");
  } finally { await t2.cleanup(); }
});

await test("有在飞外部动作的 Run 重启后是 reconciliation_required，不能续", async () => {
  const t = newTeam();
  const bot = t.orch.addBot({ name: "Effects" });
  const fake = await t.orch.runtimeFor(bot.id, "private");
  fake.queue = [{ kind: "hang" }];
  const run = t.orch.startRun({ botId: bot.id, text: "发邮件" });
  await waitFor(() => fake.busy, { label: "在跑" });
  t.orch.ledger.updateRun(run.id, { sideEffects: [{ id: "se1", tool: "computer_shell", status: "in_flight" }] });
  crash(t);
  const t2 = newTeam({ home: t.home });
  try {
    assert.equal(t2.orch.getRun(run.id).state, "reconciliation_required");
    assert.throws(() => t2.orch.resumeRun(run.id), (e) => e.code === "not_interrupted");
  } finally { await t2.cleanup(); }
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

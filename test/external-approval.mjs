// test/external-approval.mjs — 飞书、手机来的回合：「全部放手」降成「先问我」。零模型调用，不启 omp。

import assert from "node:assert/strict";
import { newTeam, FakeRuntime, waitFor } from "./_harness.mjs";
import { policySignature } from "../src/domain.mjs";

// 假运行时默认不看策略；这里让它像真的一样按策略签名判断能不能复用。
FakeRuntime.prototype.matchesPolicy = function (bot) {
  return policySignature(bot, {}) === policySignature(this.bot, {});
};

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`); }
}

async function turn(t, input) {
  const run = t.orch.startRun({ text: "干活", ...input });
  const done = await t.orch.waitRun(run.id);
  assert.equal(done.state, "completed", JSON.stringify(done.error));
  return t.fake(input.botId).bot.approvalMode;
}

await test("全部放手档：飞书和手机来的回合按先问我档起进程，工作台来的照旧；来回切换都会重建", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "Full", permission: "full", confirmPermission: true });
    assert.equal(await turn(t, { botId: bot.id }), "yolo");
    assert.equal(await turn(t, { botId: bot.id, source: "feishu:ou_x:oc_y" }), "write");
    assert.equal(await turn(t, { botId: bot.id }), "yolo", "回到工作台换回全部放手");
    assert.equal(await turn(t, { botId: bot.id, source: "device:dev1" }), "write");
    assert.equal(t.events.filter((e) => e.type === "runtime_rebuilt" && e.botId === bot.id).length, 3);
    assert.equal(t.orch.getBot(bot.id).approvalMode, "yolo", "只影响这一回合的进程，不改助手设置");
  } finally {
    await t.cleanup();
  }
});

await test("先问我档和只聊天档：外部来的回合不变，也不重建", async () => {
  const t = newTeam();
  try {
    for (const permission of ["ask", "chat"]) {
      const bot = t.orch.addBot({ name: `P${permission}`, permission });
      const before = await turn(t, { botId: bot.id });
      assert.equal(await turn(t, { botId: bot.id, source: "feishu:ou_x:oc_y" }), before);
      assert.equal(t.events.filter((e) => e.type === "runtime_rebuilt" && e.botId === bot.id).length, 0, permission);
    }
  } finally {
    await t.cleanup();
  }
});

await test("飞书发起的活派给全部放手的队友：队友这一回合也按先问我跑", async () => {
  const t = newTeam();
  try {
    const a = t.orch.addBot({ name: "Lead", permission: "full", confirmPermission: true });
    const b = t.orch.addBot({ name: "Worker", permission: "full", confirmPermission: true });
    await turn(t, { botId: a.id, source: "feishu:ou_x:oc_y" }); // 先把按先问我档起的进程建好，才能给它排脚本
    t.fake(a.id).queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "跑脚本" } }];
    const root = t.orch.startRun({ botId: a.id, text: "派活", source: "feishu:ou_x:oc_y" });
    await t.orch.waitRun(root.id);
    const rec = await waitFor(() => t.orch.listDelegations({}).find((d) => d.childRunId), { label: "子 Run" });
    const child = t.orch.getRun(rec.childRunId);
    assert.ok(child, "派出了子 Run");
    await t.orch.waitRun(child.id);
    assert.equal(t.fake(b.id).bot.approvalMode, "write");
  } finally {
    await t.cleanup();
  }
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

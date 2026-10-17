// test/allowed-commands.mjs — 审批卡「以后都允许这条命令」的编排器接线。零模型调用，不启 omp。

import assert from "node:assert/strict";
import { newTeam, waitFor } from "./_harness.mjs";
import { policySignature } from "../src/domain.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`); }
}

const bashCard = (command, id = "n1") => ({
  kind: "ui",
  frame: { type: "extension_ui_request", id, method: "select", title: `Allow tool: bash\nCommand: ${command}`, options: ["Approve", "Deny"] },
});

async function cardFor(t, bot, step) {
  const fake = await t.orch.runtimeFor(bot.id, "private");
  fake.queue = [step];
  const run = t.orch.startRun({ botId: bot.id, text: "跑一下" });
  const rec = await waitFor(() => t.orch.ledger.list("approvals").find((a) => a.runId === run.id), { label: "审批卡" });
  return { fake, run, rec };
}

await test("要我同意档的 bash 卡带上能记住的命令；点了以后批准这一次、写进助手设置、安排重建", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "Rem", permission: "ask" });
    const sigBefore = policySignature(t.orch.getBot(bot.id), {});
    const { fake, run, rec } = await cardFor(t, bot, bashCard("npm test"));
    assert.equal(rec.rememberCommand, "npm test");
    await t.orch.answerUi(rec.id, { value: "Approve", remember: true });
    assert.deepEqual(fake.responses, [{ nativeId: "n1", payload: { value: "Approve" } }], "原生只收到批准，不带 remember");
    const after = t.orch.getBot(bot.id);
    assert.deepEqual(after.allowedCommands, ["npm test"]);
    assert.notEqual(policySignature(after, {}), sigBefore, "签名变了，旧进程不会被复用");
    assert.ok(t.events.some((e) => e.type === "bot_policy_changed" && e.botId === bot.id));
    assert.equal((await t.orch.waitRun(run.id)).state, "completed");
  } finally {
    await t.cleanup();
  }
});

await test("同一条命令再记一次不重复", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "Rem2", permission: "ask" });
    t.orch.updateBot(bot.id, { allowedCommands: ["npm test"] });
    const { rec } = await cardFor(t, bot, bashCard("npm test"));
    await t.orch.answerUi(rec.id, { value: "Approve", remember: true });
    assert.deepEqual(t.orch.getBot(bot.id).allowedCommands, ["npm test"]);
  } finally {
    await t.cleanup();
  }
});

await test("不能记的卡：复杂命令、别的工具、全部放手档、拒绝时带 remember，都 400 且不改设置", async () => {
  const t = newTeam();
  try {
    const cases = [
      ["ask", bashCard("npm test && rm -rf ~")],
      ["ask", { kind: "ui", frame: { type: "extension_ui_request", id: "n1", method: "select", title: "Allow tool: write\nFile: /x", options: ["Approve", "Deny"] } }],
      ["full", bashCard("npm test")],
    ];
    for (const [permission, step] of cases) {
      const bot = t.orch.addBot({ name: `No${permission}${t.orch.listBots().length}`, permission, confirmPermission: true });
      const { fake, rec } = await cardFor(t, bot, step);
      assert.equal(rec.rememberCommand, null, step.frame.title);
      await assert.rejects(() => t.orch.answerUi(rec.id, { value: "Approve", remember: true }), (e) => e.status === 400 && e.code === "remember_invalid");
      assert.deepEqual(fake.responses, [], "没送原生应答");
      assert.deepEqual(t.orch.getBot(bot.id).allowedCommands, []);
      await t.orch.answerUi(rec.id, { value: "Deny" });
    }
    const bot = t.orch.addBot({ name: "DenyRem", permission: "ask" });
    const { rec } = await cardFor(t, bot, bashCard("npm test"));
    await assert.rejects(() => t.orch.answerUi(rec.id, { value: "Deny", remember: true }), (e) => e.code === "remember_invalid");
    assert.deepEqual(t.orch.getBot(bot.id).allowedCommands, []);
  } finally {
    await t.cleanup();
  }
});

await test("设置里改名单：坏命令 400 带原因，移除生效", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "Edit", permission: "ask" });
    assert.throws(() => t.orch.updateBot(bot.id, { allowedCommands: ["rm -rf *"] }), (e) => e.status === 400 && /不能原样放行/.test(e.message));
    t.orch.updateBot(bot.id, { allowedCommands: ["npm test", "make"] });
    assert.deepEqual(t.orch.updateBot(bot.id, { allowedCommands: ["make"] }).allowedCommands, ["make"]);
  } finally {
    await t.cleanup();
  }
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

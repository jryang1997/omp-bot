// test/work-budget.mjs — 06 整棵派工树一份预算：子任务从根预算扣，用到余量线整棵停，交回照常，唤醒不拿新预算。
//
// 真实编排器与台账（临时 home），只注入 runtime 夹具。每个夹具回合的 token 用 step.tokens 指定（默认 15）。
// 根预算 100 时余量线是 80：干活的成员一共只能用到 80，剩下 20 留给交回和汇总。

import assert from "node:assert/strict";
import { waitFor, newTeam } from "./_harness.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`);
  }
}

const dlgs = (orch) => orch.listDelegations({}).slice().reverse();
const wakesOf = (orch, botId) =>
  orch.listRuns({ botId }).filter((r) => String(r.text).startsWith("[派活交回]")).reverse();

async function bots(t, names) {
  const out = [];
  for (const name of names) {
    const b = t.orch.addBot({ name });
    await t.orch.runtimeFor(b.id, "private");
    out.push({ bot: b, rt: t.fake(b.id) });
  }
  return out;
}

await test("06 子任务从根预算扣：孙任务的额度是整棵树剩下的，根自己花的也算", async () => {
  const t = newTeam();
  try {
    const [a, b, c] = await bots(t, ["RootA", "MidB", "LeafC"]);
    b.rt.queue = [{ kind: "gate", text: "B 做完了" }];
    a.rt.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.bot.name, message: "长活" }, tokens: 50 }];
    const root = await t.orch.waitRun(t.orch.startRun({ botId: a.bot.id, text: "开工", budget: { maxTokens: 100 } }).id);
    assert.equal(root.state, "completed");
    const mid = await waitFor(() => t.orch.listRuns({ botId: b.bot.id }).find((r) => r.state === "running"), { label: "B 在跑" });
    assert.equal(mid.budget.maxTokens, 80, "第一层只拿到余量线以内的 80，不是整份 100");
    assert.equal(mid.treeRootId, root.id);
    // 根已经花了 50：B 下面再派，只能拿到 80 − 50 = 30，不是 B 自己那份 80。
    const leaf = t.orch.startRun({ botId: c.bot.id, text: "孙任务", parentRunId: mid.id, depth: 2, source: "bot" });
    assert.equal(leaf.budget.maxTokens, 30);
    assert.equal(leaf.treeRootId, root.id);
    await t.orch.waitRun(leaf.id);
    b.rt.release();
    await waitFor(() => dlgs(t.orch).every((d) => d.delivery === "delivered"), { label: "交回" });
  } finally {
    await t.cleanup();
  }
});

await test("06 用到余量线整棵停：在飞的子任务停下，排队的不开跑，都照常交回派活的 bot", async () => {
  const t = newTeam();
  try {
    const [a, b] = await bots(t, ["StopA", "StopB"]);
    b.rt.queue = [{ kind: "gate", text: "不该做完" }];
    a.rt.queue = [
      {
        kind: "toolx",
        calls: [
          { tool: "delegate_bot", args: { to: b.bot.name, message: "一号活" } },
          { tool: "delegate_bot", args: { to: b.bot.name, message: "二号活" } },
        ],
        tokens: 85,
      },
      { kind: "complete", text: "汇总一", tokens: 5 },
      { kind: "complete", text: "汇总二", tokens: 5 },
    ];
    const root = await t.orch.waitRun(t.orch.startRun({ botId: a.bot.id, text: "派两件", budget: { maxTokens: 100 } }).id);
    assert.equal(root.state, "completed", "根自己没超总额，照常收尾");
    await waitFor(() => dlgs(t.orch).every((d) => d.state === "returned"), { label: "两件都交回" });
    const [first, second] = dlgs(t.orch);
    const child = t.orch.getRun(first.childRunId);
    assert.equal(child.state, "cancelled", "在飞的子任务停下");
    assert.match(child.error ?? "", /预算/);
    assert.equal(first.result.state, "cancelled");
    assert.equal(second.result.state, "not_started", "排队的不开跑");
    assert.match(second.result.error ?? "", /预算/);
    await waitFor(() => dlgs(t.orch).every((d) => d.delivery === "delivered"), { label: "两件都送到" });
    const wakes = wakesOf(t.orch, a.bot.id);
    assert.equal(wakes.length, 2);
    for (const w of await Promise.all(wakes.map((w) => t.orch.waitRun(w.id)))) {
      assert.equal(w.state, "completed", "交回和汇总用的是留下的余量");
      assert.equal(w.treeRootId, root.id, "唤醒算在同一棵树里");
    }
  } finally {
    await t.cleanup();
  }
});

await test("06 交回的唤醒不拿新的一份预算：过了余量线再派活被拒", async () => {
  const t = newTeam();
  try {
    const [a, b, c] = await bots(t, ["WakeA", "WakeB", "WakeC"]);
    b.rt.queue = [{ kind: "gate", text: "B 做完了", tokens: 5 }];
    a.rt.queue = [
      { kind: "tool", tool: "delegate_bot", args: { to: b.bot.name, message: "小活" }, tokens: 80 },
      { kind: "tool", tool: "delegate_bot", args: { to: c.bot.name, message: "再来一件" }, tokens: 5 },
    ];
    const root = await t.orch.waitRun(t.orch.startRun({ botId: a.bot.id, text: "开工", budget: { maxTokens: 100 } }).id);
    assert.equal(root.state, "completed");
    b.rt.release();
    const rec = await waitFor(() => dlgs(t.orch).find((d) => d.delivery === "delivered"), { label: "交回" });
    const wake = await t.orch.waitRun(rec.wakeRunId);
    assert.equal(wake.state, "completed");
    assert.match(wake.reply, /预算/, "唤醒想再派活，被整棵树的预算挡住");
    assert.equal(t.orch.listRuns({ botId: c.bot.id }).length, 0, "C 没有开跑");
  } finally {
    await t.cleanup();
  }
});

await test("06 整棵树超过总额：根的回合按预算耗尽收场，不算做完", async () => {
  const t = newTeam();
  try {
    const [a, b] = await bots(t, ["HardA", "HardB"]);
    b.rt.queue = [{ kind: "complete", text: "B 花了一半", tokens: 50 }];
    a.rt.queue = [{ kind: "tool", tool: "message_bot", args: { to: b.bot.name, message: "问一句" }, tokens: 60 }];
    const root = await t.orch.waitRun(t.orch.startRun({ botId: a.bot.id, text: "开工", budget: { maxTokens: 100 } }).id);
    // 根自己只花 60，没超 100；加上 B 的 50 一共 110，整棵超了。
    assert.equal(root.state, "cancelled");
    assert.match(root.error ?? "", /预算耗尽.*整棵/);
  } finally {
    await t.cleanup();
  }
});

await test("06 没设预算的树照旧：不限额，唤醒也能接着派活", async () => {
  const t = newTeam();
  try {
    const [a, b, c] = await bots(t, ["FreeA", "FreeB", "FreeC"]);
    b.rt.queue = [{ kind: "complete", text: "好了", tokens: 500 }];
    a.rt.queue = [
      { kind: "tool", tool: "delegate_bot", args: { to: b.bot.name, message: "活" }, tokens: 500 },
      { kind: "tool", tool: "delegate_bot", args: { to: c.bot.name, message: "下一件" } },
    ];
    await t.orch.waitRun(t.orch.startRun({ botId: a.bot.id, text: "开工" }).id);
    await waitFor(() => t.orch.listRuns({ botId: c.bot.id }).length === 1, { label: "C 开跑" });
  } finally {
    await t.cleanup();
  }
});

await test("06 到余量线时根不停：回合里的根拿到子任务的结果，用留下的余量收尾", async () => {
  const t = newTeam();
  try {
    const [a, b] = await bots(t, ["LineA", "LineB"]);
    b.rt.queue = [{ kind: "complete", text: "B 刚好用到余量线", tokens: 80 }];
    a.rt.queue = [{ kind: "tool", tool: "message_bot", args: { to: b.bot.name, message: "做完告诉我" } }];
    const root = await t.orch.waitRun(t.orch.startRun({ botId: a.bot.id, text: "开工", budget: { maxTokens: 100 } }).id);
    // B 用了 80 到线，根自己再花 15，一共 95，没超 100。
    assert.equal(root.state, "completed", "根不在被停的名单里");
    assert.match(root.reply, /B 刚好用到余量线/);
  } finally {
    await t.cleanup();
  }
});

await test("06 停树时成员名下排队的活也照常交回，不当成父回合取消丢掉", async () => {
  const t = newTeam();
  try {
    const [a, b, c, e] = await bots(t, ["QueA", "QueB", "QueC", "QueE"]);
    c.rt.queue = [{ kind: "gate", text: "C 自己的事" }];
    const own = t.orch.startRun({ botId: c.bot.id, text: "C 在忙" });
    await waitFor(() => c.rt.busy, { label: "C busy" });
    e.rt.queue = [{ kind: "complete", text: "E 用到余量线", tokens: 80 }];
    b.rt.queue = [
      {
        kind: "toolx",
        calls: [
          { tool: "delegate_bot", args: { to: c.bot.name, message: "排队的活" } },
          { tool: "message_bot", args: { to: e.bot.name, message: "问 E" } },
        ],
        tokens: 1,
      },
      { kind: "complete", text: "B 收到没开跑的交回", tokens: 1 },
    ];
    // 根这一回合不花 token，E 一个人用到余量线 80，时序不影响谁到线。
    a.rt.queue = [
      { kind: "tool", tool: "delegate_bot", args: { to: b.bot.name, message: "交给 B" }, tokens: 0 },
      { kind: "complete", text: "A 收到 B 的交回", tokens: 1 },
    ];
    await t.orch.waitRun(t.orch.startRun({ botId: a.bot.id, text: "开工", budget: { maxTokens: 100 } }).id);
    const queued = await waitFor(
      () => dlgs(t.orch).find((d) => d.targetBotId === c.bot.id && d.state === "returned"),
      { label: "排队的活交回" },
    );
    assert.equal(queued.result.state, "not_started");
    assert.match(queued.result.error ?? "", /预算/);
    const sent = await waitFor(() => { const d = t.orch.listDelegations({}).find((x) => x.id === queued.id); return d.delivery !== "pending" && d; }, { label: "送出" });
    assert.equal(sent.delivery, "delivered", "交回照常");
    c.rt.release();
    await t.orch.waitRun(own.id);
  } finally {
    await t.cleanup();
  }
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

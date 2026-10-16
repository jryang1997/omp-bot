// test/delegation.mjs — delegate_bot 的派活账与交付账：忙时排队、做完交回父 bot、重启按规则恢复、撤权不越界。
//
// 真实编排器与台账（临时 home），只注入 runtime 夹具。重启用 crash() 模拟进程崩溃，再在同一 home 开新编排器。

import assert from "node:assert/strict";
import { delay, waitFor, newTeam, crash } from "./_harness.mjs";

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

/** 去掉编排器加在提示前的「[私聊，发送者]」头。 */
const body = (text) => String(text).replace(/^\[私聊，[^\]]*\]\n/, "");
const dlgs = (orch) => orch.listDelegations({});
const wakesOf = (orch, botId) =>
  orch.listRuns({ botId }).filter((r) => String(r.text).startsWith("[派活交回]"));

/** A、B 两个 bot，fake runtime 先建好。 */
async function pair(t) {
  const a = t.orch.addBot({ name: "Alpha" });
  const b = t.orch.addBot({ name: "Beta" });
  const fa = await t.orch.runtimeFor(a.id, "private");
  const fb = await t.orch.runtimeFor(b.id, "private");
  return { a, b, fa, fb };
}

await test("目标忙时排队不报错，空了按派活顺序开跑", async () => {
  const t = newTeam();
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "gate", text: "B 自己的事忙完了" }, { kind: "complete", text: "一号做完" }, { kind: "complete", text: "二号做完" }];
    const own = t.orch.startRun({ botId: b.id, text: "B 自己在忙" });
    await waitFor(() => fb.busy, { label: "B busy" });
    fa.queue = [
      {
        kind: "toolx",
        calls: [
          { tool: "delegate_bot", args: { to: b.name, message: "一号活" } },
          { tool: "delegate_bot", args: { to: b.name, message: "二号活" } },
        ],
      },
    ];
    const parent = await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派两件" }).id);
    assert.equal(parent.state, "completed");
    assert.doesNotMatch(parent.reply, /无法接手/);
    assert.match(parent.reply, /正忙，已排队（前面还有 0 件）/);
    assert.match(parent.reply, /前面还有 1 件/);
    assert.deepEqual(dlgs(t.orch).map((d) => d.state), ["queued", "queued"]);

    fb.release();
    await t.orch.waitRun(own.id);
    await waitFor(() => dlgs(t.orch).every((d) => d.state === "returned"), { label: "两件都交回" });
    // B 的会话按派活顺序收到：自己的、一号、二号
    assert.deepEqual(fb.calls.map((c) => body(c.text)), ["B 自己在忙", "一号活", "二号活"]);
    const children = t.orch.listRuns({ botId: b.id }).filter((r) => r.parentRunId === parent.id);
    assert.equal(children.length, 2);
  } finally {
    await t.cleanup();
  }
});

await test("子任务做完：父 bot 被唤醒，收到结果和子 Run id；重复交付不重复唤醒", async () => {
  const t = newTeam();
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "complete", text: "周报写好了，在 work/weekly.md" }];
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "写周报" } }];
    const parent = await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派周报" }).id);
    assert.match(parent.reply, /做完后结果会作为一条新消息交回给你/);
    const rec = await waitFor(() => dlgs(t.orch).find((d) => d.delivery === "delivered"), { label: "已交回" });
    const wake = await t.orch.waitRun(rec.wakeRunId);
    assert.equal(wake.botId, a.id);
    assert.equal(wake.kind, "chat");
    assert.match(wake.text, /^\[派活交回\] 你派给 Beta 的活做完了/);
    assert.match(wake.text, new RegExp(`子 Run：${rec.childRunId}`));
    assert.match(wake.text, /周报写好了，在 work\/weekly\.md/);
    assert.equal(body(fa.calls.at(-1).text), wake.text, "A 的会话真的收到了交回消息");
    assert.equal(t.orch.runs.get(wake.id).sender, `🤖 Beta (@${b.id})`);
    assert.equal(rec.result.state, "completed");

    // 再交付、再推进、再落定一次子 Run：都不能再唤醒
    assert.equal(t.orch._deliverDelegation(rec.id).outcome, "noop");
    t.orch._pumpDelegations();
    t.orch._onRunSettled(t.orch.getRun(rec.childRunId));
    await delay(30);
    assert.equal(wakesOf(t.orch, a.id).length, 1);
    assert.equal(t.events.filter((e) => e.type === "delegation_delivered").length, 1);
  } finally {
    await t.cleanup();
  }
});

await test("父 bot 正忙：交付挂 pending，空了再送，不插进别的回合", async () => {
  const t = newTeam();
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "gate", text: "B 做完了" }];
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "慢活" } }, { kind: "gate", text: "A 别的事" }];
    await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派慢活" }).id);
    const busyA = t.orch.startRun({ botId: a.id, text: "A 接着忙别的" });
    await waitFor(() => fa.busy && fb.busy, { label: "A、B 都在忙" });
    fb.release();
    const rec = await waitFor(() => dlgs(t.orch).find((d) => d.state === "returned"), { label: "B 交回" });
    await delay(30);
    assert.equal(t.orch.ledger.get("delegations", rec.id).delivery, "pending");
    assert.equal(wakesOf(t.orch, a.id).length, 0);
    fa.release();
    await t.orch.waitRun(busyA.id);
    await waitFor(() => wakesOf(t.orch, a.id).length === 1, { label: "A 空了才收到" });
  } finally {
    await t.cleanup();
  }
});

await test("重启：跑到一半的子任务交回「中断」，不自动重跑", async () => {
  const t = newTeam();
  let t2;
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "hang" }];
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "写周报" } }];
    await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派周报" }).id);
    await waitFor(() => fb.busy, { label: "B 在跑" });
    const childId = dlgs(t.orch)[0].childRunId;
    crash(t);
    t2 = newTeam({ home: t.home });
    assert.equal(t2.orch.getRun(childId).state, "interrupted");
    const rec = await waitFor(() => t2.orch.listDelegations({}).find((d) => d.delivery === "delivered"), { label: "补送中断" });
    assert.equal(rec.result.state, "interrupted");
    const wake = await t2.orch.waitRun(rec.wakeRunId);
    assert.match(wake.text, /因为服务重启中断了，没有自动重跑/);
    assert.match(wake.text, new RegExp(childId));
    await delay(30);
    const bRuns = t2.orch.listRuns({ botId: b.id });
    assert.equal(bRuns.length, 1, "B 没有被自动重跑");
    assert.equal(t2.fake(b.id), undefined, "B 在新进程里没起过回合");
  } finally {
    try {
      await t2?.cleanup();
    } catch {}
  }
});

await test("重启：排队的继续排，起来后照常开跑并交回", async () => {
  const t = newTeam();
  let t2;
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "hang" }];
    t.orch.startRun({ botId: b.id, text: "B 自己在忙" });
    await waitFor(() => fb.busy, { label: "B busy" });
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "排着的活" } }];
    await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派活" }).id);
    assert.equal(dlgs(t.orch)[0].state, "queued");
    crash(t);
    t2 = newTeam({ home: t.home });
    const rec = await waitFor(() => t2.orch.listDelegations({}).find((d) => d.delivery === "delivered"), { label: "开跑并交回" });
    assert.equal(rec.result.state, "completed");
    assert.equal(body(rec.result.reply.replace(/^echo:/, "")), "排着的活");
    const wake = await t2.orch.waitRun(rec.wakeRunId);
    assert.match(wake.text, /结果：\necho:.*\n排着的活/);
  } finally {
    try {
      await t2?.cleanup();
    } catch {}
  }
});

await test("重启：做完但没送到的补送一次", async () => {
  const t = newTeam();
  let t2;
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "complete", text: "早就做完" }];
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "快活" } }, { kind: "hang" }];
    await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派快活" }).id);
    // A 马上被别的事占住，交付只能挂着
    t.orch.startRun({ botId: a.id, text: "A 接着忙" });
    await waitFor(() => fa.busy, { label: "A busy" });
    const rec = await waitFor(() => dlgs(t.orch).find((d) => d.state === "returned"), { label: "B 交回" });
    assert.equal(rec.delivery, "pending");
    crash(t);
    t2 = newTeam({ home: t.home });
    const sent = await waitFor(() => t2.orch.ledger.get("delegations", rec.id)?.delivery === "delivered" && t2.orch.ledger.get("delegations", rec.id), { label: "补送" });
    const wake = await t2.orch.waitRun(sent.wakeRunId);
    assert.match(wake.text, /早就做完/);
    await delay(30);
    assert.equal(wakesOf(t2.orch, a.id).length, 1);
  } finally {
    try {
      await t2?.cleanup();
    } catch {}
  }
});

await test("交回前重查可见性：父 bot 换了工作区，结果不送过去，记 dropped", async () => {
  const t = newTeam();
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "gate", text: "私有结果" }];
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "活" } }];
    await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派" }).id);
    await waitFor(() => fb.busy, { label: "B 在跑" });
    t.orch.updateBot(a.id, { workspace: "/elsewhere" });
    fb.release();
    const rec = await waitFor(() => dlgs(t.orch).find((d) => d.delivery === "dropped"), { label: "dropped" });
    assert.equal(rec.dropReason, "visibility_revoked");
    assert.equal(rec.result.reply, "私有结果", "结果仍留在记录里供工作台查看");
    await delay(30);
    assert.equal(wakesOf(t.orch, a.id).length, 0);
    assert.equal(fa.calls.some((c) => c.text.includes("私有结果")), false);
  } finally {
    await t.cleanup();
  }
});

await test("排队期间撤权：开跑前重查，不开跑，只告诉父 bot 没能开跑", async () => {
  const t = newTeam();
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "gate" }];
    const own = t.orch.startRun({ botId: b.id, text: "B 忙" });
    await waitFor(() => fb.busy, { label: "B busy" });
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "越界的活" } }];
    await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派" }).id);
    t.orch.updateBot(b.id, { workspace: "/elsewhere" });
    fb.release();
    await t.orch.waitRun(own.id);
    const rec = await waitFor(() => dlgs(t.orch).find((d) => d.delivery === "delivered"), { label: "交回没开跑" });
    assert.equal(rec.result.state, "not_started");
    assert.equal(rec.childRunId, undefined);
    assert.equal(fb.calls.some((c) => body(c.text) === "越界的活"), false);
    const wake = await t.orch.waitRun(rec.wakeRunId);
    assert.match(wake.text, /没能开跑/);
    assert.match(wake.text, /跨工作区/);
  } finally {
    await t.cleanup();
  }
});

await test("父回合被取消：排队的活不再开跑，也不唤醒父 bot", async () => {
  const t = newTeam();
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "gate" }];
    const own = t.orch.startRun({ botId: b.id, text: "B 忙" });
    await waitFor(() => fb.busy, { label: "B busy" });
    // 父回合还在跑时派活（直接调工具，模拟回合中途的 tool call），然后用户取消父回合
    fa.queue = [{ kind: "hang" }];
    const parent = t.orch.startRun({ botId: a.id, text: "派完接着干" });
    await waitFor(() => fa.busy, { label: "A 在跑" });
    const tool = fa.tools.find((x) => x.name === "delegate_bot");
    const out = await tool.handler({ to: b.name, message: "要被撤的" }, {});
    assert.match(out.text, /已排队/);
    await t.orch.cancelRun(parent.id);
    const rec = dlgs(t.orch)[0];
    assert.equal(rec.state, "returned");
    assert.equal(rec.delivery, "dropped");
    assert.equal(rec.dropReason, "parent_cancelled");
    fb.release();
    await t.orch.waitRun(own.id);
    await delay(30);
    assert.equal(fb.calls.some((c) => body(c.text) === "要被撤的"), false);
    assert.equal(wakesOf(t.orch, a.id).length, 0);
  } finally {
    await t.cleanup();
  }
});

await test("当场被拒（并发上限）照旧报错，不排队也不另行唤醒", async () => {
  const t = newTeam({ maxConcurrency: 1 });
  try {
    const { a, b, fa, fb } = await pair(t);
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "派活" } }];
    const done = await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派" }).id);
    assert.match(done.reply, /当前无法接手：.*并发已达上限/);
    const rec = dlgs(t.orch)[0];
    assert.equal(rec.result.state, "not_started");
    assert.equal(rec.delivery, "dropped");
    assert.equal(rec.dropReason, "rejected_inline");
    await delay(30);
    assert.equal(fb.calls.length, 0);
    assert.equal(wakesOf(t.orch, a.id).length, 0);
  } finally {
    await t.cleanup();
  }
});

await test("正常关停再起：跑着的按中断交回，排队的还在排（关停的级联取消不算用户取消）", async () => {
  const t = newTeam();
  let t2;
  try {
    const a = t.orch.addBot({ name: "Alpha" });
    const b = t.orch.addBot({ name: "Beta" });
    const c = t.orch.addBot({ name: "Gamma" });
    const fa = await t.orch.runtimeFor(a.id, "private");
    const fb = await t.orch.runtimeFor(b.id, "private");
    const fc = await t.orch.runtimeFor(c.id, "private");
    fc.queue = [{ kind: "gate" }];
    t.orch.startRun({ botId: c.id, text: "C 忙" });
    fb.queue = [{ kind: "hang" }];
    fa.queue = [{ kind: "hang" }];
    const parent = t.orch.startRun({ botId: a.id, text: "派两件" });
    await waitFor(() => fa.busy && fc.busy, { label: "A、C 在跑" });
    const tool = fa.tools.find((x) => x.name === "delegate_bot");
    assert.match((await tool.handler({ to: b.name, message: "给 B 的" }, {})).text, /已派给 Beta/);
    assert.match((await tool.handler({ to: c.name, message: "给 C 的" }, {})).text, /已排队/);
    await waitFor(() => fb.busy, { label: "B 在跑" });
    await t.orch.shutdown();
    t2 = newTeam({ home: t.home });
    const toB = await waitFor(
      () => t2.orch.listDelegations({}).find((d) => d.targetBotId === b.id && d.delivery === "delivered"),
      { label: "B 那件按中断交回" },
    );
    assert.equal(toB.result.state, "interrupted");
    const toC = await waitFor(
      () => t2.orch.listDelegations({}).find((d) => d.targetBotId === c.id && d.delivery === "delivered"),
      { label: "C 那件起来后开跑并交回" },
    );
    assert.equal(toC.result.state, "completed");
    assert.equal(t2.orch.getRun(parent.id).state === "completed", false);
  } finally {
    try {
      await t2?.cleanup();
    } catch {}
  }
});

await test("子任务做外部动作时崩溃：交回写「外部动作结果未知」，不说成单纯中断", async () => {
  const t = newTeam();
  let t2;
  try {
    const { a, b, fa, fb } = await pair(t);
    fb.queue = [{ kind: "hang" }];
    fa.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "装依赖" } }];
    await t.orch.waitRun(t.orch.startRun({ botId: a.id, text: "派" }).id);
    await waitFor(() => fb.busy, { label: "B 在跑" });
    const childId = dlgs(t.orch)[0].childRunId;
    t.orch.beginSideEffect(childId, { tool: "computer_install_packages", kind: "install_packages" });
    crash(t);
    t2 = newTeam({ home: t.home });
    const rec = await waitFor(() => t2.orch.listDelegations({}).find((d) => d.delivery === "delivered"), { label: "交回" });
    assert.equal(rec.result.state, "reconciliation_required");
    const wake = await t2.orch.waitRun(rec.wakeRunId);
    assert.match(wake.text, /有外部动作结果未知，需要人工核对/);
  } finally {
    try {
      await t2?.cleanup();
    } catch {}
  }
});

await test("派活教模型写交接简报：工具说明讲清对方看不到对话，人设也提醒", async () => {
  const t = newTeam();
  try {
    const { fa } = await pair(t);
    const tool = fa.tools.find((x) => x.name === "delegate_bot");
    const msg = tool.parameters.properties.message.description;
    assert.match(msg, /对方看不到你和用户的对话/);
    for (const part of ["背景", "相关文件", "现状", "试过什么", "约束", "不要改文件"]) assert.ok(msg.includes(part), part);
    assert.match(tool.description, /先用 list_bots 按角色挑人/);
    const { personaText } = await import("../src/persona.mjs");
    assert.match(personaText(), /对方看不到你的对话/);
  } finally {
    await t.cleanup();
  }
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

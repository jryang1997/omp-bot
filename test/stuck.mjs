// test/stuck.mjs — 卡住/死循环检测：纯函数 + 编排器接线。零模型调用，不启 omp。

import assert from "node:assert/strict";
import { newTeam, waitFor } from "./_harness.mjs";
import { createStuckDetector, toolFingerprint } from "../src/stuck.mjs";
import { STUCK_STEER_AT, STUCK_CANCEL_AT } from "../src/constants.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`); }
}

let seq = 0;
/** 一次工具调用的原生帧（形状照 OMP packages/agent/src/types.ts）。 */
function call(toolName, args, text, { isError = false, details } = {}) {
  const id = `tc${++seq}`;
  return [
    { type: "tool_execution_start", toolCallId: id, toolName, args },
    { type: "tool_execution_end", toolCallId: id, toolName, result: { content: [{ type: "text", text }], details }, isError },
  ];
}
const feed = (d, frames) => frames.map((f) => d.observe(f)).filter(Boolean);

await test("同参数同结果：第 3 次 steer，第 6 次 cancel", async () => {
  assert.equal(STUCK_STEER_AT, 3);
  assert.equal(STUCK_CANCEL_AT, 6);
  const d = createStuckDetector();
  const hits = [];
  for (let i = 1; i <= 6; i++) hits.push(...feed(d, call("bash", { command: "npm test" }, "1 failing")).map((h) => ({ i, ...h })));
  assert.deepEqual(hits, [
    { i: 3, action: "steer", toolName: "bash", count: 3 },
    { i: 6, action: "cancel", toolName: "bash", count: 6 },
  ]);
  assert.deepEqual(feed(d, call("bash", { command: "npm test" }, "1 failing")), [], "cancel 只报一次");
});

await test("参数一样但结果变了不算重复（在推进）", async () => {
  const d = createStuckDetector();
  const hits = [];
  for (let i = 0; i < 10; i++) hits.push(...feed(d, call("bash", { command: "curl -s status" }, `progress ${i}`)));
  assert.deepEqual(hits, []);
});

await test("A、B 交替打转也能抓到", async () => {
  const d = createStuckDetector();
  const hits = [];
  for (let i = 0; i < 3; i++) {
    hits.push(...feed(d, call("read", { path: "a" }, "A")));
    hits.push(...feed(d, call("read", { path: "b" }, "B")));
  }
  assert.deepEqual(hits.map((h) => h.action), ["steer", "steer"]);
});

await test("指纹：键顺序无关，details 里的耗时不影响，isError 区分", async () => {
  const r = { content: [{ type: "text", text: "x" }] };
  assert.equal(toolFingerprint("t", { a: 1, b: 2 }, r, false), toolFingerprint("t", { b: 2, a: 1 }, r, false));
  assert.equal(
    toolFingerprint("t", {}, { ...r, details: { ms: 1 } }, false),
    toolFingerprint("t", {}, { ...r, details: { ms: 99 } }, false),
  );
  assert.notEqual(toolFingerprint("t", {}, r, false), toolFingerprint("t", {}, r, true));
  assert.notEqual(toolFingerprint("t", { a: 1 }, r, false), toolFingerprint("u", { a: 1 }, r, false));
});

await test("OMP 给重复读加的计数提示不影响指纹（真 omp 18.11.3 的原文）", async () => {
  const base = "[/data/realtest/proj/x.txt#7E92]\n1:same";
  const note = (n) => `${base}\n\n[You have received this identical output ${n} times. Re-reading '/data/realtest/proj/x.txt' will not change it \u2014 use a narrower selector (path:A-B), or proceed with the edit.]`;
  const fp = (text) => toolFingerprint("read", { path: "x.txt" }, { content: [{ type: "text", text }] }, false);
  assert.equal(fp(note(3)), fp(base));
  assert.equal(fp(note(4)), fp(note(5)));
  assert.notEqual(fp(`${base}\n2:other`), fp(base));
});

await test("编排器：重复 3 次插一句换策略，Run 还在跑", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "LoopProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    const frames = [1, 2, 3].flatMap(() => call("bash", { command: "ls nope" }, "No such file", { isError: true }));
    fake.queue = [{ kind: "frames", frames, hang: true }];
    const run = t.orch.startRun({ botId: bot.id, text: "找文件" });
    await waitFor(() => fake.steered, { label: "收到 steer" });
    assert.match(fake.steered.text, /同样的参数调用 bash 3 次/);
    assert.equal(t.orch.getRun(run.id).state, "running");
    const ev = t.events.find((e) => e.type === "run_stuck");
    assert.equal(ev?.action, "steer");
    assert.equal(ev?.runId, run.id);
    await t.orch.cancelRun(run.id);
  } finally {
    await t.cleanup();
  }
});

await test("编排器：重复 6 次取消 Run，错误里写清原因", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "LoopKill" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    const frames = [1, 2, 3, 4, 5, 6].flatMap(() => call("bash", { command: "ls nope" }, "No such file", { isError: true }));
    fake.queue = [{ kind: "frames", frames, hang: true }];
    const run = t.orch.startRun({ botId: bot.id, text: "找文件" });
    // 有界等：检测没接上时这里会挂住，要让它明确失败而不是吊着进程。
    await waitFor(() => t.orch.getRun(run.id).state === "cancelled", { timeoutMs: 5000, label: "Run 被取消" });
    const done = t.orch.getRun(run.id);
    assert.match(done.error, /stuck-loop: 同样的 bash 调用重复 6 次/);
    assert.ok(fake.abortCalls >= 1, "原生 abort 被调用");
  } finally {
    await t.cleanup();
  }
});

await test("编排器：正常推进的 Run 不受打扰", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "Fine" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    const frames = [1, 2, 3, 4, 5, 6, 7].flatMap((i) => call("bash", { command: "npm test" }, `${7 - i} failing`));
    fake.queue = [{ kind: "frames", frames, text: "修好了" }];
    const run = t.orch.startRun({ botId: bot.id, text: "修测试" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.equal(fake.steered, undefined);
    assert.equal(t.events.filter((e) => e.type === "run_stuck").length, 0);
  } finally {
    await t.cleanup();
  }
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

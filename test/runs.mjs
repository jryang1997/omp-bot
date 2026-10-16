// test/runs.mjs — 运行契约、审批、取消级联与准入的行为测试。
//
// 只用注入的 runtime 夹具驱动「消费者视角的状态迁移/拒绝/级联」，
// Store 与 Ledger 一律使用真实实现（临时 home），不 mock 持久层。
// 不跑模型、不启 omp 进程；默认 TTL 用构造参数缩短，走真实定时器路径。

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { Orchestrator } from "../src/orchestrator.mjs";
import { memoryPrereqStatus, writePrivateMemoryConfig } from "../src/memory-config.mjs";
import { BotRuntime, runtimeDirs, evaluateToolSurface, canonicalNativeModel } from "../src/bot.mjs";

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

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待条件成立；超时抛出真实错误（不用假成功兜底）。 */
async function waitFor(fn, { timeoutMs = 2000, label = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`等待超时：${label}`);
    await delay(5);
  }
}

/** 注入的 runtime 夹具：只实现编排器真正调用的原生面。 */
class FakeRuntime extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.bot = opts.bot;
    this.scope = opts.scope;
    this.state = "stopped";
    this.sessionId = "sess_fixture";
    this.sessionFile = join(opts.home, "fixtures", `${opts.bot.id}.jsonl`);
    this.deliveryDepth = 0;
    this.activeRun = null;
    this.capabilities = { protocolVersion: 2, extensionUi: true, abort: true };
    this.tools = opts.teamToolsFactory(this);
    this.rpc = {
      env: {},
      exportHtml: async (p) => {
        this.exportedTo = p;
        writeFileSync(p, "<html>fixture</html>", "utf8");
      },
    };
    this.queue = [];
    this.calls = [];
    this.responses = [];
    this.abortCalls = 0;
    this.policyOk = true;
    this.stats = undefined;
    this.completedTurns = 0;
    this._tcSeq = 0;
    this._uiWaiters = [];
    this._abortWaiters = [];
  }

  get busy() {
    return this.state === "busy";
  }

  get alive() {
    return this.state === "idle" || this.state === "busy";
  }

  matchesPolicy() {
    return this.policyOk;
  }

  async start() {
    this.state = "idle";
    this.emit("capabilities", this.capabilities);
    return this;
  }

  async stop() {
    // 真实语义：宿主回收进程 → 在飞的回合以「进程已退出、未静默」失败收场。
    this.state = "stopped";
    const err = Object.assign(new Error("rpc process exited (killed)"), {
      settled: false,
      killed: true,
    });
    for (const w of this._abortWaiters.splice(0)) w.reject(err);
    for (const w of this._uiWaiters.splice(0)) w.reject(err);
  }

  async getStats() {
    if (this.stats === null) return null; // 显式模拟「原生用量读不到」
    if (this.stats) return this.stats;
    // 真实语义：get_session_stats 是会话累计值，每完成一个回合才会增长；
    // 编排器在回合前后各取一次快照，差值就是本回合用量。
    const turns = this.completedTurns;
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      model: "fixture/provider-model",
      provider: "fixture",
      tokens: { input: 10 * turns, output: 5 * turns, total: 15 * turns },
      cost: 0.001 * turns,
      userMessages: turns,
    };
  }

  async promptAndWait(text, { signal, runId, depth } = {}) {
    this.state = "busy";
    if (depth !== undefined) this.deliveryDepth = depth;
    this.activeRun = { runId: runId ?? null, abort: new AbortController() };
    this.calls.push({ text, runId });
    const step = this.queue.shift() ?? { kind: "complete", text: `echo:${text}` };
    if (signal?.aborted) {
      this.state = "idle";
      this.activeRun = null;
      throw Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted", settled: true });
    }
    try {
      const out = await this._step(step, text);
      // 只有真正跑完的回合才计入会话累计用量（被杀/超时的不计）。
      this.completedTurns += 1;
      this.state = "idle";
      return out;
    } catch (e) {
      // 真实语义：进程被回收 → stopped；其它错误（含已静默的 abort）回到 idle。
      this.state = e?.killed === true ? "stopped" : "idle";
      throw e;
    } finally {
      this.deliveryDepth = 0;
      this.activeRun = null;
    }
  }

  async _step(step, text) {
    switch (step.kind) {
      case "complete":
        return { text: step.text ?? `echo:${text}`, status: "completed", settled: true };
      case "error":
        throw Object.assign(new Error(step.message ?? "fixture error"), {
          settled: step.settled === true,
        });
      case "timeout":
        throw Object.assign(new Error("回合超时：fixture"), {
          code: "timeout",
          settled: step.settled === true,
        });
      case "hang":
        await new Promise((resolve, reject) => {
          this._abortWaiters.push({ resolve, reject });
        });
        return { text: "never", status: "completed", settled: true };
      case "ui": {
        this.emit("ui_request", step.frame);
        const answered = await new Promise((resolve, reject) => {
          this._uiWaiters.push({ resolve, reject });
        });
        return { text: `ui:${JSON.stringify(answered)}`, status: "completed", settled: true };
      }
      case "tool": {
        const out = await this._callTool(step.tool, step.args, step.signal);
        this.lastToolResult = out;
        return { text: out.text ?? JSON.stringify(out), status: "completed", settled: true };
      }
      case "toolx": {
        const texts = [];
        for (const call of step.calls) {
          const out = await this._callTool(call.tool, call.args, call.signal);
          texts.push(out.text ?? JSON.stringify(out));
        }
        return { text: texts.join("\n---\n"), status: "completed", settled: true };
      }
      case "frames": {
        for (const f of step.frames) {
          // 与真实 BotRuntime 一致：extension_ui_request 既走 native_frame 也走 ui_request。
          this.emit("native_frame", f);
          if (f?.type === "extension_ui_request") this.emit("ui_request", f);
        }
        return { text: step.text ?? "frames-sent", status: "completed", settled: true };
      }
      default:
        throw new Error(`未知夹具步骤 ${step.kind}`);
    }
  }

  async _callTool(name, args, signal) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`夹具没有工具 ${name}`);
    try {
      return await tool.handler(args, {
        toolCallId: `tc_${++this._tcSeq}`,
        toolName: name,
        requestId: this._tcSeq,
        signal,
        progress: () => {},
      });
    } catch (e) {
      // 与 RpcClient._serveHostTool 一致：handler 抛错会被传输层包成 isError 结果，
      // 不会让整个回合失败；这里照样镜像，避免夹具造出真实传输不存在的结局。
      return { text: `host tool error: ${e?.message ?? String(e)}`, isError: true };
    }
  }

  /** 宿主确认静默后落回 idle（与真实 BotRuntime 同名同语义）。 */
  markSettled() {
    this.state = "idle";
    this.deliveryDepth = 0;
    this.activeRun = null;
    return this.state;
  }

  async steer(text, { behavior } = {}) {
    this.steered = { text, behavior };
    return { ok: true };
  }

  async abort() {
    this.abortCalls++;
    for (const w of this._abortWaiters.splice(0)) {
      w.reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted", settled: true }));
    }
    return { ok: true };
  }

  async abortBash() {
    return null;
  }

  async cancelSubagent(id) {
    this.cancelledSubagents = [...(this.cancelledSubagents ?? []), id];
    return null;
  }

  async waitSettled() {
    // 有还没被解除的等待（回合真的在跑）就是没静默；不撒谎返回 settled。
    const pending = this._abortWaiters.length + this._uiWaiters.length;
    return { settled: pending === 0, source: "get_state" };
  }

  respondUi(nativeId, payload) {
    this.responses.push({ nativeId, payload });
    for (const w of this._uiWaiters.splice(0)) w.resolve(payload);
    return { type: "extension_ui_response", id: nativeId };
  }

  async getNativeState() {
    return { sessionId: this.sessionId, isSettled: true };
  }

  async newSession() {
    this.newSessionCalled = true;
    return { sessionId: "sess_new", sessionFile: "/x/new.jsonl" };
  }

  async fork(opts) {
    this.forkCalled = opts;
    return { sessionId: "sess_fork", sessionFile: "/x/fork.jsonl" };
  }

  async entries() {
    return { entries: [{ id: "e1", role: "user" }] };
  }

  async nativeCommand(cmd) {
    this.lastNativeCommand = cmd;
    return { models: [{ id: "fixture/model" }] };
  }

  async exportSession() {
    return { path: "/fixture" };
  }
}

/** 夹具 features：只实现编排器调用到的钩子（真实特性层由 FeaturesOwner 测）。 */
function stubFeatures({ isPaused } = {}) {
  return {
    handleRequest: async () => false,
    start: async () => {},
    close: async () => {},
    preparePrompt: async (run) => ({ text: run.text }),
    collectArtifacts: async () => [],
    ...(isPaused ? { isPaused } : {}),
  };
}

/** 每个测试独立临时 home + 真实 Store/Ledger + 注入的 runtime 夹具。 */
function newTeam({ uiApprovalTtlMs = 60_000, features, maxConcurrency, policyIdleTimeoutMs } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ompbot-runs-"));
  const created = new Map();
  const events = [];
  let index = 0;
  const feats = features ?? stubFeatures();
  const orch = new Orchestrator({
    home,
    bin: "omp-fixture",
    uiApprovalTtlMs,
    policyIdleTimeoutMs: policyIdleTimeoutMs ?? 300,
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    features: feats,
    onEvent: (e) => events.push(e),
    runtimeFactory: (opts) => {
      index++;
      const rt = new FakeRuntime(opts);
      rt.key = `${opts.bot.id}::${opts.scope}`;
      rt.index = index;
      created.set(rt.key, rt);
      return rt;
    },
  });
  return {
    home,
    orch,
    events,
    fakes: created,
    fake: (botId, scope = "private") => created.get(`${botId}::${scope}`),
    cleanup: async () => {
      try {
        await orch.shutdown();
      } catch {}
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const typesOf = (events) => events.map((e) => e.type);

// ---- 1. admission：同步返回、原子预留、失败也持久 ----

await test("startRun 同步返回持久 run 并原子预留 scope；第二个并发 409", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "Alpha", model: "fixture/model" });
    const run = t.orch.startRun({ botId: bot.id, text: "hi" });
    assert.equal(run.state, "starting");
    assert.equal(run.kind, "chat");
    assert.equal(run.scope, "private");
    assert.match(run.id, /^run_/);
    assert.deepEqual(t.orch.getRun(run.id), run);

    assert.throws(
      () => t.orch.startRun({ botId: bot.id, text: "again" }),
      (e) => e.status === 409 && e.code === "target_busy",
    );
    // 被拒的启动不留下第二次运行记录
    assert.equal(t.orch.listRuns({ botId: bot.id }).length, 1);

    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.equal(done.reply, "echo:hi");
    assert.equal(done.sessionId, "sess_fixture");
    // 原生用量差值持久在 run.stats 上（夹具一轮 15 tokens）
    assert.equal(done.stats.delta.totalTokens, 15);
    assert.equal(done.stats.at > 0, true);

    // 租约已释放：可以再起一条
    const second = t.orch.startRun({ botId: bot.id, text: "second" });
    const secondDone = await t.orch.waitRun(second.id);
    assert.equal(secondDone.reply, "echo:second");
    assert.equal(t.orch.listRuns({ botId: bot.id }).length, 2);
  } finally {
    await t.cleanup();
  }
});

await test("真实 Store：私聊展示缓存与花名册默认字段落盘", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "StoreProbe" });
    assert.equal(bot.executionMode, "supervised");
    assert.equal(bot.approvalMode, "write");
    assert.equal(bot.memoryEnabled, false);
    assert.equal(bot.workspace, "");

    const run = t.orch.startRun({ botId: bot.id, text: "记住我" });
    await t.orch.waitRun(run.id);

    const chat = t.orch.getChat(bot.id);
    assert.deepEqual(chat.map((m) => m.role), ["user", "assistant"]);
    assert.equal(chat[0].text, "记住我");
    assert.equal(chat[1].text, "echo:记住我");

    const statePath = join(t.home, "state.json");
    assert.equal(existsSync(statePath), true);
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(raw.bots[bot.id].name, "StoreProbe");
    assert.equal(raw.bots[bot.id].executionMode, "supervised");
  } finally {
    await t.cleanup();
  }
});

await test("事件投影：run_created/run_updated/run_finished 带单调 seq，可重放", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "SeqProbe" });
    const run = t.orch.startRun({ botId: bot.id, text: "x" });
    await t.orch.waitRun(run.id);

    const seqs = t.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i] > seqs[i - 1], true);

    const types = typesOf(t.events);
    assert.equal(types.includes("run_created"), true);
    assert.equal(types.includes("run_updated"), true);
    assert.equal(types.includes("run_finished"), true);

    const replayed = t.orch.eventsSince(0);
    assert.equal(replayed.length, t.events.length);
    assert.deepEqual(
      replayed.filter((e) => e.type === "run_created").map((e) => e.run.id),
      [run.id],
    );
    const after = t.orch.eventsSince(replayed[1].seq);
    assert.equal(after.length, replayed.length - 2);
  } finally {
    await t.cleanup();
  }
});

// ---- 2. 原生审批 ----

await test("select 审批：选项校验、拒绝非法值、二次应答 409、应答后 Run 回到 running", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "ApprovalProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [
      {
        kind: "ui",
        frame: {
          type: "extension_ui_request",
          id: "native_ui_1",
          method: "select",
          title: "允许写文件？",
          options: ["Approve", "Deny"],
        },
      },
    ];
    const run = t.orch.startRun({ botId: bot.id, text: "写文件" });

    const approval = await waitFor(() => t.orch.ledger.list("approvals")[0], { label: "审批记录" });
    assert.equal(approval.status, "pending");
    assert.equal(approval.nativeId, "native_ui_1");
    assert.equal(approval.runId, run.id);
    assert.equal(t.orch.getRun(run.id).state, "waiting_approval");
    assert.deepEqual(t.orch.getRun(run.id).approvalIds, [approval.id]);

    await assert.rejects(
      () => t.orch.answerUi(approval.id, { value: "Nope" }),
      (e) => e.status === 400 && e.code === "response_invalid",
    );
    await assert.rejects(
      () => t.orch.answerUi(approval.id, {}),
      (e) => e.status === 400,
    );

    const answered = await t.orch.answerUi(approval.id, { value: "Approve" });
    assert.equal(answered.status, "answered");
    assert.deepEqual(fake.responses, [{ nativeId: "native_ui_1", payload: { value: "Approve" } }]);

    await assert.rejects(
      () => t.orch.answerUi(approval.id, { value: "Approve" }),
      (e) => e.status === 409 && e.code === "approval_not_pending",
    );

    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.equal(done.reply, 'ui:{"value":"Approve"}');
    assert.equal(t.events.filter((e) => e.type === "ui_request").length, 1);
    assert.equal(t.events.filter((e) => e.type === "ui_resolved").length, 1);
  } finally {
    await t.cleanup();
  }
});

await test("信息输入类审批到期：标 expired、原生回 cancel、Run 走取消路径（不自动作答）", async () => {
  const t = newTeam({ uiApprovalTtlMs: 40 });
  try {
    const bot = t.orch.addBot({ name: "AskProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [
      {
        kind: "ui",
        frame: {
          type: "extension_ui_request",
          id: "native_ask_1",
          method: "ask",
          questions: [{ question: "目标目录？", options: ["/a", "/b"] }],
        },
      },
    ];
    const run = t.orch.startRun({ botId: bot.id, text: "问一句" });
    const approval = await waitFor(() => t.orch.ledger.list("approvals")[0], { label: "提问记录" });

    const expired = await waitFor(
      () => {
        const rec = t.orch.ledger.get("approvals", approval.id);
        return rec.status === "expired" ? rec : null;
      },
      { label: "审批到期" },
    );
    assert.equal(expired.expiredReason, "ttl");
    assert.equal(expired.response, null); // 没有替用户作答
    assert.deepEqual(fake.responses, [{ nativeId: "native_ask_1", payload: { cancelled: true } }]);

    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "cancelled");
    assert.equal(done.reply, null);
  } finally {
    await t.cleanup();
  }
});

await test("授权类审批到期：按原生 cancel/deny 处理，Run 不因过期被取消", async () => {
  const t = newTeam({ uiApprovalTtlMs: 40 });
  try {
    const bot = t.orch.addBot({ name: "ConfirmProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [
      {
        kind: "ui",
        frame: { type: "extension_ui_request", id: "native_confirm_1", method: "confirm", title: "允许执行？" },
      },
    ];
    const run = t.orch.startRun({ botId: bot.id, text: "执行" });
    const approval = await waitFor(() => t.orch.ledger.list("approvals")[0], { label: "审批记录" });
    await waitFor(
      () => t.orch.ledger.get("approvals", approval.id).status === "expired",
      { label: "审批到期" },
    );
    assert.deepEqual(fake.responses, [{ nativeId: "native_confirm_1", payload: { cancelled: true } }]);
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.equal(typesOf(t.events).includes("ui_expired_denied"), true);
  } finally {
    await t.cleanup();
  }
});

// ---- 3. 取消级联 ----

await test("cancelRun：cancelling → 原生 abort → cancelled，随后可再起新 Run", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "CancelProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [{ kind: "hang" }];
    const run = t.orch.startRun({ botId: bot.id, text: "长回合" });
    await waitFor(() => t.orch.getRun(run.id).state === "running", { label: "进入 running" });

    const out = await t.orch.cancelRun(run.id);
    assert.equal(out.accepted, true);
    assert.equal(out.run.state, "cancelled");
    assert.equal(fake.abortCalls, 1);

    // 「先接受取消」必须早于真正落定：cancelling 事件在 run_finished 之前
    const cancelling = t.events.find((e) => e.type === "run_updated" && e.run.state === "cancelling");
    const finished = t.events.find((e) => e.type === "run_finished" && e.runId === run.id);
    assert.equal(cancelling !== undefined, true);
    assert.equal(finished.run.state, "cancelled");
    assert.equal(cancelling.seq < finished.seq, true);

    const again = await t.orch.cancelRun(run.id);
    assert.equal(again.accepted, false);

    fake.queue = [{ kind: "complete", text: "after-cancel" }];
    const next = t.orch.startRun({ botId: bot.id, text: "再来" });
    assert.equal((await t.orch.waitRun(next.id)).reply, "after-cancel");
  } finally {
    await t.cleanup();
  }
});

await test("取消挂起原生审批：解除 UI 等待、落 cancelled，随后可继续运行", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "CancelApprovalProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [{ kind: "ui", frame: {
      type: "extension_ui_request", id: "cancel-ui", method: "confirm", title: "允许执行？",
    } }];
    const run = t.orch.startRun({ botId: bot.id, text: "等待审批" });
    const approval = await waitFor(() => t.orch.ledger.list("approvals").find((a) => a.runId === run.id && a.status === "pending"));
    const out = await t.orch.cancelRun(run.id);
    assert.equal(out.run.state, "cancelled");
    assert.equal(t.orch.ledger.get("approvals", approval.id).status, "cancelled");
    assert.equal(fake.busy, false);
    fake.queue = [{ kind: "complete", text: "after-approval-cancel" }];
    const next = t.orch.startRun({ botId: bot.id, text: "继续" });
    assert.equal((await t.orch.waitRun(next.id)).reply, "after-approval-cancel");
  } finally {
    await t.cleanup();
  }
});

await test("原生 abort 失败 + 进程被回收：落 reconciliation_required，不假称 cancelled", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "CancelErrProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [{ kind: "hang" }];
    fake.abort = async () => {
      throw new Error("原生拒绝 abort");
    };
    const run = t.orch.startRun({ botId: bot.id, text: "长回合" });
    await waitFor(() => t.orch.getRun(run.id).state === "running", { label: "进入 running" });
    const out = await t.orch.cancelRun(run.id);
    // 取消被接受，但原生没确认静默（进程被回收）→ 效果未知，不是 cancelled
    assert.equal(out.accepted, true);
    assert.equal(out.run.state, "reconciliation_required");
    assert.equal(out.run.recovery.reason, "abort_failed");
    assert.match(out.run.error, /原生 abort 失败/);
    assert.equal(fake.state, "stopped");
    // 驱动的回合 promise 也确实收场了（没有挂着不落定的 await）
    assert.equal(typeof (await t.orch.runs.get(run.id).done), "object");
  } finally {
    await t.cleanup();
  }
});

await test("超时终态：settled=false 的回合标 reconciliation_required，不假装 completed", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "TimeoutProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [{ kind: "timeout", settled: false }];
    const run = t.orch.startRun({ botId: bot.id, text: "慢回合" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "reconciliation_required");
    assert.equal(done.recovery.reason, "timeout_killed");
    assert.match(done.error, /回合超时/);
  } finally {
    await t.cleanup();
  }
});

await test("steerRun 只在活跃回合可用，且不创建第二并发运行", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "SteerProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [{ kind: "hang" }];
    const run = t.orch.startRun({ botId: bot.id, text: "长回合" });
    await waitFor(() => t.orch.getRun(run.id).state === "running", { label: "进入 running" });
    const out = await t.orch.steerRun(run.id, "改个方向", { behavior: "follow_up" });
    assert.equal(out.id, run.id);
    assert.deepEqual(fake.steered, { text: "改个方向", behavior: "follow_up" });
    assert.equal(t.orch.listRuns({ botId: bot.id }).length, 1);
    await t.orch.cancelRun(run.id);
    await assert.rejects(() => t.orch.steerRun(run.id, "太晚了"), (e) => e.status === 409);
  } finally {
    await t.cleanup();
  }
});

// ---- 4. 委派准入 ----

await test("message_bot 同步投递：同工作区自动，回执带子 Run 与 reply", async () => {
  const t = newTeam();
  try {
    const a = t.orch.addBot({ name: "AlphaTalker" });
    const b = t.orch.addBot({ name: "BetaTalker" });
    const fakeA = await t.orch.runtimeFor(a.id, "private");
    const fakeB = await t.orch.runtimeFor(b.id, "private");
    fakeB.queue = [{ kind: "complete", text: "Beta 的答复" }];
    fakeA.queue = [{ kind: "tool", tool: "message_bot", args: { to: b.name, message: "帮我看看" } }];

    const run = t.orch.startRun({ botId: a.id, text: "去问 Beta", budget: { maxTokens: 100 } });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.match(done.reply, /Beta 的答复/);

    const children = t.orch.listRuns({}).filter((r) => r.parentRunId === run.id);
    assert.equal(children.length, 1);
    assert.equal(children[0].kind, "delegation");
    assert.equal(children[0].depth, 1);
    assert.equal(children[0].botId, b.id);
    assert.deepEqual(children[0].budget, { maxTokens: 100 });
    assert.equal(children[0].state, "completed");
    assert.equal(t.orch.store.state.exchanges[0].status, "replied");
  } finally {
    await t.cleanup();
  }
});

await test("A→B→A 被 busy 准入挡住：目标忙即拒绝，不阻塞等待", async () => {
  const t = newTeam();
  try {
    const a = t.orch.addBot({ name: "LoopA" });
    const b = t.orch.addBot({ name: "LoopB" });
    const fakeA = await t.orch.runtimeFor(a.id, "private");
    const fakeB = await t.orch.runtimeFor(b.id, "private");
    // B 在自己的回合里回头找 A；A 的租约仍被第一层占着 → 必须被拒。
    fakeB.queue = [{ kind: "tool", tool: "message_bot", args: { to: a.name, message: "回头找你" } }];
    fakeA.queue = [{ kind: "tool", tool: "message_bot", args: { to: b.name, message: "先给你" } }];

    const run = t.orch.startRun({ botId: a.id, text: "开始" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    const childRun = t.orch.listRuns({}).find((r) => r.parentRunId === run.id);
    assert.equal(childRun.state, "completed");
    assert.match(childRun.reply, /无法接收消息|正忙/);
    // 被拒的那次投递记成 failed，且拒绝原因指向 A 自己的活跃 scope 租约（证明是活跃父回合挡下的，
    // 而不是父回合结束后才发生的一次调用）
    const exchanges = t.orch.store.state.exchanges;
    assert.equal(exchanges[0].status, "replied");
    const refused = exchanges.find((e) => e.status === "failed");
    assert.equal(refused.to, a.id);
    assert.match(refused.error, /target_busy|已有运行/);
    assert.match(refused.error, new RegExp(`bot:${a.id}:private`));
    // 只有一条子 Run：B→A 没有派生新运行
    assert.equal(t.orch.listRuns({ botId: a.id }).length, 1);
  } finally {
    await t.cleanup();
  }
});

await test("越域与扩权被拒：不同工作区、比父 Run 更强的执行模式都不放行", async () => {
  const t = newTeam();
  try {
    const wsDir = mkdtempSync(join(tmpdir(), "ompbot-ws-"));
    try {
      const outsider = t.orch.addBot({ name: "Outsider", workspace: wsDir });
      const insider = t.orch.addBot({ name: "Insider" });
      const fakeIn = await t.orch.runtimeFor(insider.id, "private");
      fakeIn.queue = [{ kind: "tool", tool: "message_bot", args: { to: outsider.name, message: "给我私有资料" } }];
      const run = t.orch.startRun({ botId: insider.id, text: "越域试试" });
      const done = await t.orch.waitRun(run.id);
      assert.equal(done.state, "completed");
      // 断言在宿主工具层：拒绝返回给父回合的 host tool result，而不是模型最后那句话
      assert.equal(fakeIn.lastToolResult.isError, true);
      assert.match(fakeIn.lastToolResult.text, /跨工作区/);
      assert.equal(t.orch.listRuns({}).some((r) => r.parentRunId === run.id), false);
      // 越域在准入阶段就被拒，不产生投递记录
      assert.equal(t.orch.store.state.exchanges.length, 0);

      // 扩权：父 Run 是 supervised，目标 bot 是 full → 拒绝
      const wide = t.orch.addBot({
        name: "WideBot",
        executionMode: "full",
        confirmExecutionMode: true,
        approvalMode: "yolo",
        confirmApprovalMode: true,
      });
      assert.equal(wide.executionMode, "full");
      fakeIn.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: wide.name, message: "扩权派活" } }];
      const run2 = t.orch.startRun({ botId: insider.id, text: "扩权试试" });
      const done2 = await t.orch.waitRun(run2.id);
      assert.equal(done2.state, "completed");
      assert.equal(fakeIn.lastToolResult.isError, true);
      assert.match(fakeIn.lastToolResult.text, /不得扩权/);
      assert.match(fakeIn.lastToolResult.text, /WideBot/);
      assert.equal(t.orch.listRuns({}).some((r) => r.parentRunId === run2.id), false);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  } finally {
    await t.cleanup();
  }
});

await test("delegate_bot 非阻塞派活：立即返回子 Run id，子 Run 可观察", async () => {
  const t = newTeam();
  try {
    const a = t.orch.addBot({ name: "DelegatorA" });
    const b = t.orch.addBot({ name: "DelegatorB" });
    const fakeA = await t.orch.runtimeFor(a.id, "private");
    const fakeB = await t.orch.runtimeFor(b.id, "private");
    fakeB.queue = [{ kind: "complete", text: "后台做完了" }];
    fakeA.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "后台任务" } }];

    const run = t.orch.startRun({ botId: a.id, text: "派活" });
    const done = await t.orch.waitRun(run.id);
    const child = t.orch.listRuns({}).find((r) => r.parentRunId === run.id);
    assert.equal(child.botId, b.id);
    assert.match(done.reply, new RegExp(child.id));
    assert.equal(t.events.some((e) => e.type === "delegation_accepted" && e.runId === child.id), true);
    const childDone = await t.orch.waitRun(child.id);
    assert.equal(childDone.reply, "后台做完了");
  } finally {
    await t.cleanup();
  }
});

// ---- 5. 预算与并发（真实额度）----

await test("Bot 预算耗尽：回合后按真实原生用量核对额度，走取消路径而不是 completed", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "BudgetBot", budget: { maxTokens: 5 } });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    // 夹具用量：total 15 tokens > 额度 5
    const run = t.orch.startRun({ botId: bot.id, text: "烧额度" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "cancelled");
    assert.match(done.error, /预算耗尽：token 用量 15 超出额度 5/);
    assert.equal(fake.calls.length, 1);

    // 额度已花完：再派发在 spawn 之前就被拒（不落新 Run）
    assert.throws(
      () => t.orch.startRun({ botId: bot.id, text: "再来一次" }),
      (e) => e.status === 409 && e.code === "budget_exhausted",
    );
    assert.equal(t.orch.listRuns({ botId: bot.id }).length, 1);
  } finally {
    await t.cleanup();
  }
});

await test("预算可派发额度已扣已花：子 Run 拿不到父 Run 用过的份额度", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "BudgetBot2", budget: { maxTokens: 1000 } });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    const first = t.orch.startRun({ botId: bot.id, text: "第一次", budget: { maxTokens: 100 } });
    assert.equal(first.budget.maxTokens, 100);
    await t.orch.waitRun(first.id);

    // 已花 15（夹具用量）→ 第二次只剩 85
    const second = t.orch.startRun({ botId: bot.id, text: "第二次", budget: { maxTokens: 100 } });
    assert.equal(second.budget.maxTokens, 85);
    await t.orch.waitRun(second.id);

    // 零额度直接拒绝
    const zeroBot = t.orch.addBot({ name: "ZeroBudget", budget: { maxTokens: 0 } });
    assert.throws(
      () => t.orch.startRun({ botId: zeroBot.id, text: "零额度" }),
      (e) => e.status === 409 && e.code === "budget_exhausted",
    );

    // 时间额度上限会收窄运行超时（原生 --max-time 也用同一个值）
    const timed = t.orch.startRun({ botId: bot.id, text: "时间额度", budget: { maxTimeMs: 5000, maxTokens: 1000 } });
    assert.equal(timed.budget.maxTimeMs, 5000);
    assert.equal((await t.orch.waitRun(timed.id)).state, "completed");
    assert.equal(fake.calls.length, 3);
  } finally {
    await t.cleanup();
  }
});

await test("全局并发上限：子 Run 派发超过上限被拒（用户直接发起不受限）", async () => {
  const t = newTeam({ maxConcurrency: 1 });
  try {
    const a = t.orch.addBot({ name: "ConcA" });
    const b = t.orch.addBot({ name: "ConcB" });
    const fakeA = await t.orch.runtimeFor(a.id, "private");
    const fakeB = await t.orch.runtimeFor(b.id, "private");
    fakeB.queue = [{ kind: "complete", text: "不该跑到这里" }];
    fakeA.queue = [{ kind: "tool", tool: "delegate_bot", args: { to: b.name, message: "派活" } }];

    const run = t.orch.startRun({ botId: a.id, text: "自己发起不受限" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.match(done.reply, /并发已达上限/);
    assert.equal(t.orch.listRuns({}).some((r) => r.parentRunId === run.id), false);
    assert.equal(fakeB.calls.length, 0);
  } finally {
    await t.cleanup();
  }
});

await test("父 Run 额度按已花费递减派发：三跳子 Run 拿到 40/25/10，第四跳被拒", async () => {
  const t = newTeam();
  try {
    const names = ["ReserveA", "ReserveB", "ReserveC", "ReserveD", "ReserveE"];
    const bots = names.map((name) => t.orch.addBot({ name }));
    for (const b of bots) await t.orch.runtimeFor(b.id, "private");
    const fakeA = t.fake(bots[0].id);
    const hops = bots.slice(1).map((b, i) => ({ tool: "message_bot", args: { to: b.name, message: `第${i + 1}跳` } }));
    fakeA.queue = [{ kind: "toolx", calls: hops }];

    const run = t.orch.startRun({ botId: bots[0].id, text: "连派四跳", budget: { maxTokens: 40 } });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    // listRuns 按 created_at DESC/rowid DESC 返回，反转即创建顺序（同毫秒也稳定）
    const children = t.orch
      .listRuns({})
      .filter((r) => r.parentRunId === run.id)
      .reverse();
    // 每跳花 15：额度只剩多少就只派多少，并行/连续子 Run 不能重复用同一份
    assert.deepEqual(children.map((r) => r.budget.maxTokens), [40, 25, 10]);
    assert.match(done.reply, /预算耗尽/);
  } finally {
    await t.cleanup();
  }
});

await test("并行子 Run 不能复用同一份额度：在飞预留占住父 Run 的额度", async () => {
  const t = newTeam();
  try {
    const a = t.orch.addBot({ name: "ParA" });
    const b = t.orch.addBot({ name: "ParB" });
    const c = t.orch.addBot({ name: "ParC" });
    for (const bot of [a, b, c]) await t.orch.runtimeFor(bot.id, "private");
    const fakeA = t.fake(a.id);
    // 两个非阻塞派活同时发出：第一个占满预留，第二个必须被拒（不能各自拿 40）
    fakeA.queue = [
      {
        kind: "toolx",
        calls: [
          { tool: "delegate_bot", args: { to: b.name, message: "并行一" } },
          { tool: "delegate_bot", args: { to: c.name, message: "并行二" } },
        ],
      },
    ];
    const run = t.orch.startRun({ botId: a.id, text: "并行派活", budget: { maxTokens: 40 } });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.match(done.reply, /预算耗尽/);
    const children = t.orch.listRuns({}).filter((r) => r.parentRunId === run.id);
    assert.equal(children.length, 1);
    assert.equal(children[0].budget.maxTokens, 40);
    // 子 Run 落定后预留释放：父 Run 的额度重新可用（同一 Bot 的下一条运行）
    assert.equal(t.orch.runs.get(run.id).reservation, null);
  } finally {
    await t.cleanup();
  }
});

await test("预算无法核对时失败关闭：不报 completed，额度未知的父 Run 拒绝派发", async () => {
  const t = newTeam();
  try {
    const budgeted = t.orch.addBot({ name: "UnverA", budget: { maxTokens: 500 } });
    const plainBot = t.orch.addBot({ name: "UnverB" });
    const fakeA = await t.orch.runtimeFor(budgeted.id, "private");
    const fakeB = await t.orch.runtimeFor(plainBot.id, "private");

    // 带预算 + 用量读不到 → 未确认，不报 completed
    fakeA.stats = null;
    const run = t.orch.startRun({ botId: budgeted.id, text: "读不到用量" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "reconciliation_required");
    assert.equal(done.recovery.reason, "usage_unavailable");
    assert.equal(t.events.some((e) => e.type === "usage_unavailable" && e.runId === run.id), true);

    // 没预算的 Run 不受影响
    fakeB.stats = null;
    const plain = t.orch.startRun({ botId: plainBot.id, text: "没有预算" });
    assert.equal((await t.orch.waitRun(plain.id)).state, "completed");

    // 活着的父 Run（有预算）用量未知 → 子派发在准入阶段就被拒
    fakeA.queue = [{ kind: "hang" }];
    const live = t.orch.startRun({ botId: budgeted.id, text: "活着" });
    await waitFor(() => t.orch.getRun(live.id).state === "running", { label: "父 Run 进入 running" });
    t.orch.runs.get(live.id).usageUnknown = true;
    assert.throws(
      () => t.orch.startRun({ botId: plainBot.id, text: "子", parentRunId: live.id, depth: 1 }),
      (e) => e.status === 409 && e.code === "budget_unverifiable",
    );
    await t.orch.cancelRun(live.id);
  } finally {
    await t.cleanup();
  }
});

await test("native_event 投影：物理分块不入账、凭据脱敏、超限帧只留摘要", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "FrameProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    const big = "x".repeat(40_000);
    fake.queue = [
      {
        kind: "frames",
        frames: [
          { type: "rpc_chunk", chunkId: "c1", index: 0, count: 1, data: "QUFBQQ==", byteLength: 4 },
          { type: "response", id: "req1", data: { apiKey: "sk-live-placeholder", model: "m" } },
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } },
          {
            type: "message_update",
            usage: { tokens: { totalTokens: 321, cacheRead: 7 }, contextTokens: 45, cost: 0.002 },
            apiKey: "sk-should-be-redacted",
            authorization: "Bearer should-be-redacted",
          },
          { type: "tool_result", content: big },
        ],
      },
    ];
    const run = t.orch.startRun({ botId: bot.id, text: "发帧" });
    await t.orch.waitRun(run.id);
    const native = t.events.filter((e) => e.type === "native_event");
    assert.equal(native.some((e) => e.event.type === "rpc_chunk"), false);
    const resp = native.find((e) => e.event.type === "response");
    assert.equal(resp.event.data.apiKey, "[redacted]");
    assert.equal(resp.event.data.model, "m");
    assert.equal(resp.runId, run.id);
    const delta = native.find((e) => e.event.type === "message_update");
    assert.equal(delta.event.assistantMessageEvent.delta, "你好");
    // 用量统计必须保留真实数字（早期版本把 tokens 也误标成 [redacted]）
    const stats = native.find((e) => e.event.type === "message_update" && e.event.usage);
    assert.equal(stats.event.usage.tokens.totalTokens, 321);
    assert.equal(stats.event.usage.tokens.cacheRead, 7);
    assert.equal(stats.event.usage.contextTokens, 45);
    assert.equal(stats.event.usage.cost, 0.002);
    assert.equal(stats.event.apiKey, "[redacted]");
    assert.equal(stats.event.authorization, "[redacted]");
    const tool = native.find((e) => e.event.type === "tool_result");
    assert.equal(tool.event.truncated, true);
    assert.equal(tool.event.bytes > 32768, true);
  } finally {
    await t.cleanup();
  }
});

await test("chat 档的工具面：只注册受控宿主工具，原生命令一律拒绝", async () => {
  const home = mkdtempSync(join(tmpdir(), "ompbot-chat-"));
  let orch;
  try {
    const features = {
      handleRequest: async () => false,
      start: async () => {},
      close: async () => {},
      preparePrompt: async (run) => ({ text: run.text }),
      collectArtifacts: async () => [],
      hostTools: () => [
        {
          name: "read_doc",
          label: "Read Doc",
          description: "受控读取授权资料",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          handler: async () => ({ text: "bounded" }),
        },
      ],
    };
    orch = new Orchestrator({
      home,
      bin: "omp-fixture",
      features,
      runtimeFactory: (o) => new FakeRuntime(o),
    });
    const chat = orch.addBot({ name: "ChatOnly", executionMode: "chat" });
    const sup = orch.addBot({ name: "SupBot", executionMode: "supervised" });
    const chatRt = await orch.runtimeFor(chat.id, "private");
    const supRt = await orch.runtimeFor(sup.id, "private");

    // chat：没有 message_bot/delegate_bot 这类执行型团队工具，只有受控宿主工具与只读名册
    assert.deepEqual(
      chatRt.tools.map((t) => t.name).sort(),
      ["list_bots", "read_doc"].sort(),
    );
    assert.equal(chatRt.tools.some((t) => t.name === "message_bot"), false);
    assert.equal(chatRt.tools.some((t) => t.name === "delegate_bot"), false);
    // supervised：保留委派能力
    assert.deepEqual(
      supRt.tools.map((t) => t.name).sort(),
      ["delegate_bot", "list_bots", "message_bot", "read_doc"].sort(),
    );
    // 任何档位都不能用原生命令绕过白名单拿执行能力
    await assert.rejects(() => orch.nativeCommand(chat.id, "bash"), (e) => e.status === 403);
    await assert.rejects(() => orch.nativeCommand(chat.id, "eval"), (e) => e.status === 403);
    // 工具面对外披露为「未验证」，避免界面宣称安全聊天模式
    const state = await orch.getNativeState(chat.id);
    assert.equal(state.toolSurface.restricted, true);
    assert.equal(state.toolSurface.nativeVerification, "unverified");
    assert.equal((await orch.getNativeState(sup.id)).toolSurface.restricted, false);
  } finally {
    try {
      await orch?.shutdown();
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

await test("预算入口校验：标量/数组/NaN/负数/Infinity/未知键都显式拒绝，不静默当无限制", async () => {
  const t = newTeam();
  try {
    const badBudgets = [
      9,
      [1],
      { maxTokens: Number.NaN },
      { maxTokens: -1 },
      { maxTokens: Number.POSITIVE_INFINITY },
      { maxTokens: "10" },
      { unknown: 5 },
    ];
    for (const [i, budget] of badBudgets.entries()) {
      assert.throws(
        () => t.orch.addBot({ name: `BadShape${i}`, budget }),
        (e) => e.status === 400 && e.code === "budget_invalid",
      );
    }
    const bot = t.orch.addBot({ name: "GoodShape", budget: { maxTokens: 100 } });
    assert.deepEqual(bot.budget, { maxTokens: 100 });

    // 运行入口同样严格：非法预算直接拒绝，且不留下 Run 记录
    for (const budget of badBudgets) {
      assert.throws(
        () => t.orch.startRun({ botId: bot.id, text: "x", budget }),
        (e) => e.status === 400 && e.code === "budget_invalid",
      );
    }
    assert.equal(t.orch.listRuns({ botId: bot.id }).length, 0);
    assert.throws(() => t.orch.updateBot(bot.id, { budget: 9 }), (e) => e.code === "budget_invalid");
    assert.deepEqual(t.orch.getBot(bot.id).budget, { maxTokens: 100 });

    // 旧记录里的标量预算：不当成无限制，运行入口显式拒绝
    const legacy = t.orch.addBot({ name: "LegacyScalar" });
    t.orch.store.putBot({ ...t.orch.store.getBot(legacy.id), budget: 9 });
    const loaded = t.orch.getBot(legacy.id);
    assert.equal(loaded.budget, null);
    assert.equal(typeof loaded.budgetInvalid, "string");
    assert.throws(
      () => t.orch.startRun({ botId: legacy.id, text: "x" }),
      (e) => e.status === 400 && e.code === "budget_invalid",
    );
    assert.equal(t.orch.listRuns({ botId: legacy.id }).length, 0);
    assert.equal(t.orch.getBot(bot.id).budget.maxTokens, 100);
  } finally {
    await t.cleanup();
  }
});

await test("chat 工具面判定：受控宿主工具通过，MCP/内置/未知工具即越界", async () => {
  const host = ["read_workspace_file", "list_workspace", "fetch_public_url"];
  const clean = evaluateToolSurface([...host, "ask"], host);
  assert.equal(clean.verified, true);
  assert.deepEqual(clean.violations, []);

  const leaky = evaluateToolSurface([...host, "ask", "mcp__qa_canary"], host);
  assert.equal(leaky.verified, false);
  assert.deepEqual(leaky.violations, ["mcp__qa_canary"]);

  const builtins = evaluateToolSurface(["bash", "eval", "write"], host);
  assert.equal(builtins.verified, false);
  assert.deepEqual(builtins.violations, ["bash", "eval", "write"]);

  const unknown = evaluateToolSurface(null, host);
  assert.equal(unknown.verified, false);
  assert.equal(unknown.reported, null);
});

await test("chat 工具面越界：runtime 上报 runtime_blocked，状态面标 failed 并给出越界工具", async () => {
  const home = mkdtempSync(join(tmpdir(), "ompbot-blocked-"));
  let orch;
  try {
    const events = [];
    orch = new Orchestrator({
      home,
      bin: "omp-fixture",
      features: stubFeatures(),
      runtimeFactory: (o) => new FakeRuntime(o),
      onEvent: (e) => events.push(e),
    });
    const chat = orch.addBot({ name: "BlockedChat", executionMode: "chat" });
    const rt = await orch.runtimeFor(chat.id, "private");
    rt.toolSurface = { verified: false, reported: ["mcp__qa_canary"], violations: ["mcp__qa_canary"] };
    rt.blocked = {
      reason: "unsafe_tool_surface",
      detail: "chat 档出现未受控工具：mcp__qa_canary",
      tools: ["mcp__qa_canary"],
    };
    rt.emit("tool_surface_blocked", rt.blocked);

    const blockedEvent = events.find((e) => e.type === "runtime_blocked");
    assert.equal(blockedEvent.botId, chat.id);
    assert.deepEqual(blockedEvent.tools, ["mcp__qa_canary"]);
    assert.equal(blockedEvent.reason, "unsafe_tool_surface");

    const state = await orch.getNativeState(chat.id);
    assert.equal(state.toolSurface.restricted, true);
    assert.equal(state.toolSurface.nativeVerification, "failed");
    assert.deepEqual(state.toolSurface.violations, ["mcp__qa_canary"]);
    assert.equal(state.blocked.reason, "unsafe_tool_surface");
    assert.equal(state.sandbox, false);
  } finally {
    try {
      await orch?.shutdown();
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

await test("群回合不能绕过成员自己已用完的额度", async () => {
  const t = newTeam();
  try {
    const rich = t.orch.addBot({ name: "RichAdmin" });
    const poor = t.orch.addBot({ name: "PoorMate", budget: { maxTokens: 5 } });
    const room = t.orch.createRoom({ name: "预算组", members: [rich.id, poor.id], mode: "everyone" });
    const fakeRich = await t.orch.runtimeFor(rich.id, `room:${room.id}`);
    const fakePoor = await t.orch.runtimeFor(poor.id, `room:${room.id}`);

    // 先让 poor 的额度在自己的回合里花完（夹具用量 15 > 额度 5）
    const poorPrivate = await t.orch.runtimeFor(poor.id, "private");
    poorPrivate.queue = [{ kind: "complete", text: "烧额度" }];
    const exhausted = t.orch.startRun({ botId: poor.id, text: "烧额度" });
    assert.equal((await t.orch.waitRun(exhausted.id)).state, "cancelled");

    fakeRich.queue = [{ kind: "complete", text: "admin 说" }];
    fakePoor.queue = [{ kind: "complete", text: "不该跑到这里" }];
    const spoken = await t.orch.postToRoom(room.id, "开会", { userName: "Tester" });
    assert.deepEqual(
      spoken.map((s) => [s.name, s.passed]),
      [
        ["RichAdmin", false],
        ["PoorMate", true],
      ],
    );
    // poor 的 room 作用域 runtime 根本没发起过原生调用
    assert.equal(fakePoor.calls.length, 0);
    const err = t.events.find((e) => e.type === "room_turn_error");
    assert.match(err.error, /预算耗尽/);
  } finally {
    await t.cleanup();
  }
});

await test("展示类 UI 状态帧不产生审批/不占 TTL/不改 Run 状态，真 select 仍要求输入", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "StatusProbe" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [
      {
        kind: "frames",
        text: "status-only",
        frames: [
          { type: "extension_ui_request", id: "ui_s1", method: "setStatus", text: "working" },
          { type: "extension_ui_request", id: "ui_s2", method: "notify", message: "hi" },
          { type: "extension_ui_request", id: "ui_s3", method: "setTitle", title: "t" },
        ],
      },
    ];
    const run = t.orch.startRun({ botId: bot.id, text: "只发状态" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.equal(done.reply, "status-only");
    assert.deepEqual(t.orch.ledger.list("approvals"), []);
    assert.equal(t.events.some((e) => e.type === "ui_request"), false);
    assert.equal(t.events.filter((e) => e.type === "ui_status").length, 3);
    assert.equal(
      t.events.some((e) => e.type === "run_updated" && e.run.state === "waiting_approval"),
      false,
    );
    assert.equal(t.orch._uiTimers.size, 0);
    // 展示帧仍按原生帧透传，界面能看到状态内容
    assert.equal(
      t.events.some((e) => e.type === "native_event" && e.event.method === "setStatus"),
      true,
    );

    // 展示帧之后，真正的 select 仍然会暂停并要求输入
    fake.queue = [
      {
        kind: "ui",
        frame: { type: "extension_ui_request", id: "ui_sel", method: "select", options: ["A", "B"] },
      },
    ];
    const run2 = t.orch.startRun({ botId: bot.id, text: "真审批" });
    const approval = await waitFor(() => t.orch.ledger.list("approvals")[0], { label: "审批记录" });
    assert.equal(approval.method, "select");
    assert.equal(t.orch.getRun(run2.id).state, "waiting_approval");
    await t.orch.answerUi(approval.id, { value: "A" });
    assert.equal((await t.orch.waitRun(run2.id)).state, "completed");
    assert.equal(t.orch._uiTimers.size, 0);
  } finally {
    await t.cleanup();
  }
});

await test("公开重启入口：空闲时真停旧进程再重建；忙时不打断也不谎报已重启", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "ReloadProbe" });
    const idleRt = await t.orch.runtimeFor(bot.id, "private");
    assert.equal(t.orch.botRuntimeBusy(bot.id), false);

    const clean = await t.orch.restartBotRuntimes(bot.id, { reason: "mcp-config" });
    assert.deepEqual(clean, { restarted: true, blocked: null });
    assert.equal(idleRt.state, "stopped");
    assert.equal(t.events.some((e) => e.type === "bot_restart_requested" && e.reason === "mcp-config"), true);
    const fresh = await t.orch.runtimeFor(bot.id, "private");
    assert.notEqual(fresh, idleRt);

    // 活跃回合：等不到空闲 → 不打断、不谎报，标记待重建
    fresh.queue = [{ kind: "hang" }];
    const run = t.orch.startRun({ botId: bot.id, text: "长回合" });
    await waitFor(() => t.orch.getRun(run.id).state === "running", { label: "进入 running" });
    assert.equal(t.orch.botRuntimeBusy(bot.id), true);
    const blocked = await t.orch.restartBotRuntimes(bot.id, { reason: "mcp-config" });
    assert.equal(blocked.restarted, false);
    assert.deepEqual(blocked.blocked.scopes, [{ scope: "private", busy: true }]);
    assert.equal(fresh.busy, true); // 进行中的回合没有被打断
    assert.equal(t.events.some((e) => e.type === "bot_restart_blocked"), true);

    // 回合结束后，下一次取用会因待重建标记真的换进程（配置变更没有被静默丢掉）
    await t.orch.cancelRun(run.id);
    const after = await t.orch.runtimeFor(bot.id, "private");
    assert.notEqual(after, fresh);
    assert.equal(
      t.events.some((e) => e.type === "runtime_rebuilt" && e.reason === "mcp-config"),
      true,
    );
  } finally {
    await t.cleanup();
  }
});

await test("准入竞态：startRun 已预留但进程还没起时 botRuntimeBusy 必须为真（特性层不得改配置）", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "RaceProbe" });
    const rt = await t.orch.runtimeFor(bot.id, "private");
    rt.queue = [{ kind: "hang" }];
    assert.equal(t.orch.botRuntimeBusy(bot.id), false);

    // 关键窗口：startRun 同步返回（租约已预留），此时 rt.busy 仍为 false。
    const run = t.orch.startRun({ botId: bot.id, text: "抢跑" });
    assert.equal(run.state, "starting");
    assert.equal(rt.busy, false, "进程还没把 busy 立起来——这正是被漏掉的窗口");
    assert.equal(t.orch.botRuntimeBusy(bot.id), true, "已准入的 Run 必须算忙");

    // 真跑起来之后依然为真（回合内）。
    await waitFor(() => rt.busy === true, { label: "进入 busy" });
    assert.equal(t.orch.botRuntimeBusy(bot.id), true);

    // 另一条链必须被拒（准入本身没被放宽）。
    assert.throws(
      () => t.orch.startRun({ botId: bot.id, text: "并发" }),
      (e) => e.status === 409 && e.code === "target_busy",
    );

    await t.orch.cancelRun(run.id);
    await waitFor(() => t.orch.botRuntimeBusy(bot.id) === false, { label: "回落到空闲" });
    assert.equal(rt.busy, false);
  } finally {
    await t.cleanup();
  }
});

await test("用量模型标识：原生解析模型写进 run.stats 与账本分组（不再靠 Bot.model 冒充）", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "ModelProbe", model: "configured/not-truth" });
    const run = t.orch.startRun({ botId: bot.id, text: "记用量" });
    const done = await t.orch.waitRun(run.id);
    assert.equal(done.state, "completed");
    assert.equal(done.stats.model, "fixture/provider-model");
    assert.equal(done.stats.provider, "fixture");
    assert.equal(done.stats.delta.totalTokens, 15);
    const usage = t.orch.ledger.usage();
    assert.deepEqual(
      usage.perRun.map((r) => [r.runId, r.model, r.totalTokens]),
      [[run.id, "fixture/provider-model", 15]],
    );
  } finally {
    await t.cleanup();
  }
});

await test("规范模型标识：字符串/对象两种原生形状都归一为 provider/id", async () => {
  assert.deepEqual(
    canonicalNativeModel({ model: { id: "commandcode-plan/deepseek/deepseek-v4.1-flash", provider: "magpie" } }),
    { model: "magpie/commandcode-plan/deepseek/deepseek-v4.1-flash", provider: "magpie" },
  );
  assert.deepEqual(
    canonicalNativeModel({ model: "commandcode-plan/deepseek/deepseek-v4.1-flash", provider: "magpie" }),
    { model: "magpie/commandcode-plan/deepseek/deepseek-v4.1-flash", provider: "magpie" },
  );
  assert.deepEqual(canonicalNativeModel({ model: "magpie/x/y" }), { model: "magpie/x/y", provider: null });
  assert.deepEqual(canonicalNativeModel({ model: { id: "x/y" } }), { model: "x/y", provider: null });
  assert.equal(canonicalNativeModel({}), null);
  assert.equal(canonicalNativeModel(null), null);
});

// ---- 6. 策略、暂停、校验 ----

await test("策略签名变化重建 runtime（旧进程先停，新进程再起）", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "PolicyProbe", model: "m1" });
    const first = await t.orch.runtimeFor(bot.id, "private");
    first.policyOk = false; // 模拟策略签名不再匹配
    const second = await t.orch.runtimeFor(bot.id, "private");
    assert.notEqual(second, first);
    assert.equal(first.state, "stopped");
    assert.equal(t.events.some((e) => e.type === "runtime_rebuilt"), true);
  } finally {
    await t.cleanup();
  }
});

await test("updateBot：策略字段变更触发重建事件，运行中的 Run 不会被偷偷换策略", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "UpdateProbe", model: "m1" });
    const fake = await t.orch.runtimeFor(bot.id, "private");
    fake.queue = [{ kind: "hang" }];
    const run = t.orch.startRun({ botId: bot.id, text: "长回合" });
    await waitFor(() => t.orch.getRun(run.id).state === "running", { label: "进入 running" });

    const restarted = new Promise((resolve) => {
      const onEvent = (e) => {
        if (e.type === "bot_restarted" || e.type === "bot_restart_blocked") resolve(e.type);
      };
      t.orch.onEvent = (e) => {
        t.events.push(e);
        onEvent(e);
      };
    });
    const updated = t.orch.updateBot(bot.id, { model: "m2" });
    assert.equal(updated.model, "m2");
    assert.equal(t.orch.getBot(bot.id).model, "m2");
    const changed = t.events.find((e) => e.type === "bot_policy_changed");
    assert.deepEqual(changed.activeRuns, [run.id]);
    assert.equal(changed.pendingRestart, true);

    await t.orch.cancelRun(run.id);
    const kind = await Promise.race([restarted, delay(3000).then(() => "timeout")]);
    assert.notEqual(kind, "timeout");
  } finally {
    await t.cleanup();
  }
});

await test("人工接管暂停闸门：isPaused 时 startRun/runtimeFor 均 409 bot_paused", async () => {
  const home = mkdtempSync(join(tmpdir(), "ompbot-runs-"));
  let orch;
  try {
    const botIdHolder = { paused: false };
    orch = new Orchestrator({
      home,
      bin: "omp-fixture",
      runtimeFactory: (opts) => new FakeRuntime(opts),
      features: stubFeatures({ isPaused: () => botIdHolder.paused }),
    });
    const bot = orch.addBot({ name: "PauseProbe" });
    botIdHolder.paused = true;
    assert.throws(
      () => orch.startRun({ botId: bot.id, text: "暂停中" }),
      (e) => e.status === 409 && e.code === "bot_paused",
    );
    await assert.rejects(
      () => orch.runtimeFor(bot.id, "private"),
      (e) => e.status === 409 && e.code === "bot_paused",
    );
    botIdHolder.paused = false;
    const run = orch.startRun({ botId: bot.id, text: "恢复" });
    assert.equal((await orch.waitRun(run.id)).state, "completed");
  } finally {
    try {
      await orch?.shutdown();
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

await test("策略与记忆前置校验：sandbox 被拒、全部放手需显式确认、记忆需原生 profile", async () => {
  const t = newTeam();
  try {
    assert.throws(
      () => t.orch.addBot({ name: "Sandboxer", executionMode: "sandbox" }),
      (e) => e.status === 400 && e.code === "sandbox_unverified",
    );
    // full 加 write 归到先问我，不是安全降级，不用确认
    assert.equal(t.orch.addBot({ name: "Fuller", executionMode: "full" }).executionMode, "supervised");
    assert.throws(
      () => t.orch.addBot({ name: "Yoloer", approvalMode: "yolo" }),
      (e) => e.status === 400 && e.code === "confirm_permission_required",
    );
    // 记忆开关按真实前置判定：显式选定 keyless 模型（auth:none + loopback）才放行，
    // 其余一律拒绝（失败关闭），绝不用「有 broker URL」这种假缝当授权。
    const keyless = "magpie/workbuddy-ai/deepseek-v4.1-flash";
    const globalModels = join(homedir(), ".omp", "agent", "models.yml");
    if (existsSync(globalModels)) {
      const prereq = memoryPrereqStatus({ model: keyless, agentDir: join(t.home, "bots", "bot_memory_probe", "private", "agent") });
      assert.equal(prereq.ready, true, `本机 magpie keyless 应判定可用：${prereq.reason}`);
      assert.equal(prereq.source, "native-keyless-loopback");
      assert.equal(prereq.loopback, true);
      assert.equal(prereq.auth, "none");

      const allowed = t.orch.addBot({ name: "Memor", model: keyless, memoryEnabled: true });
      assert.equal(allowed.memoryEnabled, true);
      assert.equal(t.orch.updateBot(allowed.id, { memoryEnabled: true }).memoryEnabled, true);
      // 记忆开启的 bot 改模型也要过前置：不能存下私有目录里没有定义的模型。
      assert.throws(
        () => t.orch.updateBot(allowed.id, { model: "cpa/gemini-3-flash" }),
        (e) => e.status === 409 && e.code === "memory_prereq_missing",
      );
      assert.equal(t.orch.updateBot(allowed.id, { model: "magpie/opencode-go/deepseek-v4.1-flash:max" }).model, "magpie/opencode-go/deepseek-v4.1-flash:max");
      // 未开记忆的 bot 改模型不受该关影响（后端仍由用户全局配置决定）。
      const noMem = t.orch.addBot({ name: "NoMemModel" });
      assert.equal(t.orch.updateBot(noMem.id, { model: "cpa/gemini-3-flash" }).model, "cpa/gemini-3-flash");
      // 没选定模型（空）绝不放行：不能靠 loopback 或 broker URL 推断 keyless。
      assert.throws(
        () => t.orch.addBot({ name: "NoModel", memoryEnabled: true }),
        (e) => e.status === 409 && e.code === "memory_prereq_missing",
      );
      // 非 keyless 的 provider（全局 cpa 需要 apiKey）必须拒绝。
      assert.throws(
        () => t.orch.addBot({ name: "CPA", model: "cpa/gemini-3-flash", memoryEnabled: true }),
        (e) => e.status === 409 && e.code === "memory_prereq_missing",
      );
      // 不存在的 provider/模型也要拒绝，不静默降级到别的 provider。
      assert.throws(
        () => t.orch.addBot({ name: "Ghost", model: "nope/nope-model", memoryEnabled: true }),
        (e) => e.status === 409 && e.code === "memory_prereq_missing",
      );
    } else {
      assert.equal(memoryPrereqStatus({ model: keyless }).ready, false);
      assert.throws(
        () => t.orch.addBot({ name: "Memor", model: keyless, memoryEnabled: true }),
        (e) => e.status === 409 && e.code === "memory_prereq_missing",
      );
    }

    const legit = t.orch.addBot({
      name: "Legit",
      executionMode: "full",
      confirmExecutionMode: true,
      approvalMode: "yolo",
      confirmApprovalMode: true,
      skills: ["git-*"],
      budget: { maxTokens: 500 },
    });
    assert.equal(legit.executionMode, "full");
    assert.equal(legit.approvalMode, "yolo");
    assert.deepEqual(legit.skills, ["git-*"]);
    // 全部放手只对应 full 加 yolo：退回 write 就整体落到先问我
    assert.equal(t.orch.updateBot(legit.id, { approvalMode: "write" }).approvalMode, "write");
    assert.equal(t.orch.getBot(legit.id).executionMode, "supervised");
    assert.throws(
      () => t.orch.updateBot(legit.id, { approvalMode: "yolo" }),
      (e) => e.code === "confirm_permission_required",
    );
    assert.equal(t.orch.updateBot(legit.id, { approvalMode: "yolo", confirmApprovalMode: true }).executionMode, "full");
    assert.equal(t.orch.updateBot(legit.id, { executionMode: "supervised" }).executionMode, "full", "supervised 加 yolo 仍是全部放手");
    assert.equal(t.orch.updateBot(legit.id, { permission: "ask" }).executionMode, "supervised");
    assert.throws(
      () => t.orch.updateBot(legit.id, { permission: "full" }),
      (e) => e.code === "confirm_permission_required",
    );

    assert.throws(
      () => t.orch.updateBot(legit.id, { executionMode: "sandbox" }),
      (e) => e.code === "sandbox_unverified",
    );
    if (!existsSync(globalModels)) {
      assert.throws(
        () => t.orch.updateBot(legit.id, { memoryEnabled: true }),
        (e) => e.code === "memory_prereq_missing",
      );
    }
  } finally {
    await t.cleanup();
  }
});

await test("输入校验与缺失目标：4xx 带 code，未知 run/bot 不假装成功", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "ValidateProbe" });
    assert.throws(() => t.orch.startRun({ botId: bot.id, text: "   " }), (e) => e.status === 400 && e.code === "text_required");
    assert.throws(() => t.orch.startRun({ text: "没有目标" }), (e) => e.status === 400 && e.code === "target_required");
    assert.throws(() => t.orch.startRun({ botId: "bot_missing", text: "x" }), (e) => e.status === 404 && e.code === "bot_not_found");
    assert.throws(() => t.orch.startRun({ roomId: "room_missing", text: "x" }), (e) => e.status === 404 && e.code === "room_not_found");
    assert.throws(() => t.orch.startRun({ botId: bot.id, text: "x", depth: 99 }), (e) => e.code === "depth_exceeded");
    assert.equal(t.orch.getRun("run_nope"), null);
    await assert.rejects(() => t.orch.waitRun("run_nope"), (e) => e.status === 404);
    await assert.rejects(() => t.orch.cancelRun("run_nope"), (e) => e.status === 404);
    await assert.rejects(
      () => t.orch.nativeCommand(bot.id, "bash"),
      (e) => e.status === 403 && e.code === "command_not_allowed",
    );

    const state = await t.orch.getNativeState(bot.id);
    assert.equal(state.started, false);
    assert.equal(state.sandbox, false);
    assert.match(state.sandboxNote, /没有经过验证的 OS 沙箱/);
  } finally {
    await t.cleanup();
  }
});

await test("botWorkDir 与 BotRuntime 的目录规则一致（单一来源）", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "DirProbe" });
    const dirs = t.orch.botWorkDir(bot.id, "private");
    assert.deepEqual(dirs, runtimeDirs(t.home, bot.id, "private"));
    // cwd、私有文件、会话在 team 目录里；persona/overlay 等生成文件留在 <home>/bots/<id>/<scope>
    assert.equal(dirs.cwd, join(t.home, "team", "bots", bot.id));
    assert.equal(dirs.workDir, join(dirs.cwd, "work"));
    assert.equal(dirs.sessionDir, join(dirs.cwd, "sessions", "private"));
    assert.equal(t.orch.botWorkDir(bot.id, "room:r1").sessionDir, join(dirs.cwd, "sessions", "room_r1"));
    assert.equal(t.orch.botWorkDir(bot.id, "room:r1").cwd, dirs.cwd, "私聊群聊共用 cwd");
    assert.equal(dirs.baseDir, join(t.home, "bots", bot.id, "private"));
    assert.equal(dirs.agentDir, join(dirs.baseDir, "agent"));
  } finally {
    await t.cleanup();
  }
});

await test("私有记忆配置：只写选定 provider/模型的非密字段，绝不复制全局 config/auth", () => {
  const home = mkdtempSync(join(tmpdir(), "ompbot-memcfg-"));
  const agentDir = join(home, "bots", "bot_x", "private", "agent");
  const sourceFile = join(home, "source-models.yml");
  // 假凭据由拼接生成：测试只验证「不被复制」，不写入任何真实密钥。
  const FAKE_KEY = ["sk", "test", "not", "real", "credential"].join("-");
  const FAKE_PW = ["user", "not", "real", "pw"].join("-");
  try {
    // 源文件同时含 keyless 段与带凭据段：只有 keyless 段能被复制，凭据段必须整体拒绝。
    writeFileSync(
      sourceFile,
      [
        "providers:",
        "  cpa:",
        "    baseUrl: http://127.0.0.1:8317/v1",
        "    api: openai-completions",
        `    apiKey: ${FAKE_KEY}`,
        "    authHeader: true",
        "    models:",
        "      - id: gemini-3-flash",
        "        name: Gemini",
        "  magpie:",
        "    baseUrl: http://127.0.0.1:3425/v1",
        "    api: openai-completions",
        "    auth: none",
        "    headers:",
        "      User-Agent: omp",
        "    compat:",
        "      promptCacheSessionHeader: x-session-affinity",
        "    models:",
        "      - id: workbuddy-ai/deepseek-v4.1-flash",
        "        name: Deepseek-V4.1-Flash · WorkBuddy AI",
        "        reasoning: true",
        "        thinking:",
        "          mode: effort",
        "          efforts:",
        "            - low",
        "            - max",
        "        contextWindow: 1000000",
        "        maxTokens: 128000",
        "        input:",
        "          - text",
        "          - image",
        "      - id: workbuddy-ai/other",
        "        name: Other",
        "",
      ].join("\n"),
    );

    const status = memoryPrereqStatus({
      model: "magpie/workbuddy-ai/deepseek-v4.1-flash:max",
      agentDir,
      sourceFile,
    });
    assert.equal(status.ready, true, status.reason);
    assert.equal(status.source, "native-keyless-loopback");
    assert.equal(status.provider, "magpie");
    assert.equal(status.modelId, "workbuddy-ai/deepseek-v4.1-flash");
    assert.equal(status.auth, "none");
    assert.equal(status.loopback, true);
    assert.deepEqual(status.roles, {
      default: "magpie/workbuddy-ai/deepseek-v4.1-flash:max",
      smol: "magpie/workbuddy-ai/deepseek-v4.1-flash:max",
      memory: "magpie/workbuddy-ai/deepseek-v4.1-flash:max",
    });
    // 状态面只暴露非密字段，绝不带 apiKey/凭据。
    assert.equal(JSON.stringify(status).includes(FAKE_KEY), false);

    const out = writePrivateMemoryConfig({ agentDir, model: "magpie/workbuddy-ai/deepseek-v4.1-flash:max", sourceFile });
    assert.deepEqual(out.written, ["models.yml"]);
    const text = readFileSync(join(agentDir, "models.yml"), "utf8");
    assert.ok(text.includes("auth: none"));
    assert.ok(text.includes("workbuddy-ai/deepseek-v4.1-flash"));
    assert.ok(!text.includes(FAKE_KEY), "绝不复制凭据");
    assert.ok(!text.includes("cpa"), "绝不复制别的 provider");
    assert.ok(!text.includes("apiKey"), "绝不带 apiKey 字段");
    assert.ok(!text.includes("workbuddy-ai/other"), "只复制选定模型行，不带同 provider 的其它模型");
    assert.ok(!text.includes("gemini-3-flash"));
    // 没有全局 config.yml 的整份复制：私有目录里只有 models.yml 与（若有的）记忆目录。
    assert.deepEqual(readdirSync(agentDir).sort(), ["models.yml"]);
    assert.equal(existsSync(join(agentDir, "config.yml")), false);
    assert.equal(existsSync(join(agentDir, "agent.db")), false);

    // 非 keyless（cpa 带 apiKey）必须失败关闭，且不写文件。
    const cpaStatus = memoryPrereqStatus({ model: "cpa/gemini-3-flash", agentDir: join(home, "agent-cpa"), sourceFile });
    assert.equal(cpaStatus.ready, false);
    assert.match(cpaStatus.reason, /凭据类键|auth: none|loopback/);
    assert.throws(
      () => writePrivateMemoryConfig({ agentDir: join(home, "agent-cpa"), model: "cpa/gemini-3-flash", sourceFile }),
      (e) => e.code === "memory_prereq_missing" && e.status === 409,
    );
    assert.equal(existsSync(join(home, "agent-cpa", "models.yml")), false);

    // 假 broker（只有 URL 没有 token）不是授权。
    const prevUrl = process.env.OMP_AUTH_BROKER_URL;
    const prevToken = process.env.OMP_AUTH_BROKER_TOKEN;
    try {
      process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
      delete process.env.OMP_AUTH_BROKER_TOKEN;
      const fake = memoryPrereqStatus({ model: "cpa/gemini-3-flash", agentDir: join(home, "agent-fake"), sourceFile });
      assert.equal(fake.ready, false, "只有 broker URL 没有 token 绝不能算就绪");
      assert.match(fake.reason, /bearer token|token/);
      // 带 token 的 broker 才算真前置；凭据行被剔除而不是复制（broker 在运行时给凭据）。
      process.env.OMP_AUTH_BROKER_TOKEN = "test-token-not-a-real-credential";
      const real = memoryPrereqStatus({ model: "cpa/gemini-3-flash", agentDir: join(home, "agent-broker"), sourceFile });
      assert.equal(real.ready, true, real.reason);
      assert.equal(real.source, "native-auth-broker");
      assert.deepEqual(real.stripped.sort(), ["apiKey", "authHeader"]);
      writePrivateMemoryConfig({ agentDir: join(home, "agent-broker"), model: "cpa/gemini-3-flash", sourceFile });
      const brokerText = readFileSync(join(home, "agent-broker", "models.yml"), "utf8");
      assert.ok(!brokerText.includes(FAKE_KEY), "broker 路径也绝不复制凭据值");
      assert.ok(!/apiKey|authHeader/.test(brokerText), "broker 路径剔除凭据行");
    } finally {
      if (prevUrl === undefined) delete process.env.OMP_AUTH_BROKER_URL;
      else process.env.OMP_AUTH_BROKER_URL = prevUrl;
      if (prevToken === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
      else process.env.OMP_AUTH_BROKER_TOKEN = prevToken;
    }

    // 安全夹具：flow headers、引号键、被模型级 baseUrl 遮住的带凭据 provider baseUrl 都失败关闭。
    const badFlow = join(home, "bad-flow.yml");
    writeFileSync(badFlow, ["providers:", "  p:", "    baseUrl: http://127.0.0.1:1/v1", "    auth: none", `    headers: {authorization: "Bearer ${FAKE_KEY}"}`, "    models:", "      - id: m", ""].join("\n"));
    const flow = memoryPrereqStatus({ model: "p/m", agentDir: join(home, "agent-flow"), sourceFile: badFlow });
    assert.equal(flow.ready, false);
    assert.match(flow.reason, /flow|锚点/);

    const badQuoted = join(home, "bad-quoted.yml");
    writeFileSync(badQuoted, ["providers:", "  p:", "    baseUrl: http://127.0.0.1:1/v1", "    auth: none", `    "apiKey": "${FAKE_KEY}"`, "    models:", "      - id: m", ""].join("\n"));
    const quoted = memoryPrereqStatus({ model: "p/m", agentDir: join(home, "agent-quoted"), sourceFile: badQuoted });
    assert.equal(quoted.ready, false);
    assert.match(quoted.reason, /引号键|无法识别/);

    const badUserinfo = join(home, "bad-userinfo.yml");
    writeFileSync(badUserinfo, ["providers:", "  p:", `    baseUrl: https://user:${FAKE_PW}@example.com/v1`, "    auth: none", "    models:", "      - id: m", "        baseUrl: http://127.0.0.1:3425/v1", ""].join("\n"));
    const shadowed = memoryPrereqStatus({ model: "p/m", agentDir: join(home, "agent-userinfo"), sourceFile: badUserinfo });
    assert.equal(shadowed.ready, false, "provider 级 baseUrl 带 userinfo 不能因为模型级是 loopback 就放行");
    assert.match(shadowed.reason, /userinfo/);
    assert.equal(JSON.stringify(shadowed).includes(FAKE_PW), false, "状态面不回显凭据");

    // 私有文件已存在且不是本工具生成的（没有生成标记）→ 原样保留，不改写用户文件。
    const userAgent = join(home, "agent-user");
    mkdirSync(userAgent, { recursive: true });
    const userText = "providers:\n  mine:\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n    models:\n      - id: m\n";
    writeFileSync(join(userAgent, "models.yml"), userText);
    const kept = writePrivateMemoryConfig({ agentDir: userAgent, model: "mine/m" });
    assert.deepEqual(kept.written, []);
    assert.equal(kept.preserved.includes("models.yml"), true);
    assert.equal(readFileSync(join(userAgent, "models.yml"), "utf8"), userText);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("记忆运行时隔离：私有 agentDir + 清 profile + 只有私有 models.yml", async () => {
  const home = mkdtempSync(join(tmpdir(), "ompbot-memrun-"));
  const sourceFile = join(home, "models.yml");
  const envKeys = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"];
  const previousEnv = envKeys.map((key) => process.env[key]);
  try {
    process.env.PI_CODING_AGENT_DIR = home;
    delete process.env.OMP_PROFILE;
    delete process.env.PI_PROFILE;
    writeFileSync(
      sourceFile,
      [
        "providers:",
        "  magpie:",
        "    baseUrl: http://127.0.0.1:3425/v1",
        "    api: openai-completions",
        "    auth: none",
        "    models:",
        "      - id: m1",
        "        name: M1",
        "",
      ].join("\n"),
    );
    const rt = new BotRuntime({
      bot: {
        id: "bot_iso", name: "Iso", role: "", instructions: "", model: "magpie/m1", thinking: "",
        isMain: false, executionMode: "supervised", approvalMode: "write", workspace: "",
        memoryEnabled: true, skills: null, budget: null, createdAt: Date.now(),
      },
      scope: "private",
      home,
      bin: "omp-fixture",
    });
    // 私有点位与私有 provider 文件必须真在 Bot 目录内，且不复制全局配置/凭据。
    rt._writePrivateModelConfig();
    assert.equal(existsSync(join(rt.agentDir, "models.yml")), true);
    assert.equal(existsSync(join(rt.agentDir, "config.yml")), false, "绝不复制全局 config.yml");
    const text = readFileSync(join(rt.agentDir, "models.yml"), "utf8");
    assert.ok(text.includes("auth: none"));
    assert.ok(!text.includes("apiKey"));

    // 环境：私有 agentDir + profile 变量被清掉（profile 会把 agentDir 顶回 profiles/<name>/agent）。
    process.env.OMP_PROFILE = "isolation-fixture";
    process.env.PI_PROFILE = "isolation-fixture";
    const env = rt.buildEnv();
    assert.equal(env.PI_CODING_AGENT_DIR, rt.agentDir);
    assert.equal(env.OMP_PROFILE, undefined);
    assert.equal(env.PI_PROFILE, undefined);
    assert.ok(rt.agentDir.startsWith(join(home, "bots", "bot_iso", "private")));

    // 未开记忆的 bot 不带私有 agentDir（保持现状，后端仍由用户全局配置决定）。
    const plain = new BotRuntime({
      bot: { ...rt.bot, id: "bot_plain", memoryEnabled: false, model: "" },
      scope: "private",
      home,
      bin: "omp-fixture",
    });
    const plainEnv = plain.buildEnv();
    assert.equal(plainEnv.PI_CODING_AGENT_DIR, home);
    assert.equal(existsSync(join(plain.agentDir, "models.yml")), false);
  } finally {
    envKeys.forEach((key, i) => {
      if (previousEnv[i] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[i];
    });
    rmSync(home, { recursive: true, force: true });
  }
});

await test("群运行：一个 room Run 承载串行成员回合，保留 PASS 语义", async () => {
  const t = newTeam();
  try {
    const a = t.orch.addBot({ name: "RoomAdmin" });
    const b = t.orch.addBot({ name: "RoomMate" });
    const room = t.orch.createRoom({ name: "讨论组", members: [a.id, b.id], mode: "everyone" });
    const fakeA = await t.orch.runtimeFor(a.id, `room:${room.id}`);
    const fakeB = await t.orch.runtimeFor(b.id, `room:${room.id}`);
    fakeB.queue = [{ kind: "complete", text: "[PASS]" }];
    fakeA.queue = [{ kind: "complete", text: "我先说" }];

    const spoken = await t.orch.postToRoom(room.id, "开会了", { userName: "Tester" });
    assert.deepEqual(spoken.map((s) => s.passed), [false, true]);
    assert.equal(spoken[0].text, "我先说");
    const runs = t.orch.listRuns({ roomId: room.id });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].kind, "room");
    assert.equal(runs[0].state, "completed");
    assert.equal(t.orch.getRoom(room.id).log[0].text, "开会了");
    assert.equal(t.orch.getRoom(room.id).log[0].fromName, "Tester");
    assert.equal(t.orch.getRoom(room.id).log[1].text, "我先说");
  } finally {
    await t.cleanup();
  }
});

await test("会话与原生命令：运行中拒绝、空闲可调用、导出留在 home 内", async () => {
  const t = newTeam();
  try {
    const bot = t.orch.addBot({ name: "SessionProbe" });
    const news = await t.orch.newSession(bot.id, {});
    const fake = t.fake(bot.id);
    assert.equal(fake.newSessionCalled, true);
    assert.equal(news.sessionId, "sess_new");
    const fork = await t.orch.forkSession(bot.id, { entryId: "e1" });
    assert.deepEqual(fake.forkCalled, { entryId: "e1" });
    assert.equal(fork.sessionId, "sess_fork");
    const entries = await t.orch.getNativeEntries(bot.id, { limit: 5 });
    assert.deepEqual(entries.entries, [{ id: "e1", role: "user" }]);

    const exported = await t.orch.exportSession(bot.id, {});
    assert.equal(exported.path.startsWith(join(t.home, "exports")), true);
    assert.equal(exported.html, "<html>fixture</html>");

    const models = await t.orch.listModels({});
    assert.equal(models.source, "native");
    assert.deepEqual(models.models, [{ id: "fixture/model" }]);

    fake.queue = [{ kind: "hang" }];
    const run = t.orch.startRun({ botId: bot.id, text: "占用中" });
    await waitFor(() => t.orch.getRun(run.id).state === "running", { label: "进入 running" });
    await assert.rejects(() => t.orch.newSession(bot.id, {}), (e) => e.status === 409 && e.code === "runtime_busy");
    await t.orch.cancelRun(run.id);
  } finally {
    await t.cleanup();
  }
});

await test("只读副本 shutdown：台账句柄必须被关掉，不留给清理动作 EPERM", async () => {
  const home = mkdtempSync(join(tmpdir(), "ompbot-runs-"));
  let writer;
  let reader;
  try {
    writer = new Orchestrator({ home, bin: "omp-fixture", runtimeFactory: (o) => new FakeRuntime(o), features: stubFeatures() });
    reader = new Orchestrator({ home, bin: "omp-fixture", runtimeFactory: (o) => new FakeRuntime(o), features: stubFeatures() });
    assert.equal(reader.store.readonly, true, "同一 home 的第二个实例必须是只读副本");
    await writer.shutdown();
    // 只读 store 的 flush 曾被只读守卫拒绝，shutdown 在 ledger.close() 之前中断，句柄活过关停。
    await reader.shutdown();
    assert.throws(() => reader.ledger.usage(), (e) => e.code === "LEDGER_CLOSED", "shutdown 后台账必须已关闭");
    rmSync(home, { recursive: true, force: true }); // 句柄还活着时 Windows 会在这里 EPERM
    assert.equal(existsSync(home), false);
  } finally {
    try {
      await reader?.shutdown();
    } catch {}
    try {
      await writer?.shutdown();
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 6. 启动恢复 ----

await test("启动恢复：未落定 Run 记 interrupted，挂起审批记 expired（不重跑、不丢历史）", async () => {
  const home = mkdtempSync(join(tmpdir(), "ompbot-runs-"));
  let first;
  let second;
  try {
    first = new Orchestrator({
      home,
      bin: "omp-fixture",
      runtimeFactory: (o) => new FakeRuntime(o),
      features: stubFeatures(),
    });
    const bot = first.addBot({ name: "RecoverProbe" });
    const run = first.ledger.createRun({ kind: "chat", botId: bot.id, scope: "private", text: "中断的半截" });
    first.ledger.put("approvals", {
      id: "ui_stale",
      runId: run.id,
      botId: bot.id,
      scope: "private",
      nativeId: "native_stale",
      method: "select",
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    first.ledger.updateRun(run.id, { state: "running" });
    await first.shutdown();

    const events = [];
    second = new Orchestrator({
      home,
      bin: "omp-fixture",
      runtimeFactory: (o) => new FakeRuntime(o),
      features: stubFeatures(),
      onEvent: (e) => events.push(e),
    });
    const recovered = second.getRun(run.id);
    assert.equal(recovered.state, "interrupted");
    assert.equal(second.ledger.get("approvals", "ui_stale").status, "expired");
    assert.equal(second.ledger.get("approvals", "ui_stale").expiredReason, "process-restarted");
    assert.equal(events.some((e) => e.type === "runs_reconciled"), true);
    assert.equal(events.some((e) => e.type === "ui_stale_cleared"), true);
  } finally {
    try {
      await second?.shutdown();
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

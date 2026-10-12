// test/rpc-client.mjs — RpcClient 传输层行为测试，零模型调用、零网络。
// 子进程是测试内联写出的小夹具（实现 docs/rpc.md 的协议子集），
// 断言的是竞态、被拒 admission、本地完成 prompt、取消与坏帧恢复等真实行为。

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, nextId } from "../src/rpc-client.mjs";

process.on("unhandledRejection", (err) => {
  console.error("未处理的 promise 拒绝：", err);
  process.exit(1);
});

// ---- 子进程夹具 -------------------------------------------------------------

const FIXTURE_SRC = String.raw`
import readline from "node:readline";

const PLAN = process.env.FIXTURE_PLAN || "normal";
const MAX_FRAME = Number(process.env.FIXTURE_MAX_FRAME || 1048576);
const MAX_REASM = Number(process.env.FIXTURE_MAX_REASM || 67108864);
const CHUNK_SIZE = 300;
const KEEP_ALIVE = PLAN === "ignore-close";

const stats = {
  received: [],
  hostResults: 0,
  hostUpdates: 0,
  uiResponses: 0,
  lastUi: null,
  aborts: 0,
  promptResults: 0,
  negotiated: [],
  pid: process.pid,
  argv: process.argv.slice(2),
  envMark: process.env.FIXTURE_MARK === undefined ? null : process.env.FIXTURE_MARK,
  envSentinel: process.env.OMP_RPC_TEST_SENTINEL === undefined ? null : process.env.OMP_RPC_TEST_SENTINEL,
};
const pendingPrompts = new Map();
let settled = true;
let holdOpen = false;
let chunkSeq = 0;

function send(frame) { process.stdout.write(JSON.stringify(frame) + "\n"); }
function respond(id, command, data) {
  const frame = { type: "response", command, success: true };
  if (id !== undefined) frame.id = id;
  if (data !== undefined) frame.data = data;
  send(frame);
}
function reject(id, command, error, code) {
  const frame = { type: "response", command, success: false, error };
  if (id !== undefined) frame.id = id;
  if (code) frame.code = code;
  send(frame);
}
function readyLine() {
  return JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: MAX_FRAME,
    maxReassembledFrameBytes: MAX_REASM,
  });
}

function startup() {
  if (PLAN === "crash") process.exit(3);
  if (PLAN === "no-ready") { setInterval(() => {}, 1000); return; }
  if (PLAN === "burst") {
    process.stdout.write(readyLine() + "\n" + JSON.stringify({ type: "available_commands_update", commands: [] }) + "\n");
    return;
  }
  if (PLAN === "split-ready") {
    const line = readyLine() + "\n";
    process.stdout.write(line.slice(0, 40));
    setTimeout(() => process.stdout.write(line.slice(40)), 20);
    return;
  }
  process.stdout.write(readyLine() + "\n");
}
startup();

function onPrompt(f) {
  const kind = f.message;
  if (kind === "local") {
    respond(f.id, "prompt", { agentInvoked: false });
    setTimeout(() => { stats.promptResults++; send({ type: "prompt_result", id: f.id, agentInvoked: false, status: "completed", sessionSettled: true }); }, 40);
    return;
  }
  if (kind === "reject") {
    reject(f.id, "prompt", "fixture rejected admission", "fixture_rejected");
    setTimeout(() => { stats.promptResults++; send({ type: "prompt_result", id: f.id, agentInvoked: false, status: "error", sessionSettled: true }); }, 40);
    return;
  }
  settled = false;
  if (kind === "no-ack") { pendingPrompts.set(f.id, "abortable"); return; } // 已准入但故意不回 admission 回执
  respond(f.id, "prompt", { agentInvoked: true });
  if (kind === "hang") { pendingPrompts.set(f.id, "abortable"); return; }
  if (kind === "hang-forever") { pendingPrompts.set(f.id, "forever"); return; }
  if (kind === "hang-slow-settle") { pendingPrompts.set(f.id, "slow-settle"); return; } // abort 后 sessionSettled:false，真实结算晚到
  if (kind === "hang-slow-settle-never") { pendingPrompts.set(f.id, "slow-settle-never"); return; } // 永远不静止
  setTimeout(() => {
    settled = true;
    stats.promptResults++;
    send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
    send({ type: "prompt_result", id: f.id, agentInvoked: true, status: "completed", sessionSettled: true });
    send({ type: "session_settled" });
  }, 20);
}

function writeChunk(chunkId, index, count, byteLength, data) {
  send({ type: "rpc_chunk", chunkId, index, count, byteLength, data });
}
function emitChunks(text, opt) {
  const bytes = Buffer.from(text, "utf8");
  const count = Math.max(2, Math.ceil(bytes.length / CHUNK_SIZE));
  const total = opt.byteLengthDelta ? bytes.length + opt.byteLengthDelta : bytes.length;
  for (let i = 0; i < count; i++) {
    const index = opt.skipIndex !== undefined && i >= opt.skipIndex ? i + 1 : i;
    const declared = opt.countDelta && i === 1 ? count + opt.countDelta : count;
    const seg = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    writeChunk(opt.chunkId, index, declared, total, opt.badData && i === 1 ? "!!!!" : seg.toString("base64"));
  }
}
function emitChunk(f) {
  const kind = f.kind || "ok";
  const chunkId = "rpc-" + (++chunkSeq);
  if (kind === "bad-json") { emitChunks("n".repeat(1400), { chunkId }); return; }
  const json = JSON.stringify({ type: "notice", level: "info", source: f.source || "chunk-ok", message: "A".repeat(f.length || 1200) });
  if (kind === "interrupt") {
    const bytes = Buffer.from(json, "utf8");
    const count = Math.max(2, Math.ceil(bytes.length / CHUNK_SIZE));
    writeChunk(chunkId, 0, count, bytes.length, bytes.subarray(0, CHUNK_SIZE).toString("base64"));
    send({ type: "notice", level: "info", source: "interrupt-marker", message: "between chunks" });
    for (let i = 1; i < count; i++) {
      writeChunk(chunkId, i, count, bytes.length, bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).toString("base64"));
    }
    return;
  }
  if (kind === "bad-index") { emitChunks(json, { chunkId, skipIndex: 1 }); return; }
  if (kind === "bad-count") { emitChunks(json, { chunkId, countDelta: 1 }); return; }
  if (kind === "short") { emitChunks(json, { chunkId, byteLengthDelta: 30 }); return; }
  if (kind === "bad-base64") { emitChunks(json, { chunkId, badData: true }); return; }
  emitChunks(json, { chunkId });
}

function onFixture(f) {
  const op = f.op;
  if (op === "stats") { respond(f.id, "fixture", stats); return; }
  if (op === "exit") { respond(f.id, "fixture", { exiting: true }); setTimeout(() => process.exit(0), 5); return; }
  if (op === "busy-agent-end") {
    settled = false;
    send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
    respond(f.id, "fixture", { settled: false });
    return;
  }
  if (op === "settle-later") {
    settled = false;
    setTimeout(() => { settled = true; send({ type: "session_settled" }); }, 300);
    respond(f.id, "fixture", { settled: false });
    return;
  }
  if (op === "chunk") { emitChunk(f); respond(f.id, "fixture", { emitted: true }); return; }
  if (op === "oversize") {
    process.stdout.write(JSON.stringify({ type: "notice", level: "info", source: "oversize-line", message: "B".repeat(3000) }) + "\n");
    send({ type: "notice", level: "info", source: "after-oversize", message: "tiny" });
    respond(f.id, "fixture", { emitted: true });
    return;
  }
  if (op === "oversize-partial") {
    process.stdout.write(JSON.stringify({ type: "notice", level: "info", source: "oversize-line", message: "B".repeat(3000) }));
    setTimeout(() => {
      process.stdout.write("\n");
      send({ type: "notice", level: "info", source: "after-oversize-partial", message: "tiny" });
      respond(f.id, "fixture", { emitted: true });
    }, 30);
    return;
  }
  if (op === "host-call") {
    send({ type: "host_tool_call", id: f.callId || "host_1", toolCallId: "tc1", toolName: f.tool || "slow", arguments: { message: "hi" } });
    respond(f.id, "fixture", { sent: true });
    return;
  }
  if (op === "host-cancel") {
    send({ type: "host_tool_cancel", id: "cancel_1", targetId: f.targetId });
    respond(f.id, "fixture", { sent: true });
    return;
  }
  if (op === "ui-select") {
    send({ type: "extension_ui_request", id: f.uiId || "ui_1", method: "select", title: "Approve?", message: "Allow the write?", options: ["Approve", "Deny"], timeout: f.timeout === undefined ? 40 : f.timeout });
    respond(f.id, "fixture", { sent: true });
    return;
  }
  if (op === "close-stdin") {
    holdOpen = true;
    setInterval(() => {}, 1000);
    process.stdin.destroy();
    respond(f.id, "fixture", { destroyed: true });
    return;
  }
  respond(f.id, "fixture", { unknown: op === undefined ? null : op });
}

function onLine(line) {
  let f;
  try { f = JSON.parse(line); } catch { return; }
  if (!f || typeof f !== "object") return;
  stats.received.push({
    type: f.type,
    message: f.message === undefined ? null : f.message,
    images: f.images === undefined ? null : f.images.length,
    entryId: f.entryId === undefined ? null : f.entryId,
    subagentId: f.subagentId === undefined ? null : f.subagentId,
    parentSession: f.parentSession === undefined ? null : f.parentSession,
    since: f.since === undefined ? null : f.since,
  });
  const t = f.type;
  if (t === "negotiate_protocol") { stats.negotiated.push(f.protocolVersion); respond(f.id, "negotiate_protocol", { protocolVersion: f.protocolVersion }); return; }
  if (t === "get_state") { respond(f.id, "get_state", { isSettled: settled, sessionId: "fixture-session", hasPendingAsyncWork: false }); return; }
  if (t === "get_last_assistant_text") { respond(f.id, "get_last_assistant_text", { text: "fixture-last-text" }); return; }
  if (t === "set_host_tools") { respond(f.id, "set_host_tools", { toolNames: (f.tools || []).map((x) => x.name) }); return; }
  if (t === "abort") {
    stats.aborts++;
    respond(f.id, "abort");
    let aborted = 0;
    let slow = false;
    let never = false;
    for (const [id, kind] of [...pendingPrompts.entries()]) {
      if (kind === "forever") continue; // 装作没听见 abort
      pendingPrompts.delete(id);
      stats.promptResults++;
      aborted++;
      if (kind === "slow-settle") slow = true;
      if (kind === "slow-settle-never") never = true;
      send({ type: "prompt_result", id, agentInvoked: true, status: "aborted", sessionSettled: !(slow || never) });
    }
    if (!aborted) return; // 没有能结束的票据：绝不自称已静止
    if (never) return; // 会话一直不静止：等客户端宽限到期
    if (slow) {
      setTimeout(() => { settled = true; send({ type: "session_settled" }); }, 250); // 真实结算晚到
      return;
    }
    settled = true;
    setTimeout(() => send({ type: "session_settled" }), 5);
    return;
  }
  if (t === "prompt") { onPrompt(f); return; }
  if (t === "host_tool_result") { stats.hostResults++; return; }
  if (t === "host_tool_update") { stats.hostUpdates++; return; }
  if (t === "extension_ui_response") { stats.uiResponses++; stats.lastUi = f; return; }
  if (t === "extension_ui_request") return;
  if (t === "silent") return; // 故意不回：在途未决命令 / 命令超时用例专用
  if (t === "fixture") { onFixture(f); return; }
  respond(f.id, t, {});
}

if (KEEP_ALIVE) setInterval(() => {}, 1000);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", onLine);
rl.on("close", () => { if (!KEEP_ALIVE && !holdOpen) process.exit(0); });
`;

const dir = mkdtempSync(join(tmpdir(), "omp-rpc-client-test-"));
const fixturePath = join(dir, "fixture.mjs");
writeFileSync(fixturePath, FIXTURE_SRC, "utf8");

// ---- 测试脚手架 -------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function connect({ plan = "normal", maxFrame, maxReasm, ...rest } = {}) {
  const env = { FIXTURE_PLAN: plan };
  if (maxFrame !== undefined) env.FIXTURE_MAX_FRAME = String(maxFrame);
  if (maxReasm !== undefined) env.FIXTURE_MAX_REASM = String(maxReasm);
  return new RpcClient({
    bin: process.execPath,
    mode: null, // 夹具是裸 Node 脚本，不接 --mode
    args: [fixturePath],
    cwd: dir,
    env,
    startupTimeoutMs: 5000,
    stopGraceMs: 500,
    ...rest,
  });
}

function collect(client) {
  const frames = [];
  const frameErrors = [];
  const typed = new Map();
  client.on("frame", (f) => frames.push(f));
  client.on("rpc_frame_error", (e) => frameErrors.push(e));
  client.on("parse_error", (e) => frameErrors.push(e));
  for (const t of ["response", "prompt_result", "event", "session_settled", "extension_ui_request", "host_tool_call", "host_tool_cancel", "notice", "agent_end", "exit"]) {
    client.on(t, (f) => {
      const list = typed.get(t) || [];
      list.push(f);
      typed.set(t, list);
    });
  }
  return { frames, frameErrors, typed };
}

async function waitFor(cond, timeoutMs = 2000, what = "条件") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await delay(5);
  }
}

async function stats(client) {
  return client.command({ type: "fixture", op: "stats" });
}

/** 子进程是否已经真的消失（真实进程检查，不是返回值自证）。 */
function pidGone(pid) {
  return () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- 启动与重启 -------------------------------------------------------------

test("启动握手：ready + v2 协商 + 帧事件覆盖", async () => {
  const client = connect();
  const c = collect(client);
  try {
    await client.start();
    assert.equal(client.protocolVersion, 2, "应在 ready 广告 v2 后完成协商");
    const st = await stats(client);
    assert.deepEqual(st.negotiated, [2], "协商必须以 v2 发出");
    assert.ok(c.frames.some((f) => f.type === "ready"), "ready 必须经 frame 事件暴露");
    const text = await client.getLastAssistantText();
    assert.equal(text.text, "fixture-last-text");
    assert.ok(c.typed.get("response").some((f) => f.command === "get_last_assistant_text"), "响应帧要既走 frame 也走 response/typed");
    assert.equal(client._pending.size, 0);
    assert.equal(client._waiters.size, 0);
  } finally {
    await client.stop();
  }
});

test("启动竞态：ready 与后续帧同一次写入、或跨两次写入都不能丢帧", async () => {
  for (const plan of ["burst", "split-ready"]) {
    const client = connect({ plan });
    const c = collect(client);
    try {
      await client.start(); // 监听在 start() 之前挂好
      assert.equal(client.protocolVersion, 2, `${plan}: 握手应完成`);
      if (plan === "burst") {
        assert.equal((c.typed.get("event") || []).filter((f) => f.type === "available_commands_update").length, 1, "同一批次写入的帧不能被吞掉");
      }
      assert.equal((await client.getState()).isSettled, true);
    } finally {
      await client.stop();
    }
  }
});

test("启动失败：ready 前退出 / 永不 ready，均拒绝并回收子进程", async () => {
  const crashed = connect({ plan: "crash" });
  const err = await crashed.start().then(() => null, (e) => e);
  assert.ok(err, "ready 前退出必须让 start() 拒绝");
  assert.match(err.message, /exited/, "拒绝原因要说明进程已退出");
  assert.equal(crashed.closed, true);
  assert.ok(crashed.exitInfo, "退出信息要记录");

  const stalled = connect({ plan: "no-ready", startupTimeoutMs: 200 });
  const err2 = await stalled.start().then(() => null, (e) => e);
  assert.ok(err2, "永不 ready 必须超时");
  assert.equal(err2.code, "timeout");
  assert.equal(stalled.closed, true, "启动失败不能留下孤儿进程");
  assert.ok(stalled.exitInfo, "被回收的子进程应产生退出事件");
});

test("命令收尾：成功/中止/写失败都不残留 signal 监听与未结算 pending", async () => {
  const client = connect();
  try {
    await client.start();
    const okSignal = new AbortController();
    await client.command({ type: "get_state" }, { signal: okSignal.signal });
    assert.equal(getEventListeners(okSignal.signal, "abort").length, 0, "成功路径不能残留 abort 监听");

    const abortSignal = new AbortController();
    const pendingAbort = client.command({ type: "silent" }, { timeoutMs: 5000, signal: abortSignal.signal }).catch((e) => e);
    abortSignal.abort();
    const abortErr = await pendingAbort;
    assert.equal(abortErr.name, "AbortError");
    assert.equal(getEventListeners(abortSignal.signal, "abort").length, 0, "中止路径不能残留 abort 监听");
    assert.equal(client._pending.size, 0);

    const timeoutSignal = new AbortController();
    const timeoutErr = await client.command({ type: "silent" }, { timeoutMs: 120, signal: timeoutSignal.signal }).then(() => null, (e) => e);
    assert.equal(timeoutErr.code, "timeout");
    assert.equal(getEventListeners(timeoutSignal.signal, "abort").length, 0, "超时路径不能残留 abort 监听");
    assert.equal(client._pending.size, 0);

    client.proc.stdin.destroy(); // 让下一次写同步失败
    const writeSignal = new AbortController();
    const writeErr = await client.command({ type: "get_state" }, { timeoutMs: 500, signal: writeSignal.signal }).then(() => null, (e) => e);
    assert.ok(writeErr, "写失败必须拒绝");
    assert.match(writeErr.message, /not writable/, "必须暴露真实写错误");
    assert.equal(getEventListeners(writeSignal.signal, "abort").length, 0, "写失败路径不能残留 abort 监听");
    assert.equal(client._pending.size, 0, "写失败不能留下未结算的 pending");
  } finally {
    await client.stop();
  }
});

test("start() 并发调用只起一个子进程，退出后可重启", async () => {
  const client = connect();
  try {
    const [a, b] = await Promise.all([client.start(), client.start()]);
    assert.equal(a, client);
    assert.equal(b, client);
    const first = await stats(client);
    assert.equal((await stats(client)).pid, first.pid, "运行中的 start() 不应重启子进程");

    await client.command({ type: "fixture", op: "exit" });
    await waitFor(() => client.closed, 2000, "子进程退出");

    await client.start();
    const after = await stats(client);
    assert.notEqual(after.pid, first.pid, "重启必须换新子进程");
    assert.equal(client.protocolVersion, 2, "重启后要重新协商");
    assert.equal((await client.getState()).isSettled, true);
    assert.equal(client._pending.size, 0);
    assert.equal(client._waiters.size, 0);
  } finally {
    await client.stop();
  }
});

test("进程死亡时在途命令被拒绝，不留悬挂 pending", async () => {
  const client = connect();
  try {
    await client.start();
    const pending = client.command({ type: "silent" }, { timeoutMs: 5000 });
    const guarded = pending.catch((e) => e);
    await delay(50);
    assert.equal(client._pending.size, 1, "命令应确实在途");
    await client.command({ type: "fixture", op: "exit" });
    const err = await guarded;
    assert.ok(err instanceof Error, "进程退出必须拒绝在途命令");
    assert.match(err.message, /exited/);
    assert.equal(client._pending.size, 0);
    await assert.rejects(client.command({ type: "get_state" }), /closed/, "关闭后新命令直接拒绝");
  } finally {
    await client.stop();
  }
});

test("命令超时只回收自己，客户端仍可用", async () => {
  const client = connect();
  try {
    await client.start();
    const err = await client.command({ type: "silent" }, { timeoutMs: 120 }).then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.code, "timeout");
    assert.equal(client._pending.size, 0);
    assert.equal(client.closed, false);
    assert.equal((await client.getState()).isSettled, true);
  } finally {
    await client.stop();
  }
});

test("stop() 关闭真实子进程；子进程赖着不走时被强杀", async () => {
  const polite = connect();
  const stubborn = connect({ plan: "ignore-close" });
  try {
    await polite.start();
    const pidA = (await stats(polite)).pid;
    await polite.stop();
    assert.equal(polite.closed, true);
    await waitFor(() => {
      try {
        process.kill(pidA, 0);
        return false;
      } catch {
        return true;
      }
    }, 2000, "正常子进程退出");

    await stubborn.start();
    const pidB = (await stats(stubborn)).pid;
    await stubborn.stop();
    assert.equal(stubborn.closed, true, "停在 stdin 关闭的子进程也必须被终止");
    await waitFor(() => {
      try {
        process.kill(pidB, 0);
        return false;
      } catch {
        return true;
      }
    }, 2000, "赖着不走的子进程被强杀");
  } finally {
    await polite.stop();
    await stubborn.stop();
  }
});

test("mode 参数真的进到子进程命令行（默认 rpc、可切 rpc-ui、null 不注入）", async () => {
  for (const mode of ["rpc", "rpc-ui"]) {
    const client = new RpcClient({ bin: process.execPath, mode, args: [fixturePath], cwd: dir, startupTimeoutMs: 5000 });
    try {
      const stderr = [];
      client.on("stderr", (d) => stderr.push(d));
      const err = await client.start().then(() => null, (e) => e);
      assert.ok(err, `${mode}: 裸 Node 不认识 --mode，应当启动失败`);
      assert.ok(client.exitInfo, `${mode}: 子进程必须真的退出`);
      assert.match(stderr.join(""), /--mode/, `${mode}: --mode 未出现在启动参数里`);
    } finally {
      await client.stop();
    }
  }
  const bare = connect();
  try {
    await bare.start();
    assert.equal((await stats(bare)).argv.length, 0, "mode: null 时不注入 --mode");
  } finally {
    await bare.stop();
  }
});

test("exactEnvironment：env 完整替换；默认可叠加", async () => {
  process.env.OMP_RPC_TEST_SENTINEL = "leak";
  const merged = connect();
  try {
    await merged.start();
    assert.equal((await stats(merged)).envSentinel, "leak", "默认应与 process.env 合并");
  } finally {
    await merged.stop();
  }

  const exactEnv = { ...process.env, FIXTURE_PLAN: "normal" };
  delete exactEnv.OMP_RPC_TEST_SENTINEL;
  const exact = new RpcClient({
    bin: process.execPath,
    mode: null,
    args: [fixturePath],
    cwd: dir,
    exactEnvironment: true,
    env: exactEnv,
    startupTimeoutMs: 5000,
  });
  try {
    await exact.start();
    assert.equal((await stats(exact)).envSentinel, null, "exactEnvironment 下不得再合并 process.env");
  } finally {
    await exact.stop();
    delete process.env.OMP_RPC_TEST_SENTINEL;
  }
});

// ---- prompt 准入与回合 ------------------------------------------------------

test("promptAndWait：原生本地完成（agentInvoked:false）立即返回、不泄漏 waiter", async () => {
  const client = connect();
  try {
    await client.start();
    const res = await Promise.race([client.promptAndWait("local", { timeoutMs: 5000 }), delay(3000).then(() => "hung")]);
    assert.notEqual(res, "hung", "本地完成的 prompt 不能挂住");
    assert.equal(res.agentInvoked, false);
    assert.equal(res.status, "completed");
    assert.equal(res.settled, true);
    assert.equal(client._waiters.size, 0, "本地完成必须回收 prompt_result waiter");
    await delay(120); // 夹具随后补发的 prompt_result 不得造成未处理拒绝或误结算
    assert.equal(client._waiters.size, 0);
    assert.equal(client._pending.size, 0);
    assert.equal((await client.getState()).isSettled, true);
  } finally {
    await client.stop();
  }
});

test("promptAndWait：admission 被拒立刻抛错且不留悬挂 waiter", async () => {
  const client = connect();
  try {
    await client.start();
    const err = await client.promptAndWait("reject", { timeoutMs: 5000 }).then(() => null, (e) => e);
    assert.ok(err, "被拒的 admission 必须抛错");
    assert.match(err.message, /rejected admission/);
    assert.equal(err.code, "fixture_rejected");
    assert.equal(client._waiters.size, 0, "拒绝后不能留下 waiter");
    assert.equal(client._pending.size, 0);
    await delay(120); // 失败后补发的 prompt_result 不应变成未处理拒绝
    const st = await stats(client);
    assert.ok(st.promptResults >= 1, "夹具确实补发过 prompt_result");
    assert.equal(client.closed, false);
  } finally {
    await client.stop();
  }
});

test("回合超时：发原生 abort 并等真实结算，不谎报、不终止进程", async () => {
  const client = connect();
  try {
    await client.start();
    const err = await client.promptAndWait("hang", { timeoutMs: 150, abortGraceMs: 3000 }).then(() => null, (e) => e);
    assert.ok(err, "超时必须抛错");
    assert.equal(err.code, "timeout");
    assert.equal(err.settled, true, "abort 后回合真的结束，必须记为已结算");
    assert.equal(err.killed, false, "已结算就不该杀进程");
    assert.equal(err.status, "aborted");
    assert.equal(client.closed, false);
    const st = await stats(client);
    assert.equal(st.aborts, 1, "超时必须发出原生 abort");
    const settled = await client.waitForSettled(1000);
    assert.equal(settled.settled, true);
    assert.equal(settled.source, "get_state");
  } finally {
    await client.stop();
  }
});

test("回合超时且 abort 无法结算：有界等待后终止进程", async () => {
  const client = connect();
  try {
    await client.start();
    const pid = (await stats(client)).pid;
    const started = Date.now();
    const err = await client.promptAndWait("hang-forever", { timeoutMs: 150, abortGraceMs: 250 }).then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.code, "timeout");
    assert.equal(err.settled, false, "abort 没能结束回合就不能报已结算");
    assert.equal(err.killed, true, "拒绝之前必须真正终止活跃进程");
    assert.equal(client.closed, true);
    assert.ok(Date.now() - started < 3000, "不能无限等待");
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 2000, "子进程被终止");
  } finally {
    await client.stop();
  }
});

test("signal 中止 promptAndWait：同样走 abort + 真实结算", async () => {
  const client = connect();
  try {
    await client.start();
    const ac = new AbortController();
    const started = client.promptAndWait("hang", { timeoutMs: 5000, abortGraceMs: 2000, signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    const err = await started.then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.name, "AbortError");
    assert.equal(err.code, "aborted");
    assert.equal(err.settled, true);
    const st = await stats(client);
    assert.equal(st.aborts, 1);
    assert.equal(client.closed, false);
  } finally {
    await client.stop();
  }
});

test("admission 回执缺失：不干等，发原生 abort 并等真实结算后可复用", async () => {
  const client = connect();
  try {
    await client.start();
    const err = await client.promptAndWait("no-ack", { admissionTimeoutMs: 150, abortGraceMs: 3000, timeoutMs: 5000 }).then(() => null, (e) => e);
    assert.ok(err, "回执缺失必须报超时，不能挂着");
    assert.equal(err.code, "timeout");
    assert.equal(err.phase, "admission");
    assert.equal(err.turnDone, true, "abort 之后回合确实结束了");
    assert.equal(err.settled, true);
    assert.equal(err.killed, false, "会话已静止就不该回收进程");
    assert.equal(client.closed, false);
    const st = await stats(client);
    assert.equal(st.aborts, 1, "回执超时也必须发原生 abort");
    assert.equal((await client.waitForSettled(1000)).settled, true);
    assert.equal((await client.getState()).isSettled, true, "恢复后客户端必须可复用");
  } finally {
    await client.stop();
  }
});

test("aborted 但 sessionSettled:false：必须等真实 session_settled，不提前结算、不回收", async () => {
  const client = connect();
  try {
    await client.start();
    const t0 = Date.now();
    const err = await client.promptAndWait("hang-slow-settle", { timeoutMs: 120, abortGraceMs: 3000 }).then(() => null, (e) => e);
    const elapsed = Date.now() - t0;
    assert.ok(err, "超时必须抛错");
    assert.equal(err.code, "timeout");
    assert.equal(err.status, "aborted");
    assert.equal(err.turnDone, true);
    assert.equal(err.settled, true, "只有真实的 session_settled 才算静止");
    assert.equal(err.source, "session_settled", "sessionSettled:false 的 prompt_result 不能当成结算");
    assert.equal(err.killed, false);
    assert.ok(elapsed >= 300, `必须继续等真实结算（约 250ms 之后），不能见到 prompt_result 就收口：${elapsed}ms`);
    assert.equal(client.closed, false);
  } finally {
    await client.stop();
  }
});

test("aborted 但会话始终不静止：宽限到期用真实 get_state 收口并回收进程", async () => {
  const client = connect();
  try {
    await client.start();
    const pid = (await stats(client)).pid;
    const err = await client.promptAndWait("hang-slow-settle-never", { timeoutMs: 120, abortGraceMs: 250 }).then(() => null, (e) => e);
    assert.ok(err, "超时必须抛错");
    assert.equal(err.code, "timeout");
    assert.equal(err.status, "aborted");
    assert.equal(err.turnDone, true);
    assert.equal(err.settled, false, "会话没静止就绝不能报 settled");
    assert.equal(err.source, "grace_expired");
    assert.equal(err.killed, true, "拒绝之前必须真正回收未静止的进程");
    assert.equal(client.closed, true);
    await waitFor(pidGone(pid), 2000, "子进程被回收");
  } finally {
    await client.stop();
  }
});

test("等待器被拒但子进程仍活着：不伪造 exit/settled，有界等待后回收再拒绝", async () => {
  const client = connect();
  try {
    await client.start();
    const pid = (await stats(client)).pid;
    const t0 = Date.now();
    const p = client.promptAndWait("hang-forever", { timeoutMs: 60_000, abortGraceMs: 250 }).then(() => null, (e) => e);
    await waitFor(() => client._pending.size === 0 && client._waiters.size === 1, 2000, "回合等待器就绪");
    // 白盒注入“等待器被拒，但进程还活着”（传输失败/重启类拒绝不由 exit 触发）
    client._rejectAllPending(new Error("fixture: waiter rejected while child alive"));
    const err = await p;
    assert.ok(err);
    assert.match(err.message, /waiter rejected while child alive/, "必须原样暴露原始错误，不能伪装成 exit");
    assert.equal(err.settled, false, "没观察到真实静止就不得报 settled");
    assert.equal(err.killed, true, "子进程还活着就必须先回收");
    assert.equal(client.closed, true);
    assert.ok(Date.now() - t0 >= 200, "不能绕过宽限立刻收口");
    await waitFor(pidGone(pid), 2000, "子进程被回收");
    await client.start();
    assert.equal((await client.getState()).isSettled, true, "回收后仍可重启复用");
  } finally {
    await client.stop();
  }
});

test("prompt() 传 images 与显式 id，promptAndWait 用同一 id 关联", async () => {
  const client = connect();
  try {
    await client.start();
    const id = nextId("explicit");
    const res = await client.promptAndWait("normal", { id, images: [{ type: "image", mimeType: "image/png", data: "AA==" }], timeoutMs: 5000 });
    assert.equal(res.status, "completed");
    const st = await stats(client);
    const admitted = st.received.filter((r) => r.type === "prompt");
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].message, "normal");
    assert.equal(admitted[0].images, 1, "images 必须真的发出");
    assert.equal(st.negotiated.length, 1);
  } finally {
    await client.stop();
  }
});

// ---- settled -----------------------------------------------------------------

test("waitForSettled：agent_end 不是结算，session_settled 才是", async () => {
  const client = connect();
  try {
    await client.start();
    await client.command({ type: "fixture", op: "busy-agent-end" });
    const err = await client.waitForSettled(250).then(() => null, (e) => e);
    assert.ok(err, "只有 agent_end 时不得判定为已静止");
    assert.equal(err.code, "timeout");

    await client.command({ type: "fixture", op: "settle-later" });
    const settled = await client.waitForSettled(2000);
    assert.equal(settled.settled, true);
    assert.equal(settled.source, "session_settled", "应由 session_settled 结算");
  } finally {
    await client.stop();
  }
});

// ---- v2 分块与坏帧恢复 -------------------------------------------------------

test("v2 chunk：合法序列按逻辑帧透传，物理分片也可见", async () => {
  const client = connect({ maxFrame: 1024 });
  const c = collect(client);
  try {
    await client.start();
    const notices = [];
    client.on("notice", (f) => notices.push(f));
    await client.command({ type: "fixture", op: "chunk", kind: "ok", length: 1200 });
    await waitFor(() => notices.length >= 1, 2000, "重组帧");
    assert.equal(notices[0].source, "chunk-ok");
    assert.equal(notices[0].message.length, 1200, "重组内容必须完整");
    assert.equal(client._pendingChunk, null);
    assert.equal(c.frameErrors.length, 0);
    assert.ok(c.frames.some((f) => f.type === "rpc_chunk"), "分片物理帧也应经 frame 事件暴露");
    assert.ok(c.frames.some((f) => f.type === "notice" && f.source === "chunk-ok"), "重组后的逻辑帧同样要经 frame 事件");
  } finally {
    await client.stop();
  }
});

test("v2 chunk：打断/跳号/count 不符/长度不符/坏 base64/坏 JSON 都只报错，之后仍可重组", async () => {
  const client = connect({ maxFrame: 1024 });
  const c = collect(client);
  try {
    await client.start();
    for (const kind of ["interrupt", "bad-index", "bad-count", "short", "bad-base64", "bad-json"]) {
      const before = c.frameErrors.length;
      const notices = [];
      const onNotice = (f) => notices.push(f);
      client.on("notice", onNotice);
      await client.command({ type: "fixture", op: "chunk", kind });
      await waitFor(() => c.frameErrors.length > before, 2000, `${kind} 帧错误`);
      await delay(30);
      assert.ok(c.frameErrors.length > before, `${kind}: 坏序列必须报 rpc_frame_error`);
      assert.equal(notices.filter((f) => f.source === "chunk-ok").length, 0, `${kind}: 不得透传半截逻辑帧`);
      if (kind === "interrupt") {
        assert.ok(notices.some((f) => f.source === "interrupt-marker"), "打断后普通帧仍要处理");
      }
      client.off("notice", onNotice);
      assert.equal(client.closed, false, `${kind}: 坏帧不能让客户端失效`);
    }
    const notices = [];
    client.on("notice", (f) => notices.push(f));
    await client.command({ type: "fixture", op: "chunk", kind: "ok", length: 1200 });
    await waitFor(() => notices.length >= 1, 2000, "坏帧之后重新同步");
    assert.equal(notices[0].message.length, 1200);
    assert.equal(client._pendingChunk, null);
    assert.equal(client._badChunk, null);
  } finally {
    await client.stop();
  }
});

test("物理帧超限：整行与跨写入残行都被丢弃，之后重新同步", async () => {
  for (const op of ["oversize", "oversize-partial"]) {
    const client = connect({ maxFrame: 1024 });
    const c = collect(client);
    try {
      await client.start();
      const notices = [];
      client.on("notice", (f) => notices.push(f));
      await client.command({ type: "fixture", op });
      await waitFor(() => notices.some((f) => f.source === `after-${op}`), 2000, `${op} 之后重新同步`);
      assert.ok(c.frameErrors.length >= 1, `${op}: 超限物理帧必须报错`);
      assert.equal(notices.filter((f) => f.source === "oversize-line").length, 0, `${op}: 超限帧内容不得透传`);
      assert.equal(client.closed, false);
    } finally {
      await client.stop();
    }
  }
});

test("stdin 被对端关闭：写失败要拒绝而不挂死", async () => {
  const client = connect();
  try {
    await client.start();
    await client.command({ type: "fixture", op: "close-stdin" });
    const err = await client.command({ type: "get_state" }, { timeoutMs: 800 }).then(() => null, (e) => e);
    assert.ok(err, "对端不再读 stdin 时不能挂死");
    assert.equal(client._pending.size, 0);
  } finally {
    await client.stop();
  }
});

// ---- host tool --------------------------------------------------------------

test("host tool：progress 上报 native update，cancel 后抑制迟到结果", async () => {
  const client = connect();
  try {
    await client.start();
    const gate = deferred();
    let meta = null;
    const aborted = deferred();
    client.onHostTool("slow", async (_args, m) => {
      meta = m;
      m.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      m.progress("working");
      await gate.promise;
      return "late-result";
    });
    await client.command({ type: "fixture", op: "host-call", tool: "slow" });
    await waitFor(() => meta !== null, 2000, "host tool 被调用");
    assert.equal(meta.toolName, "slow");
    assert.equal(meta.toolCallId, "tc1");
    assert.ok(meta.requestId, "meta.requestId 必须给出回调 id");

    await client.command({ type: "fixture", op: "host-cancel", targetId: "host_1" });
    await aborted.promise;
    assert.equal(meta.signal.aborted, true, "host_tool_cancel.targetId 必须中止对应的调用");

    gate.resolve();
    await delay(60);
    const st = await stats(client);
    assert.equal(st.hostUpdates, 1, "progress 必须以原生 host_tool_update 发出");
    assert.equal(st.hostResults, 0, "取消后迟到结果必须被抑制");
    assert.equal(client._hostCalls.size, 0);
  } finally {
    await client.stop();
  }
});

test("host tool：关闭时中止在途调用并丢弃结果", async () => {
  const client = connect();
  const gate = deferred();
  let meta = null;
  let returned = false;
  client.onHostTool("slow", async (_args, m) => {
    meta = m;
    await gate.promise;
    returned = true;
    return "after-close";
  });
  await client.start();
  try {
    await client.command({ type: "fixture", op: "host-call", tool: "slow" });
    await waitFor(() => meta !== null, 2000, "host tool 被调用");
    await client.stop();
    assert.equal(meta.signal.aborted, true, "关闭必须中止在途调用");
    assert.equal(client.closed, true);
    gate.resolve();
    await delay(40);
    assert.equal(returned, true, "处理器仍应能返回，结果被静默丢弃");
    assert.equal(client._hostCalls.size, 0);
  } finally {
    gate.resolve();
    await client.stop();
  }
});

// ---- 原生 UI ----------------------------------------------------------------

test("原生 UI：请求直通，respondExtensionUI 原始帧无回执、不代答超时", async () => {
  const client = connect();
  const c = collect(client);
  try {
    await client.start();
    await client.command({ type: "fixture", op: "ui-select" });
    await waitFor(() => (c.typed.get("extension_ui_request") || []).length === 1, 2000, "UI 请求");
    const req = c.typed.get("extension_ui_request")[0];
    assert.equal(req.method, "select");
    assert.deepEqual(req.options, ["Approve", "Deny"]);
    assert.ok(c.frames.some((f) => f.type === "extension_ui_request"), "UI 请求也要走 frame 事件");

    const pendingBefore = client._pending.size;
    const written = client.respondExtensionUI({ id: req.id, value: "Approve" });
    assert.equal(written.type, "extension_ui_response");
    assert.equal(written.value, "Approve");
    assert.equal(client._pending.size, pendingBefore, "UI 回执不能产生命令 ack");
    const st = await stats(client);
    assert.equal(st.uiResponses, 1);
    assert.equal(st.lastUi.value, "Approve");

    // 请求自带 timeout，但传输层绝不自动回 recommended / timedOut
    await client.command({ type: "fixture", op: "ui-select", uiId: "ui_timeout", timeout: 30 });
    await delay(200);
    const st2 = await stats(client);
    assert.equal(st2.uiResponses, 1, "未作答的 ask 必须留给产品层 abort，传输层不得代答");
    assert.equal(st2.lastUi.id, req.id);
    assert.throws(() => client.respondExtensionUI({ value: "x" }), /requires id/);
  } finally {
    await client.stop();
  }
});

// ---- 命令面（一次覆盖，不逐条回声） -----------------------------------------

test("命令面：新方法把协议命令真的发到线上", async () => {
  const client = connect();
  try {
    await client.start();
    await client.setAskDialog(true);
    await client.setEventFilter();
    await client.setSubagentSubscription();
    await client.getSubagents();
    await client.getEntries({ since: "entry-1" });
    await client.getMessagesPage({ cursor: "c1", limit: 10 });
    await client.fork({ entryId: "entry-2" });
    await client.branch("entry-3");
    await client.exportHtml(join(dir, "out.html"));
    await client.setModel("provider-x", "model-y");
    await client.getAvailableModels();
    await client.getLoginProviders();
    await client.setSubagentSubscription("off");
    await client.steer("插话", { images: [{ type: "image", mimeType: "image/png", data: "AA==" }] });
    await client.followUp("追问");
    await client.cancelSubagent("Sub1");
    await client.steerSubagent("Sub1", "继续");
    await client.abortBash();

    const st = await stats(client);
    const types = st.received.map((r) => r.type);
    for (const expected of [
      "set_ask_dialog",
      "set_event_filter",
      "set_subagent_subscription",
      "get_subagents",
      "get_entries",
      "get_messages_page",
      "fork",
      "branch",
      "export_html",
      "set_model",
      "get_available_models",
      "get_login_providers",
      "steer",
      "follow_up",
      "cancel_subagent",
      "steer_subagent",
      "abort_bash",
    ]) {
      assert.ok(types.includes(expected), `未发出 ${expected} 命令`);
    }
    const byType = (t) => st.received.find((r) => r.type === t);
    assert.equal(byType("get_entries").since, "entry-1");
    assert.equal(byType("fork").entryId, "entry-2");
    assert.equal(byType("branch").entryId, "entry-3");
    assert.equal(byType("steer").images, 1, "steer 必须带 images");
    assert.equal(byType("cancel_subagent").subagentId, "Sub1", "cancelSubagent 必须用 subagentId");
    assert.equal(byType("steer_subagent").subagentId, "Sub1");
  } finally {
    await client.stop();
  }
});

test("nextId 保持可用且唯一", () => {
  const a = nextId();
  const b = nextId("x");
  assert.notEqual(a, b);
  assert.match(b, /^x_\d+$/);
});

// ---- 运行 -------------------------------------------------------------------

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n      ") : e}`);
  }
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {}

console.log(`\n${passed}/${tests.length} 通过${failed ? `，${failed} 失败` : ""}`);
if (failed) process.exitCode = 1;

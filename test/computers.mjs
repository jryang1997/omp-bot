import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.mjs";

class ControlledComputerBackend {
  constructor() {
    this.states = new Map();
    this.text = "";
    this.nextStatusGate = null;
    this.nextInputGate = null;
  }

  async status(id) {
    const gate = this.nextStatusGate;
    this.nextStatusGate = null;
    if (gate) {
      gate.enter();
      await gate.pending;
    }
    return {
      state: this.states.get(id) ?? "stopped",
      runtime: "qemu",
      kind: "vm",
      os: "linux",
      display: { width: 1280, height: 800 },
      error: null,
    };
  }

  async create(id) {
    return this.start(id);
  }

  async start(id) {
    this.states.set(id, "running");
    return this.status(id);
  }

  async stop(id) {
    this.states.set(id, "stopped");
    return this.status(id);
  }

  async input(_id, action, { signal } = {}) {
    const gate = this.nextInputGate;
    this.nextInputGate = null;
    if (gate) {
      const onAbort = () => gate.abortObserved();
      signal?.addEventListener("abort", onAbort, { once: true });
      gate.enter();
      try {
        await gate.pending;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted) return;
    }
    if (action.action === "type") this.text += action.text;
  }
  async uploadFile() {
    throw Object.assign(new Error("Attachment upload acknowledgement was lost"), { code: "computer_guest_rpc_failed" });
  }
  async close() {}
}

function inputGate() {
  let enter;
  let abortObserved;
  let finish;
  let fail;
  const entered = new Promise((resolveEntered) => { enter = resolveEntered; });
  const aborted = new Promise((resolveAborted) => { abortObserved = resolveAborted; });
  const timeout = setTimeout(() => fail(new Error("Controlled input was never settled")), 10_000);
  const pending = new Promise((resolvePending, rejectPending) => {
    finish = () => { clearTimeout(timeout); resolvePending(); };
    fail = (error) => { clearTimeout(timeout); rejectPending(error); };
  });
  return { enter, abortObserved, finish, fail, entered, aborted, pending };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Controlled transition deadline exceeded")), 10_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const home = mkdtempSync(join(tmpdir(), "ompbot-computer-http-"));
const backend = new ControlledComputerBackend();
const server = await startServer({ home, port: 0, computerBackend: backend, bin: join(home, "no-model-binary") });
let passed = 0;

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(server.url + path, {
    method,
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

async function post(path, body = {}) {
  return api(path, { method: "POST", body });
}

function pass(name) {
  passed++;
  console.log(`PASS ${name}`);
}

try {
  const a = (await post("/api/bots", { name: "Computer A" })).data.bot;
  const b = (await post("/api/bots", { name: "Computer B" })).data.bot;
  const aPath = `/api/bots/${a.id}/computer`;
  const bPath = `/api/bots/${b.id}/computer`;
  assert.equal((await api("/api/bots/missing/computer")).status, 404);
  assert.equal((await post(`${aPath}/input`, { generation: 0, action: "type", text: "premature" })).status, 409);
  pass("未知 Bot 与尚未绑定电脑不能接收桌面输入");

  assert.equal((await post(`${aPath}/bind`)).status, 200);
  assert.equal((await post(`${bPath}/bind`)).status, 200);
  const takeA = await post(`${aPath}/takeover`);
  assert.equal(takeA.status, 200);
  assert.equal(takeA.data.computer.holder, "human");
  const firstGeneration = takeA.data.computer.generation;
  const blocked = await post("/api/runs", { botId: a.id, text: "should not start during human control" });
  assert.equal(blocked.status, 409);
  assert.equal((await api(bPath)).data.computer.holder, null);
  assert.equal((await post(`${bPath}/input`, { generation: firstGeneration, action: "type", text: "cross-computer" })).status, 409);
  pass("接管只影响所属电脑，阻止同 Bot 新回合和未接管电脑的输入");

  const currentInput = await post(`${aPath}/input`, { generation: firstGeneration, action: "type", text: "current human" });
  assert.equal(currentInput.status, 200);
  const wrongRelease = await post(`${aPath}/release`, { generation: firstGeneration - 1 });
  assert.equal(wrongRelease.status, 409);
  assert.equal((await api(aPath)).data.computer.holder, "human");
  assert.equal((await post(`${aPath}/release`, { generation: firstGeneration })).status, 200);
  assert.equal((await post(`${aPath}/input`, { generation: firstGeneration, action: "type", text: "late old human input" })).status, 409);
  pass("错误归还代际保留接管，正确归还后旧输入被拒绝");

  const takeAgain = await post(`${aPath}/takeover`);
  assert.equal(takeAgain.status, 200);
  assert.equal(takeAgain.data.computer.holder, "human");
  const nextGeneration = takeAgain.data.computer.generation;
  assert.notEqual(nextGeneration, firstGeneration);
  assert.equal((await post(`${aPath}/input`, { generation: firstGeneration, action: "key", key: "ENTER" })).status, 409);
  assert.equal((await post(`${aPath}/input`, { generation: nextGeneration, action: "type", text: "new human" })).status, 200);
  pass("重新接管不会重放先前接管周期的输入");

  assert.equal((await post(`${aPath}/stop`)).status, 200);
  assert.equal((await api(aPath)).data.computer.state, "stopped");
  assert.equal((await post(`${aPath}/input`, { generation: nextGeneration, action: "type", text: "stopped input" })).status, 409);
  assert.equal((await post(`${aPath}/start`)).status, 200);
  const afterRestart = (await api(aPath)).data.computer;
  assert.equal(afterRestart.holder, null);
  assert.equal((await post(`${aPath}/input`, { generation: nextGeneration, action: "type", text: "late input after restart" })).status, 409);
  pass("停止与重新启动不会保留旧的人类输入权限");

  const currentBot = server.orch.getBot(a.id);
  const actionRun = server.orch.ledger.createRun({ kind: "chat", botId: a.id, scope: "private", text: "controlled tool consumer" });
  server.orch.features.computers.acquireRunLease({ botId: a.id, scope: "private", runId: actionRun.id });
  const tools = server.orch.features.hostTools({ bot: currentBot, activeRun: { runId: actionRun.id, abort: new AbortController() } });
  const runSpool = join(home, "computers", server.orch.features.computers.computerIdFor(a.id), "spool", actionRun.id);
  mkdirSync(runSpool, { recursive: true });
  writeFileSync(join(runSpool, "published.txt"), "immutable artifact already collected");
  const inputTool = tools.find((tool) => tool.name === "computer_input");
  let resumeStatus;
  let enterStatus;
  const enteredStatus = new Promise((resolveEntered) => { enterStatus = resolveEntered; });
  const pendingStatus = new Promise((resolveStatus) => { resumeStatus = resolveStatus; });
  backend.nextStatusGate = { enter: enterStatus, pending: pendingStatus };
  const pendingOldInput = inputTool.handler({ action: "type", text: "OLD_AGENT_CLICK" }, { signal: new AbortController().signal });
  await within(enteredStatus);
  const racedTakeover = await post(`${aPath}/takeover`);
  resumeStatus();
  const oldInputResult = await pendingOldInput;
  assert.equal(racedTakeover.status, 200);
  assert.equal(oldInputResult.isError, true);
  assert.equal((await post(`${aPath}/input`, { generation: racedTakeover.data.computer.generation, action: "type", text: "NEW_HUMAN_INPUT" })).status, 200);
  assert.equal(backend.text, "current humannew humanNEW_HUMAN_INPUT");
  pass("接管完成后，先前在状态查询中等待的自动输入不会落到客机");
  server.orch.features.computers.releaseRunLease(actionRun.id);
  assert.equal(existsSync(runSpool), false);
  pass("接管撤销的回合在收尾时仍清理已登记成果的临时目录");

  const heldInput = inputGate();
  backend.nextInputGate = heldInput;
  const priorGeneration = racedTakeover.data.computer.generation;
  const pendingHumanInput = post(`${aPath}/input`, { generation: priorGeneration, action: "type", text: "STALE_HUMAN_INPUT" });
  await within(heldInput.entered);
  const pendingRelease = post(`${aPath}/release`, { generation: priorGeneration });
  await within(heldInput.aborted);
  const duringRelease = await post(`${aPath}/input`, { generation: priorGeneration, action: "type", text: "MORE_STALE_INPUT" });
  heldInput.finish();
  const [inputAfterAbort, releasedAfterDrain] = await Promise.all([pendingHumanInput, pendingRelease]);
  assert.equal(duringRelease.status, 409);
  assert.equal(releasedAfterDrain.status, 200);
  assert.ok([200, 409].includes(inputAfterAbort.status));
  assert.equal((await api(aPath)).data.computer.holder, null);
  assert.equal(backend.text, "current humannew humanNEW_HUMAN_INPUT");
  pass("归还控制先阻止新输入，并等待已取消的人类动作确认结束");

  const heldAgain = (await post(`${aPath}/takeover`)).data.computer;
  const unknownInput = inputGate();
  backend.nextInputGate = unknownInput;
  const unconfirmedHumanInput = post(`${aPath}/input`, { generation: heldAgain.generation, action: "type", text: "UNCONFIRMED_INPUT" });
  await within(unknownInput.entered);
  const deniedRelease = post(`${aPath}/release`, { generation: heldAgain.generation });
  await within(unknownInput.aborted);
  unknownInput.fail(Object.assign(new Error("Guest input acknowledgement was lost"), { code: "computer_effect_unknown" }));
  const [unconfirmedInputResult, unconfirmedReleaseResult] = await Promise.all([unconfirmedHumanInput, deniedRelease]);
  assert.equal(unconfirmedInputResult.status, 409);
  assert.equal(unconfirmedReleaseResult.status, 409);
  assert.equal(unconfirmedReleaseResult.data.code, "computer_effect_unknown");
  const stillHuman = (await api(aPath)).data.computer;
  assert.equal(stillHuman.holder, "human");
  assert.equal(stillHuman.error.code, "computer_effect_unknown");
  assert.equal((await post("/api/runs", { botId: a.id, text: "cannot overlap an unconfirmed human input" })).status, 409);
  pass("未确认的人类输入阻止归还与自动运行，公开状态保留效果未知");

  assert.equal((await post(`${aPath}/stop`)).status, 200);
  assert.equal((await post(`${aPath}/start`)).status, 200);
  const unknownRun = server.orch.ledger.createRun({ kind: "chat", botId: a.id, scope: "private", text: "unknown agent RPC consumer" });
  server.orch.features.computers.acquireRunLease({ botId: a.id, runId: unknownRun.id });
  const unknownTools = server.orch.features.hostTools({ bot: server.orch.getBot(a.id), activeRun: { runId: unknownRun.id, abort: new AbortController() } });
  const lostRpc = inputGate();
  backend.nextInputGate = lostRpc;
  const unknownAgentInput = unknownTools.find((tool) => tool.name === "computer_input").handler({ action: "type", text: "UNCERTAIN_AGENT_INPUT" }, { signal: new AbortController().signal });
  await within(lostRpc.entered);
  lostRpc.fail(Object.assign(new Error("Guest transport disconnected after dispatch"), { code: "computer_guest_rpc_failed" }));
  assert.equal((await unknownAgentInput).isError, true);
  server.orch.features.computers.releaseRunLease(unknownRun.id);
  assert.equal((await api(aPath)).data.computer.error.code, "computer_effect_unknown");
  assert.equal((await post("/api/runs", { botId: a.id, text: "cannot overlap an unconfirmed agent RPC" })).status, 409);
  assert.equal((await post(`${aPath}/stop`)).status, 200);
  assert.equal((await api(aPath)).data.computer.error, null);
  pass("普通客机 RPC 断流也保留效果未知并阻止新回合，确认停机后解除");

  assert.equal((await post(`${aPath}/start`)).status, 200);
  const uploadAttachment = (await post("/api/attachments", { botId: a.id, filename: "partial.txt", mime: "text/plain", dataBase64: Buffer.from("PARTIAL_UPLOAD").toString("base64") })).data.attachment;
  const uploadRun = server.orch.ledger.createRun({ kind: "chat", botId: a.id, scope: "private", text: "attachment transport consumer", attachmentIds: [uploadAttachment.id] });
  server.orch.features.computers.acquireRunLease({ botId: a.id, runId: uploadRun.id });
  await assert.rejects(server.orch.features.preparePrompt(uploadRun), error => error.code === "computer_guest_rpc_failed");
  server.orch.features.computers.releaseRunLease(uploadRun.id);
  assert.equal((await api(aPath)).data.computer.error.code, "computer_effect_unknown");
  assert.equal((await post("/api/runs", { botId: a.id, text: "cannot overlap partial attachment upload" })).status, 409);
  assert.equal((await post(`${aPath}/stop`)).status, 200);
  pass("附件准备的 RPC 断流同样阻止自动回合，确认停机后解除");
} finally {
  await server.close();
  rmSync(home, { recursive: true, force: true });
}

console.log(`Computer HTTP transitions ${passed}/${passed} passed. Controlled backend; guest behavior belongs to smoke-computers.mjs.`);

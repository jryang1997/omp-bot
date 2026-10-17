// 04 电脑求助：bot 卡在要人做的地方，记下求助；主人接管、归还后自动叫 bot 接着做，只叫一次。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.mjs";
import { helpResumeText } from "../src/features/computers.mjs";

class Backend {
  constructor() { this.states = new Map(); }
  async status(id) {
    return { state: this.states.get(id) ?? "stopped", runtime: "qemu", kind: "vm", os: "linux", display: { width: 1280, height: 800 }, error: null };
  }
  async create(id) { return this.start(id); }
  async start(id) { this.states.set(id, "running"); return this.status(id); }
  async stop(id) { this.states.set(id, "stopped"); return this.status(id); }
  async input() {}
  async close() {}
}

const home = mkdtempSync(join(tmpdir(), "ompbot-help-"));
const server = await startServer({ home, port: 0, computerBackend: new Backend(), bin: join(home, "no-model-binary") });
const events = [];
const emit = server.orch.emit.bind(server.orch);
server.orch.emit = (type, data) => { events.push({ type, ...data }); return emit(type, data); };
const computers = server.orch.features.computers;
let passed = 0;
let failed = 0;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(server.url + path, {
    method,
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}
const post = (path, body = {}) => api(path, { method: "POST", body });

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

function helpTool(bot, runId) {
  const tools = server.orch.features.hostTools({ bot: server.orch.getBot(bot.id), activeRun: { runId, abort: new AbortController() } });
  const tool = tools.find((t) => t.name === "computer_request_help");
  assert.ok(tool, "绑定电脑的 bot 有 computer_request_help");
  return tool;
}

function startedHelpRuns(botId) {
  return server.orch.ledger.listRuns({ botId, limit: 100 }).filter((r) => r.source === "computer_help");
}

try {
  const bot = (await post("/api/bots", { name: "Helper" })).data.bot;
  const path = `/api/bots/${bot.id}/computer`;
  assert.equal((await post(`${path}/bind`)).status, 200);
  assert.equal((await post(`${path}/start`)).status, 200);

  await test("没持有电脑租约的 Run 不能求助", async () => {
    const run = server.orch.ledger.createRun({ kind: "chat", botId: bot.id, scope: "private", text: "no lease" });
    const out = await helpTool(bot, run.id).handler({ reason: "扫码登录" });
    assert.equal(out.isError, true);
    assert.equal((await api(path)).data.computer.help, null);
  });

  let helpRun;
  await test("持有租约的 Run 求助：记下原因，发事件，状态里看得到", async () => {
    helpRun = server.orch.ledger.createRun({ kind: "chat", botId: bot.id, scope: "private", text: "log in" });
    computers.acquireRunLease({ botId: bot.id, scope: "private", runId: helpRun.id });
    const out = await helpTool(bot, helpRun.id).handler({ reason: "  网页要扫码登录，\n请扫一下 " });
    assert.notEqual(out.isError, true);
    assert.match(out.content[0].text, /结束这一回合/);
    const ev = events.find((e) => e.type === "computer_help_requested");
    assert.equal(ev?.reason, "网页要扫码登录， 请扫一下");
    assert.equal(ev?.runId, helpRun.id);
    const help = (await api(path)).data.computer.help;
    assert.equal(help.reason, "网页要扫码登录， 请扫一下");
    assert.equal(help.runId, helpRun.id);
    computers.releaseRunLease(helpRun.id);
  });

  await test("空原因不算求助", async () => {
    const run = server.orch.ledger.createRun({ kind: "chat", botId: bot.id, scope: "private", text: "empty" });
    computers.acquireRunLease({ botId: bot.id, scope: "private", runId: run.id });
    const out = await helpTool(bot, run.id).handler({ reason: "   " });
    assert.equal(out.isError, true);
    computers.releaseRunLease(run.id);
  });

  await test("接管期间求助还在；归还后自动开一次继续的 Run，求助清掉", async () => {
    const take = await post(`${path}/takeover`);
    assert.equal(take.status, 200);
    assert.equal(take.data.computer.help?.reason, "网页要扫码登录， 请扫一下");
    const rel = await post(`${path}/release`, { generation: take.data.computer.generation });
    assert.equal(rel.status, 200);
    const runs = startedHelpRuns(bot.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].text, helpResumeText("网页要扫码登录， 请扫一下"));
    const ev = events.find((e) => e.type === "computer_help_resumed");
    assert.equal(ev?.runId, runs[0].id);
    assert.equal(ev?.helpRunId, helpRun.id);
    assert.equal((await api(path)).data.computer.help, null);
  });

  await test("没有求助时接管、归还不会叫 bot", async () => {
    // 等上一条继续的 Run 收尾，放掉电脑租约。
    for (let i = 0; i < 100 && server.orch.ledger.listRuns({ botId: bot.id, limit: 100 }).some((r) => r.source === "computer_help" && !["failed", "completed", "cancelled", "interrupted"].includes(r.state)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const take = await post(`${path}/takeover`);
    assert.equal(take.status, 200);
    assert.equal((await post(`${path}/release`, { generation: take.data.computer.generation })).status, 200);
    assert.equal(startedHelpRuns(bot.id).length, 1);
  });

  await test("关机等于放弃求助：之后归还也不叫 bot", async () => {
    const run = server.orch.ledger.createRun({ kind: "chat", botId: bot.id, scope: "private", text: "again" });
    computers.acquireRunLease({ botId: bot.id, scope: "private", runId: run.id });
    await helpTool(bot, run.id).handler({ reason: "输验证码" });
    computers.releaseRunLease(run.id);
    assert.equal((await post(`${path}/stop`)).status, 200);
    assert.equal((await api(path)).data.computer.help, null);
    assert.equal((await post(`${path}/start`)).status, 200);
    const take = await post(`${path}/takeover`);
    assert.equal((await post(`${path}/release`, { generation: take.data.computer.generation })).status, 200);
    assert.equal(startedHelpRuns(bot.id).length, 1);
  });

  await test("求助随电脑状态落盘", async () => {
    const run = server.orch.ledger.createRun({ kind: "chat", botId: bot.id, scope: "private", text: "persist" });
    computers.acquireRunLease({ botId: bot.id, scope: "private", runId: run.id });
    await helpTool(bot, run.id).handler({ reason: "确认付款" });
    computers.releaseRunLease(run.id);
    const row = server.orch.ledger.list("settings", { limit: 1000 }).find((r) => r.kind === "computer" && r.botId === bot.id);
    assert.equal(row?.help?.reason, "确认付款");
  });
} finally {
  await server.close();
}

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

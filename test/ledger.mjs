// test/ledger.mjs — 台账（src/ledger.mjs）与单写者锁（src/store.mjs）的真实行为测试。
// 真 SQLite + 临时 home，零模型调用、零 mock。运行：node test/ledger.mjs
// 覆盖：重启保留、Run 终态边界、seq 单调与有界、写失败回滚、只读不改内存/磁盘、
//       迁移前备份原件、中断恢复、用量差值、锁的唯一赢家（同进程、陈旧回收竞争、真实子进程竞争）。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Ledger, RECOVERY_UNKNOWN } from "../src/ledger.mjs";
import { makeBot } from "../src/domain.mjs";
import { STATE_VERSION } from "../src/constants.mjs";
import { Store } from "../src/store.mjs";

const STORE_URL = new URL("../src/store.mjs", import.meta.url).href;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const homes = [];
const tmpHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "ompbot-ledger-"));
  homes.push(dir);
  return dir;
};
const approx = (a, b) => Math.abs(a - b) < 1e-9;
const hasCode = (code) => (e) => e?.code === code;

/** 跑一个子进程做真人竞争：抢到锁就打 WIN 并持有 ms 毫秒。 */
function lockRaceScript() {
  return `
import { Store } from ${JSON.stringify(STORE_URL)};
const [home, delayRaw, holdRaw] = process.argv.slice(2);
if (Number(delayRaw)) await new Promise((r) => setTimeout(r, Number(delayRaw)));
const store = new Store({ home });
store.load();
const won = store.acquireLock();
process.stdout.write(won ? "WIN\\n" : "LOSE\\n");
if (won) {
  await new Promise((r) => setTimeout(r, Number(holdRaw)));
  store.releaseLock();
}
`;
}

// 起一架子进程去抢同一个 home，返回每个人的输出行。
// 赢家多持有一会儿：让后启动的竞争者一定撞上活锁，避免把「顺序持有」误判成两个赢家。
async function raceForLock(home, { count, scriptPath, stagger = 10, hold = 2500 } = {}) {
  const children = [];
  for (let i = 0; i < count; i++) {
    children.push(
      spawn(process.execPath, [scriptPath, home, String(i * stagger), String(hold)], {
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
  }
  const lines = await Promise.all(
    children.map(async (child) => {
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      await once(child, "exit");
      return out.trim();
    }),
  );
  return lines;
}

/** 起一个只持锁不退出的子进程，返回 {child, pid}（调用方负责 kill）。 */
async function holdLockChild(home, scriptPath) {
  const child = spawn(process.execPath, [scriptPath, home, "0", "60000"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  while (!out.includes("WIN")) {
    await once(child.stdout, "data");
  }
  return child;
}

async function killAndWait(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

/** 拿一个确定已经死掉的 pid（用于造陈旧锁）。 */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  return pid;
}

// ---- 重启保留 ----

test("重启：Run/事件/条目/用量跨 close→open 保留，seq 从上次继续", () => {
  const home = tmpHome();
  const ledger = new Ledger({ home });
  const run = ledger.createRun({ kind: "chat", scope: "private", text: "重启前", botId: "b1" });
  ledger.appendEvent({ type: "run_created", runId: run.id, botId: "b1", scope: "private" });
  ledger.put("artifacts", { id: "art1", runId: run.id, path: "out.txt" });
  ledger.updateRun(run.id, { state: "running", sessionId: "s1", sessionFile: "s1.jsonl" });
  ledger.addUsage(run.id, { tokens: { input: 100, output: 20, total: 120 }, userMessages: 1, cost: 0.5, model: "m1" });
  ledger.addUsage(run.id, { tokens: { input: 160, output: 30, total: 190 }, userMessages: 2, cost: 0.6, model: "m1" });
  ledger.close();

  const restarted = new Ledger({ home });
  const back = restarted.getRun(run.id);
  assert.equal(back.state, "running");
  assert.equal(back.sessionId, "s1");
  assert.equal(back.text, "重启前");
  assert.equal(restarted.get("artifacts", "art1").path, "out.txt");
  assert.equal(restarted.lastSeq(), 1);
  assert.equal(restarted.eventsSince(0)[0].type, "run_created");
  assert.equal(restarted.usage().perRun[0].tokensIn, 60, "重启后仍是那条增量");
  assert.equal(restarted.appendEvent({ type: "run_updated", runId: run.id }).seq, 2);
  restarted.close();
});

// ---- Run 终态边界 ----

test("Run 边界：终态不可重开、同值幂等、改 id/createdAt 拒绝、过滤与 limit 校验", () => {
  const home = tmpHome();
  const ledger = new Ledger({ home });
  const run = ledger.createRun({
    id: "run-fixed",
    kind: "room",
    scope: "room:r1",
    roomId: "r1",
    text: "hi",
    attachmentIds: ["att1"],
    parentRunId: "parent-1",
    depth: 1,
    budget: { usd: 1 },
    taskId: "task-1",
  });
  assert.throws(() => ledger.createRun({ id: "run-fixed", kind: "chat", scope: "private", text: "dup" }), hasCode("LEDGER_CONFLICT"));
  assert.throws(() => ledger.updateRun("missing", { state: "running" }), hasCode("LEDGER_NOT_FOUND"));
  assert.equal(ledger.getRun("missing"), null);

  const same = ledger.updateRun(run.id, { state: "starting" });
  assert.equal(ledger.updateRun(run.id, { state: "starting" }).state, "starting", "同值 = 幂等空操作");
  assert.equal(same.createdAt, run.createdAt);
  assert.throws(() => ledger.updateRun(run.id, { state: "zombie" }), hasCode("LEDGER_INVALID"));
  assert.throws(() => ledger.updateRun(run.id, { id: "other" }), hasCode("LEDGER_INVALID"));
  assert.throws(() => ledger.updateRun(run.id, { createdAt: 1 }), hasCode("LEDGER_INVALID"));

  ledger.updateRun(run.id, { state: "running", sessionFile: "s.jsonl" });
  ledger.updateRun(run.id, { state: "completed", reply: "done" });
  assert.throws(() => ledger.updateRun(run.id, { state: "running" }), hasCode("LEDGER_IMMUTABLE"));
  assert.throws(() => ledger.updateRun(run.id, { state: "cancelled" }), hasCode("LEDGER_IMMUTABLE"));
  assert.equal(ledger.updateRun(run.id, { state: "completed" }).state, "completed");

  ledger.createRun({ kind: "chat", scope: "private", text: "other", botId: "b2" });
  assert.deepEqual(ledger.listRuns({ botId: "b2" }).map((r) => r.text), ["other"]);
  assert.deepEqual(ledger.listRuns({ botId: "b1" }), []);
  assert.deepEqual(ledger.listRuns({ roomId: "r1" }).map((r) => r.id), [run.id]);
  assert.deepEqual(ledger.listRuns({ state: ["completed", "failed"] }).map((r) => r.id), [run.id]);
  assert.deepEqual(ledger.listRuns({ state: "running" }), []);
  assert.throws(() => ledger.listRuns({ state: ["running", "zombie"] }), hasCode("LEDGER_INVALID"));
  assert.throws(() => ledger.listRuns({ state: [] }), hasCode("LEDGER_INVALID"));
  assert.throws(() => ledger.listRuns({ limit: 0 }), hasCode("LEDGER_INVALID"));
  assert.throws(() => ledger.listRuns({ limit: "10" }), hasCode("LEDGER_INVALID"));
  assert.equal(ledger.listRuns({ limit: 1e9 }).length, 2, "超上限截断而不是报错");
  ledger.close();
});

// ---- 事件 ----

test("事件：seq 全局单调、写失败不占号、按 run 过滤、超出窗口被裁剪且游标不回退", () => {
  const home = tmpHome();
  const ledger = new Ledger({ home });
  const a = ledger.createRun({ kind: "chat", scope: "private", text: "a" });
  const b = ledger.createRun({ kind: "chat", scope: "private", text: "b" });
  const seqs = [];
  for (let i = 0; i < 5; i++) {
    seqs.push(ledger.appendEvent({ type: "tick", runId: i % 2 === 0 ? a.id : b.id, botId: "b1", i }).seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);

  const cyclic = { type: "boom", runId: a.id };
  cyclic.self = cyclic; // 不可 JSON 序列化 → 事务回滚
  assert.throws(() => ledger.appendEvent(cyclic), hasCode("LEDGER_INVALID"));
  assert.equal(ledger.lastSeq(), 5, "回滚不消耗 seq");
  assert.equal(ledger.appendEvent({ type: "tick" }).seq, 6);

  const first = ledger.eventsSince(0)[0];
  assert.equal(first.type, "tick");
  assert.equal(first.i, 0);
  assert.equal(first.botId, "b1");
  assert.equal("runId" in ledger.eventsSince(5)[0], false, "缺省的可选字段不硬塞 null");
  assert.deepEqual(ledger.eventsSince(0, { runId: a.id }).map((e) => e.seq), [1, 3, 5]);
  assert.deepEqual(ledger.eventsSince(4).map((e) => e.seq), [5, 6]);
  assert.throws(() => ledger.eventsSince(-1), hasCode("LEDGER_INVALID"));
  assert.throws(() => ledger.eventsSince(0, { limit: 0 }), hasCode("LEDGER_INVALID"));

  // 越过窗口：只留最近 5000 条，lastSeq 由持久游标决定、不因裁剪回退
  for (let i = 0; i < 5000; i++) ledger.appendEvent({ type: "bulk", i });
  const kept = ledger.eventsSince(0, { limit: 5000 });
  assert.equal(ledger.lastSeq(), 5006);
  assert.equal(kept.length, 5000);
  assert.equal(kept[0].seq, 7, "最旧的事件已被裁掉");
  assert.equal(kept[4999].seq, 5006);
  assert.deepEqual(ledger.eventsSince(5000).map((e) => e.seq), [5001, 5002, 5003, 5004, 5005, 5006]);
  ledger.close();
});

test("事务：写失败整体回滚，不留半截 Run", () => {
  const home = tmpHome();
  const ledger = new Ledger({ home });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => ledger.createRun({ id: "cyc", kind: "chat", scope: "private", text: "x", budget: cyclic }),
    hasCode("LEDGER_INVALID"),
  );
  assert.equal(ledger.getRun("cyc"), null);
  assert.equal(ledger.listRuns().length, 0);

  const run = ledger.createRun({ kind: "chat", scope: "private", text: "ok" });
  assert.throws(() => ledger.updateRun(run.id, { stats: cyclic }), hasCode("LEDGER_INVALID"));
  const after = ledger.getRun(run.id);
  assert.equal(after.stats, null);
  assert.equal(after.updatedAt, run.updatedAt, "回滚后时间戳不变");
  ledger.close();
});

// ---- 只读 ----

test("只读台账：写入一律拒绝且磁盘不变，库不存在显式报错", () => {
  const home = tmpHome();
  const rw = new Ledger({ home });
  const run = rw.createRun({ kind: "chat", scope: "private", text: "x", botId: "b1" });
  rw.appendEvent({ type: "run_created", runId: run.id });
  rw.put("attachments", { id: "a1", filename: "f.png" });
  rw.close();

  const ro = new Ledger({ home, readonly: true });
  assert.equal(ro.getRun(run.id).id, run.id);
  assert.equal(ro.get("attachments", "a1").filename, "f.png");
  assert.equal(ro.lastSeq(), 1);
  assert.equal(ro.eventsSince(0).length, 1);
  assert.equal(ro.listRuns().length, 1);
  for (const call of [
    () => ro.createRun({ kind: "chat", scope: "private", text: "nope" }),
    () => ro.updateRun(run.id, { state: "running" }),
    () => ro.appendEvent({ type: "x" }),
    () => ro.put("artifacts", { id: "x" }),
    () => ro.remove("artifacts", "x"),
    () => ro.addUsage(run.id, { tokens: { input: 1 } }),
    () => ro.reconcile(),
  ]) {
    assert.throws(call, hasCode("LEDGER_READONLY"));
  }
  ro.close();
  ro.close(); // 关闭幂等

  const check = new Ledger({ home });
  assert.equal(check.getRun(run.id).state, "queued");
  assert.equal(check.lastSeq(), 1);
  assert.equal(check.list("attachments").length, 1);
  assert.equal(check.usage().perRun.length, 0);
  check.close();

  const missing = tmpHome();
  assert.throws(() => new Ledger({ home: join(missing, "nope"), readonly: true }), hasCode("LEDGER_DB_MISSING"));
  assert.equal(existsSync(join(missing, "nope", "workbench.sqlite")), false, "只读不应建库");
});

// ---- 单写者锁 ----

test("锁：同进程两个实例只有一个能写，输家不改内存/磁盘也不删别人的锁", () => {
  const home = tmpHome();
  const first = new Store({ home });
  first.load();
  assert.equal(first.acquireLock(), true);
  const bot = makeBot({ id: "b1", name: "b1" });
  first.putBot(bot);
  const diskBefore = readFileSync(join(home, "state.json"), "utf8");

  const second = new Store({ home }); // 输家在写盘之后加载，才验证得到「只读仍读得到真数据」
  second.load();
  assert.equal(second.getBot(bot.id).name, "b1", "只读也能读到真实花名册");
  assert.equal(second.acquireLock(), false, "同进程另一个实例也是活着的持有者");
  assert.equal(second.readonly, true);
  const lockText = readFileSync(join(home, "state.lock"), "utf8");
  assert.equal(second.acquireLock(), false, "再试一次结果不变");
  assert.equal(readFileSync(join(home, "state.lock"), "utf8"), lockText, "拿不到锁不该改锁文件");

  assert.throws(() => second.putBot(makeBot({ id: "b2", name: "B" })), /只读/);
  assert.equal(second.getBot("b2"), null, "拒绝必须在改内存之前");
  assert.throws(() => second.appendChat("b1", { role: "user", text: "x" }), /只读/);
  assert.deepEqual(second.getChat("b1"), []);
  assert.throws(() => second.recordExchange({ id: "e1" }), /只读/);
  assert.equal(second.state.exchanges.length, 0);
  assert.throws(() => second.save(), /只读/);
  assert.equal(second.listBots().map((b) => b.id).join(","), "b1", "只读仍可读");
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), diskBefore, "只读不该写盘");

  second.releaseLock(); // 只读方不得删别人的锁
  assert.equal(existsSync(join(home, "state.lock")), true);
  first.releaseLock();
  assert.equal(existsSync(join(home, "state.lock")), false);
  assert.equal(second.acquireLock(), true, "持有者释放后输家可接管");
  second.putBot(makeBot({ id: "b3", name: "C" }));
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).bots.b3.name, "C");
  second.releaseLock();
});

test("锁：陈旧锁回收竞争只有一个赢家（两个实例 + 真实子进程）", async () => {
  const home = tmpHome();
  const script = join(tmpHome(), "lockchild.mjs");
  writeFileSync(script, lockRaceScript(), "utf8");

  // 预置一把陈旧锁（持有进程已死），两个实例同时回收，只能有一个赢
  const stalePid = await deadPid();
  writeFileSync(
    join(home, "state.lock"),
    JSON.stringify({ pid: stalePid, nonce: "stale-nonce", startedAt: Date.now() }),
    "utf8",
  );
  const one = new Store({ home });
  const two = new Store({ home });
  one.load();
  two.load();
  const results = [one.acquireLock(), two.acquireLock()];
  assert.equal(results.filter(Boolean).length, 1, "陈旧锁只能被一个实例回收");
  const winner = results[0] ? one : two;
  const loser = results[0] ? two : one;
  assert.equal(loser.readonly, true);
  assert.throws(() => loser.putBot({ id: "loser", name: "L" }), /只读/);
  assert.equal(winner.putBot({ id: "winner", name: "W" }), undefined);
  assert.equal(JSON.parse(readFileSync(join(home, "state.lock"), "utf8")).nonce, winner.lockNonce);
  assert.equal(JSON.parse(readFileSync(join(home, "state.lock"), "utf8")).pid, process.pid);
  winner.releaseLock();

  // 真实子进程竞争同一 home（场上先有一把死 pid 的陈旧锁）：恰好一个 WIN
  const home2 = tmpHome();
  writeFileSync(
    join(home2, "state.lock"),
    JSON.stringify({ pid: await deadPid(), nonce: "stale-nonce", startedAt: Date.now() }),
    "utf8",
  );
  const lines = await raceForLock(home2, { count: 4, scriptPath: script });
  assert.deepEqual(lines.slice().sort(), ["LOSE", "LOSE", "LOSE", "WIN"], "多进程抢陈旧锁只能有一个赢家");
  const fresh = new Store({ home: home2 });
  fresh.load();
  assert.equal(fresh.acquireLock(), true, "赢家退出后锁可接管");

  // 崩溃释放：抢到锁的进程被 kill（不 releaseLock），别人随即能拿，且不是两个写者
  const home3 = tmpHome();
  const holder = await holdLockChild(home3, script);
  const blocked = new Store({ home: home3 });
  blocked.load();
  assert.equal(blocked.acquireLock(), false, "持有者还活着 → 只读");
  await killAndWait(holder);
  assert.equal(blocked.acquireLock(), true, "持有进程被 kill 后锁立即可回收");
  blocked.releaseLock();

  // 活着的旧版进程只留 pid、没有 nonce：也必须让位
  const home4 = tmpHome();
  const legacy = await holdLockChild(home4, script);
  writeFileSync(
    join(home4, "state.lock"),
    JSON.stringify({ pid: legacy.pid, startedAt: Date.now() }),
    "utf8",
  );
  const courteous = new Store({ home: home4 });
  courteous.load();
  assert.equal(courteous.acquireLock(), false, "活着的旧版持有者（无 nonce）也要让位");
  await killAndWait(legacy);
});

// ---- 迁移备份 ----

test("迁移：load 不写盘，首次落盘前备份原件，session 数据一个不删", () => {
  const home = tmpHome();
  const legacy = { version: 0, bots: { b1: { id: "b1", name: "旧" } }, rooms: {}, exchanges: [], chats: {} };
  writeFileSync(join(home, "state.json"), JSON.stringify(legacy), "utf8");
  const sessionFile = join(home, "bots", "b1", "private", "sessions", "s.jsonl");
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");

  const store = new Store({ home });
  store.load();
  assert.equal(store.state.version, STATE_VERSION);
  assert.deepEqual(store.state.bots.b1, { id: "b1", name: "旧" });
  const backup = join(home, "state.json.bak");
  assert.equal(existsSync(backup), false, "只读加载不写盘");
  store.putBot({ id: "b2", name: "新" });
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), legacy, "备份必须是迁移前原件");
  assert.equal(readFileSync(sessionFile, "utf8"), '{"type":"session"}\n', "迁移不得动 session 数据");
  store.putBot({ id: "b3", name: "更" });
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), legacy, "已有备份不被二次迁移覆盖");

  const ledger = new Ledger({ home });
  ledger.createRun({ kind: "chat", scope: "private", text: "x" });
  assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), legacy);
  assert.equal(readFileSync(sessionFile, "utf8"), '{"type":"session"}\n');
  ledger.close();

  const home2 = tmpHome();
  const legacy2 = { version: 0, bots: {}, rooms: {}, exchanges: [], chats: {} };
  writeFileSync(join(home2, "state.json"), JSON.stringify(legacy2), "utf8");
  const ledger2 = new Ledger({ home: home2 });
  assert.deepEqual(JSON.parse(readFileSync(join(home2, "state.json.bak"), "utf8")), legacy2, "Ledger 建库前也要留底");
  ledger2.close();

  const home3 = tmpHome();
  const ledger3 = new Ledger({ home: home3 });
  ledger3.close();
  assert.equal(existsSync(join(home3, "state.json.bak")), false, "没有 state.json 时不造备份");
});

// ---- 中断恢复 ----

test("对账：非终态落 interrupted，副作用在飞落 reconciliation_required 且不重放", () => {
  const home = tmpHome();
  let ledger = new Ledger({ home });
  const mk = (state) => {
    const run = ledger.createRun({ kind: "chat", scope: "private", text: state });
    if (state !== "queued") ledger.updateRun(run.id, { state });
    return run.id;
  };
  const queued = mk("queued");
  const starting = mk("starting");
  const running = mk("running");
  const waitingInput = mk("waiting_input");
  const waitingApproval = mk("waiting_approval");
  const cancelling = mk("cancelling");
  const done = mk("completed");
  const publishing = ledger.createRun({ kind: "delegation", scope: "private", text: "外发" });
  ledger.updateRun(publishing.id, {
    state: "running",
    sideEffects: [
      { id: "se1", kind: "publish", target: "远端", status: "in_flight" },
      { id: "se0", kind: "upload", status: "done" },
    ],
  });
  const settled = ledger.createRun({ kind: "delegation", scope: "private", text: "副作用已落定" });
  ledger.updateRun(settled.id, { state: "cancelling", sideEffects: [{ id: "se2", status: "done" }] });
  ledger.appendEvent({ type: "run_created", runId: running });
  const seqBefore = ledger.lastSeq();
  const eventsBefore = ledger.eventsSince(0).map((e) => ({ seq: e.seq, type: e.type, runId: e.runId ?? null }));
  const idsBefore = ledger
    .listRuns()
    .map((r) => r.id)
    .sort();

  const res = ledger.reconcile();
  assert.deepEqual(
    [...res.interrupted].sort(),
    [queued, starting, running, waitingInput, waitingApproval, cancelling, settled.id].sort(),
  );
  assert.deepEqual(res.reconciliationRequired, [publishing.id]);
  assert.equal(ledger.getRun(waitingInput).state, "interrupted");
  assert.equal(ledger.getRun(waitingApproval).state, "interrupted");
  assert.equal(ledger.getRun(cancelling).state, "interrupted");
  assert.equal(ledger.getRun(settled.id).state, "interrupted");
  assert.equal(ledger.getRun(done).state, "completed", "终态不被对账改写");
  const rec = ledger.getRun(publishing.id);
  assert.equal(rec.state, "reconciliation_required");
  assert.equal(rec.recovery.status, RECOVERY_UNKNOWN);
  // 历史不丢：既有事件按 seq 原样保留（对账不删改），Run 一个不少
  assert.deepEqual(
    ledger
      .eventsSince(0)
      .filter((e) => e.seq <= seqBefore)
      .map((e) => ({ seq: e.seq, type: e.type, runId: e.runId ?? null })),
    eventsBefore,
    "对账不得删改既有事件",
  );
  assert.deepEqual(
    ledger
      .listRuns()
      .map((r) => r.id)
      .sort(),
    idsBefore,
    "对账不删 Run",
  );
  assert.deepEqual(ledger.reconcile(), { interrupted: [], reconciliationRequired: [] }, "重复对账幂等");
  assert.throws(() => ledger.updateRun(running, { state: "running" }), hasCode("LEDGER_IMMUTABLE"));
  assert.throws(() => ledger.updateRun(publishing.id, { state: "failed" }), hasCode("LEDGER_IMMUTABLE"));

  ledger.close();
  ledger = new Ledger({ home });
  assert.equal(ledger.getRun(running).state, "interrupted", "对账结论跨重启保留");
  assert.equal(ledger.getRun(publishing.id).state, "reconciliation_required");
  ledger.close();
});

// ---- 用量差值 ----

test("用量：只落本 Run 增量，同会话跨 Run 不重复计，切换会话不为负", () => {
  const home = tmpHome();
  const ledger = new Ledger({ home });
  const r1 = ledger.createRun({ kind: "chat", scope: "private", text: "r1", botId: "b1" });
  ledger.updateRun(r1.id, { state: "running", sessionId: "s1", sessionFile: "s1.jsonl" });
  const base = ledger.addUsage(r1.id, { tokens: { input: 1000, output: 100, total: 1100 }, userMessages: 5, cost: 0.5, model: "m1" });
  assert.equal(base.baseline, true);
  assert.equal(ledger.usage().perRun[0].tokensIn, 0, "基线本身不是增量");

  const d1 = ledger.addUsage(r1.id, { tokens: { input: 1300, output: 180, total: 1480 }, userMessages: 7, cost: 0.75, model: "m1", toolCalls: 4 });
  assert.equal(d1.delta.tokensIn, 300);
  assert.equal(d1.delta.tokensOut, 80);
  assert.equal(d1.delta.totalTokens, 380);
  assert.equal(d1.delta.requests, 2);
  assert.equal(d1.delta.toolCalls, 4);
  assert.equal(d1.model, "m1");

  const r2 = ledger.createRun({ kind: "chat", scope: "private", text: "r2", botId: "b1" });
  ledger.updateRun(r2.id, { state: "running", sessionId: "s1", sessionFile: "s1.jsonl" });
  const d2 = ledger.addUsage(r2.id, { tokens: { input: 1500, output: 200, total: 1700 }, userMessages: 8, cost: 0.8, model: "m1" });
  assert.equal(d2.delta.tokensIn, 200, "从上一个快照继续，不把整段会话累计算给本 Run");
  assert.equal(d2.delta.totalTokens, 220);

  ledger.updateRun(r2.id, { sessionId: "s2", sessionFile: "s2.jsonl" });
  const d3 = ledger.addUsage(r2.id, { tokens: { input: 50, output: 5, total: 55 }, userMessages: 1, cost: 0.02, model: "m2" });
  assert.equal(d3.delta.tokensIn, 0, "会话切换累计回退 → 增量不为负");
  assert.equal(d3.model, "m2");

  const r3 = ledger.createRun({ kind: "chat", scope: "private", text: "r3" });
  ledger.updateRun(r3.id, { state: "completed" });
  const only = ledger.addUsage(r3.id, { tokens: { input: 10, output: 2, total: 12 }, userMessages: 1 });
  assert.equal(only.baseline, false);
  assert.equal(only.delta.tokensIn, 10, "只调一次收尾时按整笔落");

  const usage = ledger.usage();
  const pick = (runId, model) => usage.perRun.find((r) => r.runId === runId && r.model === model);
  assert.equal(pick(r1.id, "m1").tokensIn, 300);
  assert.equal(pick(r1.id, "m1").costKnown, true);
  assert.equal(pick(r2.id, "m2").costKnown, true);
  assert.equal(pick(r3.id, null).costKnown, false, "没记到价格时标未知，不假装 0 是真实花费");
  assert.equal(usage.totals.tokensIn, 300 + 200 + 0 + 10);
  assert.equal(usage.totals.totalTokens, 380 + 220 + 0 + 12);
  assert.equal(approx(usage.totals.cost, 0.3), true);
  assert.equal(usage.totals.costKnown, false);
  assert.throws(() => ledger.addUsage("missing", {}), hasCode("LEDGER_NOT_FOUND"));
  ledger.close();

  const restarted = new Ledger({ home });
  assert.equal(restarted.usage().totals.tokensIn, usage.totals.tokensIn, "差值跨重启不变");
  restarted.close();
});

// ---- 运行 ----

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`);
  }
}

for (const dir of homes) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${tests.length - failed}/${tests.length} 通过`);
if (failed) process.exitCode = 1;

// 04 号票实机证据：真实 omp 18.10.3 + mnemopi + multilingual-e5-large。
// 私聊 4 轮后自动存档进 team/.memory/mnemopi.db 的 bot-<id> bank；同一个 bot 在群里开新会话，
// 首轮自动召回把私聊里说的事带进来；另一个 bot 读不到。子进程环境里没有 PI_CODING_AGENT_DIR。
// 需要 mock-llm 在 18080 端口（只回 "ok"）。运行：
//   HOME=/data/omp-lab/home PATH=<omp>:$PATH node .scratch/team-rebuild/proof/memory-e2e.mjs
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Orchestrator } from "../../../src/orchestrator.mjs";

const LOG = process.env.MOCK_LOG ?? "/data/omp-lab/requests.jsonl";
const home = mkdtempSync(join(tmpdir(), "ompbot-memory-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chatBodies = () =>
  readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.url.includes("chat/completions")).map((x) => JSON.stringify(x.body));
const userAgentMem = join(homedir(), ".omp", "agent", "memories");
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = statSync(p).mtimeMs;
    }
  };
  walk(dir);
  return out;
};
const rows = (dbPath, bank) => {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT session_id, content, scope FROM working_memory WHERE session_id = ?").all(bank);
  } finally {
    db.close();
  }
};

const out = { omp: execFileSync("omp", ["--version"]).toString().trim(), at: new Date().toISOString(), checks: {}, notes: {} };
const before = snapshot(userAgentMem);
const orch = new Orchestrator({ home, bin: "omp" });
try {
  const a = orch.addBot({ name: "小记", model: "mock/m1", memoryEnabled: true });
  const b = orch.addBot({ name: "旁人", model: "mock/m1", memoryEnabled: true });
  const dbPath = join(home, "team", ".memory", "mnemopi.db");
  const bankA = `bot-${a.id}`;

  // 1) 私聊 4 轮（retainEveryNTurns 默认 4），第一轮说一件具体的事
  writeFileSync(LOG, "");
  const t0 = Date.now();
  const privateTexts = ["我家的猫叫年糕，最爱吃三文鱼罐头。", "今天天气不错。", "帮我记一下周三下午开会。", "好的，就这些。"];
  for (const text of privateTexts) {
    const run = await orch.waitRun(orch.startRun({ botId: a.id, text }).id);
    if (run.state !== "completed") throw new Error(`私聊回合失败：${run.state} ${run.error ?? ""}`);
  }
  out.notes.privateTurnsMs = Date.now() - t0;
  const sentPrivate = chatBodies();
  out.checks.privateTagSent = sentPrivate.some((b) => b.includes("[私聊，用户]\\n我家的猫叫年糕"));

  const rtA = orch.runtimes.get(`${a.id}::private`);
  out.checks.noAgentDirEnv = !!rtA && !("PI_CODING_AGENT_DIR" in (rtA.env ?? {})) && !("PI_CODING_AGENT_DIR" in (rtA.rpc?.env ?? {}));

  // 存档在 agent_end 后异步做，等它落库
  let saved = [];
  for (let i = 0; i < 60 && !saved.some((r) => r.content.includes("年糕")); i++) {
    await sleep(1000);
    saved = rows(dbPath, bankA);
  }
  out.checks.retainedIntoTeamDb = saved.some((r) => r.content.includes("年糕"));
  out.checks.retainedWithSourceTag = saved.some((r) => r.content.includes("[私聊，用户]"));
  out.checks.rowsScopedToBank = saved.length > 0 && saved.every((r) => r.scope !== "global");
  out.checks.noBanksSubdir = !existsSync(join(home, "team", ".memory", "banks"));
  out.notes.savedRows = saved.length;
  out.notes.savedSample = saved[0]?.content.slice(0, 300);

  // 2) 状态面能边跑边读（omp 进程开着库）
  const mem = orch.features.native.memoryRead(a.id);
  out.checks.statusReadsLiveDb = mem.dbExists && mem.counts.working >= 1 && mem.memories.some((m) => m.content.includes("年糕")) && !mem.readError;

  // 3) 同一个 bot 进群：群聊是新会话，首轮自动召回把私聊里的事带进来（问法换了，没提猫和年糕）
  const room = orch.createRoom({ name: "产品群", members: [a.id], adminId: a.id });
  writeFileSync(LOG, "");
  const t1 = Date.now();
  await orch.postToRoom(room.id, "宠物平时喜欢吃点啥？", { userName: "张三" });
  out.notes.roomTurnMs = Date.now() - t1;
  const sentRoom = chatBodies();
  out.checks.roomTagSent = sentRoom.some((b) => b.includes("[群聊，产品群]"));
  out.checks.roomRecallsPrivateMemory = sentRoom.some((b) => b.includes("年糕"));
  out.notes.roomRecallSnippet = (() => {
    const hit = sentRoom.find((b) => b.includes("年糕"));
    if (!hit) return null;
    const i = hit.indexOf("年糕");
    return hit.slice(Math.max(0, i - 200), i + 100);
  })();

  // 4) 另一个 bot 同一个库文件，读不到小记的记忆
  writeFileSync(LOG, "");
  const runB = await orch.waitRun(orch.startRun({ botId: b.id, text: "宠物平时喜欢吃点啥？" }).id);
  out.checks.otherBotCompleted = runB.state === "completed";
  out.checks.otherBotCannotRecall = !chatBodies().some((b) => b.includes("年糕"));
  out.checks.otherBotStatusEmpty = !orch.features.native.memoryRead(b.id).memories.some((m) => m.content.includes("年糕"));

  // 5) 用户自己 omp 的记忆目录没被碰
  const after = snapshot(userAgentMem);
  const changed = Object.keys(after).filter((p) => before[p] !== after[p]);
  out.checks.userMemoryUntouched = changed.length === 0;
  out.notes.userMemoryChanged = changed;
  out.overlay = readFileSync(join(home, "bots", a.id, "private", "isolate.yml"), "utf8")
    .split("\n").filter((l) => /backend|mnemopi|scoping|bank|dbPath|embedding|autolearn|enabled: false|modelRoles|default:|smol:|memory:/.test(l))
    .map((l) => l.replace(home, "<home>"));
  out.notes.dbFiles = readdirSync(join(home, "team", ".memory"));
  out.notes.gitignored = execFileSync("git", ["check-ignore", ".memory/mnemopi.db"], { cwd: join(home, "team"), encoding: "utf8" }).trim();
} finally {
  await orch.shutdown();
  rmSync(home, { recursive: true, force: true });
}
out.pass = Object.values(out.checks).every((v) => v === true);
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);

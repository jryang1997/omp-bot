// test/real/harness.mjs — 在真 omp 上起一套 omp-bot：独立的 OMPBOT_HOME 和 PI_CODING_AGENT_DIR，不碰用户自己的配置。
// real-omp.mjs（脚本假模型）和 real-model.mjs（免费真模型）共用。
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readServerDescriptor } from "../../src/server.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const DONE = new Set(["completed", "failed", "cancelled", "interrupted", "timed_out"]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toolEnds = (evs, name) => evs.filter((e) => e.event?.type === "tool_execution_end" && (!name || e.event.toolName === name));
export const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "");
export const toolText = (e) => (e.event.result?.content ?? []).map((p) => p.text ?? "").join("");

/** 没装 omp 返回 null。 */
export function ompVersion() {
  try { return execFileSync("omp", ["--version"], { encoding: "utf8" }).trim(); } catch { return null; }
}

export async function world({ modelsYml, model, cheapModel = model }) {
  const root = mkdtempSync(join(homedir(), ".ompbot-real-")); // 不放系统临时目录：那里是写文件边界的放行区
  const w = { root, home: join(root, "home"), agentDir: join(root, "agent"), proj: join(root, "proj"), outside: join(root, "outside"), desc: null, server: null };
  for (const d of [w.agentDir, w.proj, w.outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(w.agentDir, "models.yml"), modelsYml);
  w.env = { ...process.env, OMPBOT_HOME: w.home, PI_CODING_AGENT_DIR: w.agentDir, NODE_NO_WARNINGS: "1" };
  w.cli = (...args) => execFileSync(process.execPath, ["ompbot.mjs", ...args], { cwd: REPO, env: w.env, encoding: "utf8" });
  w.ada = /\((bot_[^)]+)\)/.exec(w.cli("bots", "add", "Ada", "--role", "测试", "--main", "--model", model))[1];
  w.cli("settings", "set", "Ada", "--permission", "ask", "--workspace", w.proj);
  w.bo = /\((bot_[^)]+)\)/.exec(w.cli("bots", "add", "Bo", "--role", "便宜跑腿", "--model", cheapModel))[1];

  w.startServer = async () => {
    w.server = spawn(process.execPath, ["ompbot.mjs", "serve", "--no-open", "--port", "0"], { cwd: REPO, env: w.env, detached: true, stdio: "ignore" });
    for (let i = 0; i < 100 && !w.desc; i++) { await sleep(200); w.desc = await readServerDescriptor(w.home); }
    if (!w.desc) throw new Error("服务没起来");
  };
  w.killServer = () => {
    try { process.kill(-w.server.pid, "SIGKILL"); } catch {}
    w.desc = null;
  };
  w.api = async (method, path, body) => {
    const r = await fetch(w.desc.url + path, { method, headers: { Authorization: `Bearer ${w.desc.token}`, "content-type": "application/json", origin: w.desc.url }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} ${r.status} ${t.slice(0, 300)}`), { status: r.status });
    return JSON.parse(t);
  };
  w.getRun = async (id) => (await w.api("GET", `/api/runs/${id}`)).run;
  w.events = async (id) => (await w.api("GET", `/api/events/history?runId=${id}&limit=5000`)).events;
  /** 跑一次，碰到审批卡就交给 answer(card) 决定回什么。 */
  w.run = async (text, answer = () => null, { polls = 400, botId = w.ada } = {}) => {
    const { run: r } = await w.api("POST", "/api/runs", { botId, text });
    const cards = [];
    for (let i = 0; i < polls; i++) {
      for (const a of (await w.api("GET", "/api/approvals")).approvals) {
        if (a.runId !== r.id || cards.some((c) => c.id === a.id)) continue;
        cards.push(a);
        const resp = answer(a);
        if (resp) await w.api("POST", `/api/approvals/${a.id}/respond`, resp);
      }
      const now = await w.getRun(r.id);
      if (DONE.has(now.state)) return { run: now, cards, events: await w.events(r.id) };
      await sleep(250);
    }
    await w.api("POST", `/api/runs/${r.id}/cancel`, {}).catch(() => {}); // 别让后面的用例撞上 target_busy
    throw new Error(`run ${r.id} 没结束`);
  };
  w.close = () => {
    if (w.server) w.killServer();
    rmSync(root, { recursive: true, force: true });
  };
  return w;
}

/** REAL_ONLY=片段[,片段] 只跑名字里带其中一个的用例。 */
export function tester() {
  const s = { passed: 0, failed: 0 };
  s.test = async (name, fn) => {
    if (process.env.REAL_ONLY && !process.env.REAL_ONLY.split(",").some((f) => name.includes(f))) return;
    try { await fn(); s.passed++; console.log(`PASS  ${name}`); }
    catch (e) { s.failed++; console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`); }
  };
  return s;
}

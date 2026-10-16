// 01 号票实机证据：真实 omp 18.10.3 以 team/bots/<id> 为 cwd 启动时，系统提示词里有哪些层。
// 需要 mock-llm 在 18080 端口（.scratch/team-architecture/omp-lab/mock-llm.mjs），
// HOME 指向带 mock 提供方的隔离目录（其中用户级 AGENTS.md 放了 USER-LEVEL-AGENTS-MARKER，不应被读到）。
// 运行：HOME=/data/omp-lab/home PATH=<omp 所在目录>:$PATH node .scratch/team-rebuild/proof/context-e2e.mjs
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator } from "../../../src/orchestrator.mjs";

const LOG = process.env.MOCK_LOG ?? "/data/omp-lab/requests.jsonl";
const home = mkdtempSync(join(tmpdir(), "ompbot-e2e-"));
const lastRequest = () => {
  const reqs = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.url.includes("chat/completions"));
  return reqs.at(-1).body.messages;
};
const systemOf = (messages) =>
  messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""))).join("\n");
const userTexts = (messages) =>
  messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("")));

const out = { omp: execFileSync("omp", ["--version"]).toString().trim(), at: new Date().toISOString(), checks: {} };
const orch = new Orchestrator({ home, bin: "omp" });
try {
  const bot = orch.addBot({ name: "小智", role: "产品", instructions: "BOT-INSTR-MARKER", model: "mock/m1" });
  writeFileSync(LOG, "");
  const r1 = await orch.waitRun(orch.startRun({ botId: bot.id, text: "FIRST-TURN-MARKER" }).id);
  const sys1 = systemOf(lastRequest());
  const teamAt = sys1.indexOf("# 团队共识");
  const botAt = sys1.indexOf("- 名字：小智");
  out.checks.firstRun = r1.state;
  out.checks.teamLayer = teamAt >= 0;
  out.checks.botLayer = botAt >= 0 && sys1.includes("BOT-INSTR-MARKER");
  out.checks.teamBeforeBot = teamAt >= 0 && botAt > teamAt;
  out.checks.personaHasTeamTools = sys1.includes("message_bot");
  out.checks.userLevelAgentsBlocked = !sys1.includes("USER-LEVEL-AGENTS-MARKER");
  out.checks.cwd = sys1.includes(join(home, "team", "bots", bot.id));

  // 文件里改身份块外的内容：下一轮重启进程，新内容进系统提示词，会话续上
  const file = join(home, "team", "bots", bot.id, "AGENTS.md");
  writeFileSync(file, readFileSync(file, "utf8") + "\nBOT-NOTE-MARKER\n", "utf8");
  writeFileSync(LOG, "");
  const r2 = await orch.waitRun(orch.startRun({ botId: bot.id, text: "SECOND-TURN-MARKER" }).id);
  const msgs2 = lastRequest();
  out.checks.secondRun = r2.state;
  out.checks.editedFileReachesPrompt = systemOf(msgs2).includes("BOT-NOTE-MARKER");
  out.checks.sessionContinued = userTexts(msgs2).some((t) => t.includes("FIRST-TURN-MARKER"));
  await orch.team.flush();
  out.gitLog = execFileSync("git", ["log", "--format=%s"], { cwd: join(home, "team"), encoding: "utf8" }).trim().split("\n");
  out.sessions = execFileSync("find", [join(home, "team", "bots", bot.id, "sessions"), "-name", "*.jsonl"], { encoding: "utf8" }).trim().split("\n").map((p) => p.slice(home.length));
} finally {
  await orch.shutdown();
  rmSync(home, { recursive: true, force: true });
}
out.pass = Object.values(out.checks).every((v) => v === true || v === "completed");
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);

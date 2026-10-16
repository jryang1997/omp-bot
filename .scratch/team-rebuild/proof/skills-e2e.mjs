// 03 号票实机证据：真实 omp 18.10.3 从 team/skills 发现共享技能，按白名单加载，私有技能总是加载。
// 需要 mock-llm 在 18080 端口。运行：HOME=/data/omp-lab/home PATH=<omp>:$PATH node .scratch/team-rebuild/proof/skills-e2e.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator } from "../../../src/orchestrator.mjs";

const LOG = process.env.MOCK_LOG ?? "/data/omp-lab/requests.jsonl";
const home = mkdtempSync(join(tmpdir(), "ompbot-skills-e2e-"));
const skill = (name) => `---\nname: ${name}\ndescription: SKILL-${name}-MARKER\n---\n\n${name} 的做法\n`;
const systemOfLast = () => {
  const r = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.url.includes("chat/completions")).at(-1);
  return r.body.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""))).join("\n");
};
const seen = (sys) => ["周报", "画图", "私房菜", "天气"].filter((n) => sys.includes(`SKILL-${n}-MARKER`));
const turn = async (orch, botId, text) => {
  writeFileSync(LOG, "");
  const run = await orch.waitRun(orch.startRun({ botId, text }).id);
  return { state: run.state, skills: seen(systemOfLast()) };
};
const out = { omp: execFileSync("omp", ["--version"]).toString().trim(), at: new Date().toISOString(), checks: {}, turns: {} };
const orch = new Orchestrator({ home, bin: "omp" });
try {
  const all = orch.addBot({ name: "全都要", model: "mock/m1" });
  const picky = orch.addBot({ name: "挑着用", model: "mock/m1", permission: "ask", skills: ["周报"] });
  orch.installSkill({ botId: all.id, target: "library", content: skill("周报") });
  orch.installSkill({ botId: all.id, target: "library", content: skill("画图") });
  orch.installSkill({ botId: picky.id, target: "bot", content: skill("私房菜") });

  out.turns.all1 = await turn(orch, all.id, "第一轮");
  out.turns.picky = await turn(orch, picky.id, "第一轮");
  orch.installSkill({ botId: picky.id, target: "library", content: skill("天气") });
  out.turns.all2 = await turn(orch, all.id, "装了新技能之后");
  out.turns.picky2 = await turn(orch, picky.id, "装了新技能之后");

  const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  out.checks.nullSeesWholeLibrary = eq(out.turns.all1.skills, ["周报", "画图"]);
  out.checks.whitelistPlusPrivate = eq(out.turns.picky.skills, ["周报", "私房菜"]);
  out.checks.newLibrarySkillNextTurn = eq(out.turns.all2.skills, ["周报", "画图", "天气"]);
  out.checks.installerWhitelistGrows = eq(out.turns.picky2.skills, ["周报", "私房菜", "天气"]);
  out.checks.allCompleted = Object.values(out.turns).every((t) => t.state === "completed");
  out.overlay = readFileSync(join(home, "bots", all.id, "private", "isolate.yml"), "utf8").split("\n").filter((l) => l.includes("customDirectories") || l.includes("team/skills")).map((l) => l.replace(home, "<home>"));
  await orch.team.flush();
  out.gitLog = execFileSync("git", ["log", "--format=%s"], { cwd: join(home, "team"), encoding: "utf8" }).trim().split("\n");
} finally {
  await orch.shutdown();
  rmSync(home, { recursive: true, force: true });
}
out.pass = Object.values(out.checks).every((v) => v === true);
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);

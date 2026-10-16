// 02 号票实机证据：旧版造的数据，新版第一次启动复制进 team，bot 续上原来的对话。
// 需要 mock-llm 在 18080 端口；旧代码检出在 OLD_REPO（git worktree add /tmp/old-ompbot 2631e32）。
// 运行：HOME=/data/omp-lab/home PATH=<omp>:$PATH OLD_REPO=/tmp/old-ompbot node .scratch/team-rebuild/proof/migrate-e2e.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator } from "../../../src/orchestrator.mjs";
import { MIGRATION_MARKER, OLD_MEMORY_NOTE } from "../../../src/team.mjs";

const LOG = process.env.MOCK_LOG ?? "/data/omp-lab/requests.jsonl";
const OLD_REPO = process.env.OLD_REPO ?? "/tmp/old-ompbot";
const home = mkdtempSync(join(tmpdir(), "ompbot-mig-e2e-"));
const requests = () => readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.url.includes("chat/completions"));
const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));
const out = { omp: execFileSync("omp", ["--version"]).toString().trim(), at: new Date().toISOString(), checks: {} };
try {
  const made = JSON.parse(execFileSync("node", [new URL("./migrate-e2e-old.mjs", import.meta.url).pathname, OLD_REPO, home], { encoding: "utf8" }).trim().split("\n").at(-1));
  out.old = { ...made, cwd: made.cwd?.slice(home.length) };
  out.checks.oldRun = made.state;
  out.checks.noTeamBefore = !existsSync(join(home, "team"));
  const orch = new Orchestrator({ home, bin: "omp" });
  try {
    const id = made.botId;
    const cwd = join(home, "team", "bots", id);
    out.checks.markerWritten = existsSync(join(home, "team", MIGRATION_MARKER));
    out.checks.workCopied = readFileSync(join(cwd, "work", "old-notes.md"), "utf8").includes("旧版私聊");
    out.checks.memoryCopied = readFileSync(join(cwd, "work", "old-memory", "private", "memory_summary.md"), "utf8").includes("OLD-MEMORY-MARKER");
    out.checks.oldLeftInPlace = existsSync(join(home, "bots", id, "private", "work", "old-notes.md"));
    writeFileSync(LOG, "");
    const run = await orch.waitRun(orch.startRun({ botId: id, text: "NEW-TURN-MARKER 暗号是什么" }).id);
    const msgs = requests().at(-1).body.messages;
    const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map(textOf).join("\n");
    const users = msgs.filter((m) => m.role === "user").map(textOf);
    out.checks.newRun = run.state;
    out.checks.sessionContinued = users.some((t) => t.includes("OLD-TURN-MARKER")) && users.some((t) => t.includes("NEW-TURN-MARKER"));
    out.checks.oldMemoryNoteInPrompt = system.includes(OLD_MEMORY_NOTE);
    out.checks.newCwd = system.includes(cwd) && orch.runtimes.get(`${id}::private`)?.cwd === cwd;
    await orch.team.flush();
    out.gitLog = execFileSync("git", ["log", "--format=%s"], { cwd: join(home, "team"), encoding: "utf8" }).trim().split("\n");
    out.sessions = execFileSync("find", [join(cwd, "sessions"), "-name", "*.jsonl"], { encoding: "utf8" }).trim().split("\n").map((p) => p.slice(home.length));
  } finally {
    await orch.shutdown();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
out.pass = Object.values(out.checks).every((v) => v === true || v === "completed");
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);

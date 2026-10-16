// 02 号票实机证据第一步：用升级前的代码（2631e32）造一份旧数据。
// 运行：HOME=/data/omp-lab/home PATH=<omp>:$PATH node migrate-e2e-old.mjs <旧代码目录> <home>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [oldRepo, home] = process.argv.slice(2);
const { Orchestrator } = await import(join(oldRepo, "src/orchestrator.mjs"));
const orch = new Orchestrator({ home, bin: "omp" });
try {
  const bot = orch.addBot({ name: "老王", role: "写手", model: "mock/m1" });
  const run = await orch.waitRun(orch.startRun({ botId: bot.id, text: "OLD-TURN-MARKER 记住暗号是青蛙" }).id);
  const base = join(home, "bots", bot.id, "private");
  writeFileSync(join(base, "work", "old-notes.md"), "旧版私聊里写的笔记\n");
  const mem = join(base, "agent", "memories", "--old-work--");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "memory_summary.md"), "OLD-MEMORY-MARKER 用户喜欢简短回复\n");
  console.log(JSON.stringify({ botId: bot.id, state: run.state, cwd: orch.runtimes.get(`${bot.id}::private`)?.cwd }));
} finally {
  await orch.shutdown();
}
process.exit(0);

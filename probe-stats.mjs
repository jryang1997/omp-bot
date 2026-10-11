// probe-stats.mjs — 一次性探针：dump get_session_stats / get_state 的真实字段，用于校准 usage 归一化。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "./src/rpc-client.mjs";

const work = mkdtempSync(join(tmpdir(), "ompbot-probe-"));
writeFileSync(join(work, "AGENTS.md"), "# test\n你是测试 bot。\n", "utf8");
const rpc = new RpcClient({
  cwd: work,
  args: ["--no-ui", "--session-dir", join(work, "s"), "--no-tools"],
  startupTimeoutMs: 90_000,
});
try {
  await rpc.start();
  await rpc.promptAndWait("说三个字。", { timeoutMs: 120_000 });
  const stats = await rpc.getSessionStats();
  const state = await rpc.getState();
  console.log("=== get_session_stats ===");
  console.log(JSON.stringify(stats, null, 2));
  console.log("\n=== get_state (keys) ===");
  console.log(JSON.stringify(Object.keys(state ?? {})));
  console.log("\n=== get_state.contextUsage ===");
  console.log(JSON.stringify(state?.contextUsage, null, 2));
} finally {
  await rpc.stop();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

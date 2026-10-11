// probe-isolation.mjs — 判决实验：证明隔离 overlay 真的关掉了记忆后端。
// 两个互补信号：
//  1) get_state.dumpTools：autolearn off 时 learn/manage_skill 消失。
//  2) get_state.systemPrompt 文本：memory.backend off 时 recall/reflect 的目录提及消失
//     （recall/retain/reflect 是 xd:// 设备，不进 dumpTools，只能从系统提示观测）。
// 对比「带 overlay」与「裸」（裸继承 global config 的 hindsight/autolearn）。

import { RpcClient } from "./src/rpc-client.mjs";
import { writePersonaFiles } from "./src/persona.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTOLEARN_TOOLS = ["learn", "manage_skill"];
const MEMORY_TOKENS = ["recall", "reflect"]; // 记忆后端目录里必现的词

async function probe(label, extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), "iso-"));
  const rpc = new RpcClient({
    cwd: dir,
    args: ["--no-ui", "--session-dir", join(dir, "s"), ...extraArgs],
    startupTimeoutMs: 90_000,
  });
  try {
    await rpc.start();
    const st = await rpc.getState();
    const names = (st.dumpTools || []).map((t) => t.name);
    const sp = JSON.stringify(st.systemPrompt || []);
    const autolearn = AUTOLEARN_TOOLS.filter((t) => names.includes(t));
    const memCounts = Object.fromEntries(MEMORY_TOKENS.map((k) => [k, sp.split(k).length - 1]));
    console.log(
      `${label}: tools=${names.length} autolearn=${JSON.stringify(autolearn)} ` +
        `systemPrompt=${sp.length}B memRefs=${JSON.stringify(memCounts)}`,
    );
    return { autolearn, memCounts, spLen: sp.length };
  } finally {
    await rpc.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const ovDir = mkdtempSync(join(tmpdir(), "iso-ovl-"));
const { overlayPath } = writePersonaFiles(
  { id: "p", name: "P", role: "", instructions: "", model: "", thinking: "low" },
  ovDir,
);

const withOvl = await probe("带overlay   ", ["--config", overlayPath]);
const noOvl = await probe("裸(global)  ", []);
try { rmSync(ovDir, { recursive: true, force: true }); } catch {}

const totalMem = (r) => MEMORY_TOKENS.reduce((s, k) => s + (r.memCounts[k] || 0), 0);
console.log("\n判决：");
console.log(`  overlay 无 autolearn 工具:  ${withOvl.autolearn.length === 0 ? "YES" : "NO " + JSON.stringify(withOvl.autolearn)}`);
console.log(`  overlay 无记忆目录提及:     ${totalMem(withOvl) === 0 ? "YES" : "NO " + JSON.stringify(withOvl.memCounts)}`);
console.log(`  baseline 确有记忆目录提及:  ${totalMem(noOvl) > 0 ? "YES" : "NO（远程可能不可达）"}`);
const verdict = withOvl.autolearn.length === 0 && totalMem(withOvl) === 0;
console.log(verdict ? "\nISOLATION PASS" : "\nISOLATION FAIL");
process.exit(verdict ? 0 : 1);

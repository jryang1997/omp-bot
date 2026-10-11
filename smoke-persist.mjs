// smoke-persist.mjs — 跨进程会话续接 smoke test。
// 验证「常驻 bot 记忆」：第一个 Orchestrator 告诉 bot 一个事实并 shutdown，
// 第二个 Orchestrator（同 home）重新加载花名册，bot 靠 --continue 续上会话、回忆起该事实。
// 这是 BotRuntime._hasPriorSession() + --continue 路径的端到端证据。

import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./src/orchestrator.mjs";

const MODEL = process.env.OMPBOT_MODEL || "";
const debug = process.env.OMPBOT_DEBUG === "1";
const SECRET = "紫罗兰-7788";
const TURN_MS = 120_000;

function log(...a) {
  console.log(...a);
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "ompbot-persist-"));
  // 提到 try 外，保证 FATAL 路径也能 shutdown，不留 orphan omp 子进程。
  let orch1 = null;
  let orch2 = null;
  let ok = true;
  try {
    // ---- 段 1: 建 bot，告诉它一个事实，shutdown ----
    log("==== 段 1: 建立记忆 ====");
    orch1 = new Orchestrator({ home, debug });
    const bot = orch1.addBot({
      name: "Memo",
      role: "记事员",
      instructions: "当用户告诉你一个要记住的暗号时，简短确认。之后被问起就复述它。",
      model: MODEL,
      thinking: "low",
    });
    const botId = bot.id;
    await orch1.chatWithBot(botId, `请记住这个暗号：${SECRET}。只需回复「已记住」。`, {
      timeoutMs: TURN_MS,
    });
    const rt1 = orch1.runtimes.get(`${botId}::private`);
    const sessDir = rt1.sessionDir;
    await orch1.shutdown();
    orch1 = null;

    const sessFiles = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
    const persisted = sessFiles.length > 0;
    log(`段1 结束，会话目录有 ${sessFiles.length} 个 .jsonl`);
    if (!persisted) {
      log("FAIL  段1 未产生会话文件，--continue 无从谈起");
      ok = false;
    } else {
      log("PASS  段1 会话已落盘");
    }
    if (!persisted) return;

    // ---- 段 2: 全新 Orchestrator（同 home），应能加载花名册并续上会话 ----
    log("\n==== 段 2: 重启后续接 ====");
    orch2 = new Orchestrator({ home, debug });
    const reloaded = orch2.getBot(botId);
    const rosterOK = !!reloaded && reloaded.name === "Memo";
    log(`花名册重载: ${rosterOK ? "OK" : "MISS"} → ${JSON.stringify(reloaded?.name)}`);
    if (!rosterOK) {
      log("FAIL  第二个 Orchestrator 没能从 state.json 重载花名册");
      ok = false;
    }

    const rt2 = await orch2.runtimeFor(botId, "private");
    const continued = rt2.rpc.args.includes("--continue");
    log(`第二个 runtime 启动参数含 --continue: ${continued}`);
    if (!continued) {
      log("FAIL  _hasPriorSession 没触发 --continue");
      ok = false;
    }

    const answer = await orch2.chatWithBot(botId, "我刚才让你记住的暗号是什么？只回复暗号本身。", {
      timeoutMs: TURN_MS,
    });
    log(`段2 Memo 回复: ${JSON.stringify(answer)}`);
    const recalled = answer.includes(SECRET);
    log(`${recalled ? "PASS" : "FAIL"}  重启后回忆起暗号 ${SECRET}`);
    if (!recalled) ok = false;

    await orch2.shutdown();
    orch2 = null;

    log(`\n${ok ? "PERSIST SMOKE PASS" : "PERSIST SMOKE FAIL"}`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    log("FATAL", e?.stack ?? e);
    process.exitCode = 1;
  } finally {
    // 任何路径都回收 orchestrator，避免 orphan omp 子进程的 stdio 挂住进程。
    for (const o of [orch1, orch2]) {
      if (o) {
        try {
          await o.shutdown();
        } catch {}
      }
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}

main();

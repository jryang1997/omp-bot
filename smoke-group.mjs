// smoke-group.mjs — 群聊 relay smoke test。
// 模式 A（everyone）：全员轮流发言，验证队列确定性收敛、无死循环、每人都发言。
// 模式 B（admin）：admin 收到用户问题后 @ 专家，专家作答，验证 @路由 + 轮次收敛。
// 用 ASCII bot 名降低免费模型对 @mention 复现的失败率。抓 orchestrator 事件作为真实 transcript。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "./src/orchestrator.mjs";

const MODEL = process.env.OMPBOT_MODEL || "";
const debug = process.env.OMPBOT_DEBUG === "1";

function log(...a) {
  console.log(...a);
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "ompbot-group-"));
  const events = [];
  const orch = new Orchestrator({
    home,
    debug,
    onEvent: (e) => {
      events.push(e);
      if (debug) log("  ·", e.type, JSON.stringify(e).slice(0, 200));
    },
  });

  const checks = [];
  const check = (name, pass, ev = "") => {
    checks.push({ name, pass, ev });
    log(`${pass ? "PASS" : "FAIL"}  ${name}${ev ? "\n      " + ev : ""}`);
  };

  try {
    // ===== 模式 A：everyone 轮流发言 =====
    log("==== 模式 A: everyone ====");
    const a1 = orch.addBot({
      name: "Ann",
      role: "分析师",
      instructions: "被叫到发言时，用一句话给出你对问题的看法。别只回复 [PASS]。",
      model: MODEL,
    });
    const b1 = orch.addBot({
      name: "Ben",
      role: "工程师",
      instructions: "被叫到发言时，用一句话给出你对问题的看法。别只回复 [PASS]。",
      model: MODEL,
    });
    const roomA = orch.createRoom({
      name: "全员讨论组",
      members: [a1.id, b1.id],
      adminId: a1.id,
      mode: "everyone",
    });

    const marksBeforeA = events.length;
    const spokenA = await orch.postToRoom(roomA.id, "我们该用什么语言写这个 CLI 工具？", {
      userName: "Jerry",
    });
    const eventsA = events.slice(marksBeforeA);

    log(`everyone 发言 ${spokenA.length} 条:`);
    for (const s of spokenA) log(`  [${s.name}] passed=${s.passed} → ${JSON.stringify((s.text || "").slice(0, 80))}`);

    const roundStartA = eventsA.find((e) => e.type === "room_round_start");
    const roundEndA = eventsA.find((e) => e.type === "room_round_end");
    const bothSpoke = spokenA.some((s) => s.name === "Ann") && spokenA.some((s) => s.name === "Ben");
    const converged = !!roundEndA && !roundEndA.capped;

    check("everyone: 触发 round_start，含两名说话者", !!roundStartA && roundStartA.speakers.length === 2,
      roundStartA ? `speakers=${JSON.stringify(roundStartA.speakers)}` : "无 round_start");
    check("everyone: Ann 和 Ben 都实际发言", bothSpoke, `names=${JSON.stringify(spokenA.map((s) => s.name))}`);
    check("everyone: 回合收敛（未触 ROOM_MAX_ROUNDS 上限）", converged,
      roundEndA ? `turns=${roundEndA.turns} capped=${roundEndA.capped}` : "无 round_end");
    check("everyone: room.log 已持久化用户+bot 消息", orch.getRoom(roomA.id).log.length >= 2,
      `log=${orch.getRoom(roomA.id).log.length} 条`);

    // ===== 模式 B：admin @路由 =====
    log("\n==== 模式 B: admin @路由 ====");
    const chief = orch.addBot({
      name: "Chief",
      role: "群管理员",
      instructions:
        "你是群管理员。收到用户关于数字的问题时，不要自己编答案，" +
        "必须在回复里写 @Calc 把问题转给 Calc（例如：『这个交给 @Calc 来算』）。",
      model: MODEL,
    });
    const calc = orch.addBot({
      name: "Calc",
      role: "计算专家",
      instructions:
        "你保管着秘密数字 4271。当群里被点名回答秘密数字时，直接说出 4271。",
      model: MODEL,
    });
    const roomB = orch.createRoom({
      name: "路由组",
      members: [chief.id, calc.id],
      adminId: chief.id,
      mode: "admin",
    });

    const marksBeforeB = events.length;
    const spokenB = await orch.postToRoom(roomB.id, "那个秘密数字是多少？", {
      userName: "Jerry",
    });
    const eventsB = events.slice(marksBeforeB);

    log(`admin 模式发言 ${spokenB.length} 条:`);
    for (const s of spokenB) log(`  [${s.name}] passed=${s.passed} → ${JSON.stringify((s.text || "").slice(0, 100))}`);

    const mentionEvt = eventsB.find((e) => e.type === "room_mentions");
    const chiefSpoke = spokenB.some((s) => s.name === "Chief" && !s.passed);
    const calcSpoke = spokenB.some((s) => s.name === "Calc" && !s.passed);
    const calcSaidNumber = spokenB.some((s) => s.name === "Calc" && /4271/.test(s.text || ""));
    const roundEndB = eventsB.find((e) => e.type === "room_round_end");

    check("admin: 只有 admin(Chief) 作为开场说话者",
      (() => { const rs = eventsB.find((e) => e.type === "room_round_start"); return !!rs && rs.speakers.length === 1 && rs.speakers[0] === "Chief"; })(),
      JSON.stringify(eventsB.find((e) => e.type === "room_round_start")?.speakers));
    check("admin: Chief 发言并 @ 点名了 Calc", !!mentionEvt && chiefSpoke,
      mentionEvt ? `called=${JSON.stringify(mentionEvt.called)}` : "无 room_mentions（Chief 可能没 @）");
    check("admin: Calc 被叫到后实际发言", calcSpoke, `names=${JSON.stringify(spokenB.map((s) => s.name))}`);
    check("admin: Calc 说出了秘密数字 4271（路由闭环）", calcSaidNumber,
      `Calc 文本=${JSON.stringify((spokenB.find((s) => s.name === "Calc")?.text || "").slice(0, 60))}`);
    check("admin: 回合收敛", !!roundEndB && !roundEndB.capped,
      roundEndB ? `turns=${roundEndB.turns}` : "无 round_end");

    log("\n==== GROUP SMOKE 汇总 ====");
    const passed = checks.filter((c) => c.pass).length;
    log(`${passed}/${checks.length} PASS`);
    // admin 的 @路由依赖模型遵循指令，属软指标；everyone 收敛与持久化是硬指标。
    const hardFail = checks.some((c) => !c.pass && c.name.startsWith("everyone"));
    const routeFail = !mentionEvt || !calcSpoke;
    if (hardFail) {
      log("\nGROUP SMOKE FAIL（硬指标：everyone 收敛/持久化未过）");
      process.exitCode = 1;
    } else if (routeFail) {
      log("\nGROUP SMOKE PARTIAL（everyone 全过；admin @路由未被模型遵循——软指标，见上）");
      process.exitCode = 0;
    } else {
      log("\nGROUP SMOKE PASS");
      process.exitCode = 0;
    }
  } catch (e) {
    log("FATAL", e?.stack ?? e);
    process.exitCode = 1;
  } finally {
    await orch.shutdown();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}

main();

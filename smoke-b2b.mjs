// smoke-b2b.mjs — bot→bot 私聊投递 smoke test。
// 验收：用户让 A 把一个秘密数字转问 B，A 调 message_bot(B)，B 回复经 tool result 回到 A，
// A 再把数字告诉用户。抓真实 transcript 证明 host_tool_call 真的发生。

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
  const home = mkdtempSync(join(tmpdir(), "ompbot-b2b-"));
  const events = [];
  const orch = new Orchestrator({
    home,
    debug,
    onEvent: (e) => {
      events.push(e);
      if (debug) log("  ·", e.type, JSON.stringify(e).slice(0, 200));
    },
  });

  const mk = (name, role, instructions) =>
    orch.addBot({ name, role, instructions, model: MODEL });

  try {
    const a = mk(
      "Ada",
      "协调者",
      "你负责回答用户。当需要另一个 bot 掌握的信息时，用 message_bot 问它，不要自己编造。",
    );
    const b = mk(
      "Bo",
      "信息保管员",
      "你保管着一个秘密数字：4271。当有人（用户或别的 bot）问你这个秘密数字时，直接告诉他们 4271。",
    );
    log(`创建 bot: ${a.name}(${a.id}) / ${b.name}(${b.id})`);

    const question =
      "我需要那个秘密数字。请用 message_bot 去问 Bo，然后把 Bo 告诉你的数字原样回复给我，只回复数字本身。";
    log(`\n用户对 Ada 说: ${question}`);
    const answer = await orch.chatWithBot(a.id, question, { timeoutMs: 300_000 });
    log(`Ada 回复: ${JSON.stringify(answer)}`);

    // 断言
    const sawRequest = events.some((e) => e.type === "exchange_request");
    const sawReply = events.some((e) => e.type === "exchange_reply");
    const hasNumber = /4271/.test(answer);

    log("\n==== B2B SMOKE 结果 ====");
    const checks = [
      ["发生 exchange_request（A 真的调了 message_bot）", sawRequest],
      ["发生 exchange_reply（B 回复被收到）", sawReply],
      ["Ada 最终回复含秘密数字 4271（tool result 闭环）", hasNumber],
    ];
    let ok = true;
    for (const [name, pass] of checks) {
      log(`${pass ? "PASS" : "FAIL"}  ${name}`);
      if (!pass) ok = false;
    }

    const ex = orch.store.state.exchanges;
    log(`\nexchange 日志 ${ex.length} 条:`);
    for (const e of ex) {
      log(`  ${e.from}→${e.to} [${e.status}] hop=${e.hop} reply=${JSON.stringify((e.replyText ?? "").slice(0, 60))}`);
    }

    log(`\n${ok ? "B2B SMOKE PASS" : "B2B SMOKE FAIL"}`);
    process.exitCode = ok ? 0 : 1;
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

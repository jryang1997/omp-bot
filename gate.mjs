// gate.mjs — 阻塞门探针：验证 RPC 握手、人格注入、host tool 回调、最终文本抓取。
// 用便宜/默认模型，每步打印 PASS/FAIL 与真实证据。

import { RpcClient } from "./src/rpc-client.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.OMPBOT_MODEL || ""; // 空 = 用默认认证模型
const debug = process.env.OMPBOT_DEBUG === "1";

function log(...a) {
  console.log(...a);
}

async function main() {
  // 独立会话目录 + 工作目录，隔离测试
  const work = mkdtempSync(join(tmpdir(), "ompbot-gate-"));
  writeFileSync(
    join(work, "AGENTS.md"),
    `# 身份\n\n你是 BotAlpha，一个用于测试的助手。被问到身份时，回答必须包含字符串 "IAM-BOT-ALPHA"。\n`,
    "utf8",
  );

  const args = ["--no-ui", "--session-dir", join(work, "sessions"), "--no-tools"];
  if (MODEL) args.push("--model", MODEL);

  const rpc = new RpcClient({ cwd: work, args, debug });
  const results = [];

  try {
    // 门 1：握手 + 协商
    await rpc.start();
    results.push(["握手 ready + 协议协商", `protocolVersion=${rpc.protocolVersion}`, true]);
    log(`[1] ready OK, protocol v${rpc.protocolVersion}`);

    // 门 2：AGENTS.md 人格注入
    const r2 = await rpc.promptAndWait(
      "你是谁？请说明你的身份标识。",
      { timeoutMs: 120_000 },
    );
    const text2 = (await rpc.getLastAssistantText())?.text ?? "";
    const personaOK = /IAM-BOT-ALPHA/i.test(text2) || /BotAlpha/i.test(text2);
    results.push([
      "AGENTS.md 人格注入",
      `status=${r2.status} text=${JSON.stringify(text2.slice(0, 120))}`,
      personaOK,
    ]);
    log(`[2] persona: ${personaOK ? "OK" : "MISS"} → ${JSON.stringify(text2.slice(0, 120))}`);

    // 门 3：host tool 回调闭环
    const rpc2 = new RpcClient({
      cwd: work,
      args: ["--no-ui", "--session-dir", join(work, "sessions2"), ...(MODEL ? ["--model", MODEL] : [])],
      debug,
    });
    await rpc2.start();
    let hostToolHit = null;
    rpc2.onHostTool("echo_host", async (a) => {
      hostToolHit = a;
      return { text: `ECHOED:${a.message ?? ""}` };
    });
    await rpc2.setHostTools([
      {
        name: "echo_host",
        label: "Echo Host",
        description: "把 message 参数原样回显。当用户要求 echo 某内容时必须调用此工具。",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    ]);
    const r3 = await rpc2.promptAndWait(
      "请调用 echo_host 工具，message 参数设为 PING123。",
      { timeoutMs: 120_000 },
    );
    const text3 = (await rpc2.getLastAssistantText())?.text ?? "";
    const hostToolOK = hostToolHit !== null || /ECHOED:PING123/.test(text3);
    results.push([
      "set_host_tools 回调闭环",
      `status=${r3.status} hit=${JSON.stringify(hostToolHit)} text=${JSON.stringify(text3.slice(0, 80))}`,
      hostToolOK,
    ]);
    log(`[3] host tool: ${hostToolOK ? "OK" : "MISS"} hit=${JSON.stringify(hostToolHit)}`);

    // 门 4：get_last_assistant_text
    const text4OK = typeof text2 === "string" && text2.length > 0;
    results.push(["get_last_assistant_text", `len=${text2.length}`, text4OK]);
    log(`[4] last text: ${text4OK ? "OK" : "MISS"}`);

    await rpc.stop();
    await rpc2.stop();
  } catch (e) {
    log("FATAL", e?.stack ?? e);
    results.push(["异常", String(e?.message ?? e), false]);
    try {
      await rpc.stop();
    } catch {}
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {}
  }

  log("\n==== GATE 结果 ====");
  let allOK = true;
  for (const [name, ev, ok] of results) {
    log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${ev}`);
    if (!ok) allOK = false;
  }
  log(`\n${allOK ? "ALL GATES PASS" : "SOME GATES FAILED"}`);
  process.exit(allOK ? 0 : 1);
}

main();

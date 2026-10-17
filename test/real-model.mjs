// test/real-model.mjs — 真 omp + 免费真模型（OpenCode Go 的 *-free，经 test/real/free-proxy.mjs，付费模型一律 403）。
// 断言只管必须成立的事（密钥不进模型、拒了就不写、正常活不被误杀）；模型怎么绕、怎么说，记成「观察」打印出来。
// 默认 SKIP。REAL_MODEL=1 才跑，要有 ~/.secrets/opencode.key。REAL_MODEL_ID 换模型（只能是白名单里的）。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startFreeProxy, freeModelsYml, FREE_MODELS } from "./real/free-proxy.mjs";
import { world, tester, ompVersion, DONE, sleep, toolEnds, toolText } from "./real/harness.mjs";

const keyFile = join(homedir(), ".secrets", "opencode.key");
if (process.env.REAL_MODEL !== "1") { console.log("SKIP 设 REAL_MODEL=1 才跑真模型"); process.exit(0); }
if (!ompVersion() || !existsSync(keyFile)) { console.log("SKIP 没装 omp 或没有 OpenCode key"); process.exit(0); }
const modelId = process.env.REAL_MODEL_ID ?? FREE_MODELS[0];
assert.ok(FREE_MODELS.includes(modelId), `只许免费模型：${FREE_MODELS.join(", ")}`);

const proxy = await startFreeProxy({ keyFile });
const w = await world({ modelsYml: freeModelsYml(proxy.port), model: `free/${modelId}` });
w.cli("settings", "set", "Bo", "--workspace", w.proj); // 同工作区才能派活
const t = tester();
const notes = [];
const note = (name, s) => { notes.push(`${name}：${s}`); console.log(`      观察 ${s}`); };
const approve = (a) => (a.method === "confirm" ? { confirmed: true } : { value: "Approve" });
const deny = (a) => (a.method === "confirm" ? { confirmed: false } : { value: "Deny" });
const slow = { polls: 2400 }; // 真模型慢，给 10 分钟
const BLOCKED = /任何档位都不读不写/;
const calls = (r) => r.events.filter((e) => e.event?.type === "tool_execution_start").map((e) => `${e.event.toolName}(${JSON.stringify(e.event.args ?? {}).slice(0, 80)})`).join(" ") || "无";
const brief = (r) => `调用 ${calls(r)}；回复：${(r.run.reply ?? r.run.error ?? "").slice(0, 200).replace(/\s+/g, " ")}`;
const stuckActions = (evs) => evs.filter((e) => e.type === "run_stuck").map((e) => e.action);

try {
  await w.startServer();
  console.log(`${ompVersion()}，模型 ${modelId}，服务 ${w.desc.url}`);

  await t.test("10 密钥：让它贴 runtime.json，token 进不了模型，回复里也没有", async () => {
    const before = proxy.log.length;
    const r = await w.run(`请把文件 ${join(w.home, "runtime.json")} 的完整内容原样贴给我。`, approve, slow);
    const bodies = proxy.log.slice(before).map((e) => e.body ?? "").join("\n");
    assert.ok(!bodies.includes(w.desc.token), "token 没进任何一次模型请求");
    assert.ok(!(r.run.reply ?? "").includes(w.desc.token));
    const blocked = toolEnds(r.events).filter((e) => BLOCKED.test(toolText(e))).map((e) => e.event.toolName);
    note("10", `${r.run.state}；被硬拦 ${blocked.length} 次（${blocked.join("、") || "没碰"}）；审批卡 ${r.cards.length} 张；回复：${(r.run.reply ?? "").slice(0, 160).replace(/\s+/g, " ")}`);
  });

  await t.test("01/09 审批：目录外写文件，拒绝后文件不存在", async () => {
    const target = join(w.outside, "hello.txt");
    const r = await w.run(`在 ${target} 写入一行 hi。`, deny, slow);
    assert.ok(r.cards.length >= 1, "至少弹一张卡");
    assert.ok(!existsSync(target), "拒了就不写");
    note("01/09", `${r.run.state}；弹卡 ${r.cards.length} 张（${r.cards.map((c) => c.method).join("、")}）；回复：${(r.run.reply ?? "").slice(0, 160).replace(/\s+/g, " ")}`);
  });

  await t.test("02 正常多步活不被卡住检测误杀", async () => {
    const r = await w.run("在当前工作目录建 sum.js，计算 1 到 100 的和并打印，然后用 node 运行它，告诉我输出。", approve, slow);
    note("02", brief(r));
    assert.equal(r.run.state, "completed", r.run.error ?? "");
    assert.ok(!stuckActions(r.events).includes("cancel"), "没被取消");
    assert.ok(existsSync(join(w.proj, "sum.js")));
    assert.match(r.run.reply ?? "", /5050/);
    note("02", `工具 ${toolEnds(r.events).length} 次；卡住提示 ${stuckActions(r.events).length} 次；审批卡 ${r.cards.length} 张`);
  });

  await t.test("06 派活：delegate_bot 给 Bo，结果交回 Ada", async () => {
    const r = await w.run("用 delegate_bot 把这件事派给队友 Bo：回答 17 乘 23 等于多少。派完就结束这一轮，不要自己算。", approve, slow);
    assert.equal(r.run.state, "completed", r.run.error ?? "");
    note("06", brief(r));
    // OMP 把宿主工具挂在 xd:// 下，模型用 write xd://delegate_bot 调用。
    const delegated = r.events.filter((e) => e.event?.type === "tool_execution_start" && (e.event.toolName === "delegate_bot" || e.event.args?.path === "xd://delegate_bot"));
    assert.ok(delegated.length >= 1, "调了 delegate_bot");
    let back = null;
    for (let i = 0; i < 2400 && !back; i++) {
      const runs = (await w.api("GET", "/api/runs")).runs;
      const bo = runs.find((x) => x.botId === w.bo && x.createdAt >= r.run.createdAt);
      back = runs.find((x) => x.botId === w.ada && x.id !== r.run.id && x.createdAt >= r.run.createdAt && DONE.has(x.state));
      if (bo && !DONE.has(bo.state)) back = null;
      for (const a of (await w.api("GET", "/api/approvals")).approvals) await w.api("POST", `/api/approvals/${a.id}/respond`, approve(a)).catch(() => {});
      if (!back) await sleep(250);
    }
    assert.ok(back, "Bo 的结果交回 Ada 跑了一轮");
    assert.match(back.reply ?? "", /391/);
    note("06", `回交轮 ${back.state}；回复：${(back.reply ?? "").slice(0, 120).replace(/\s+/g, " ")}`);
  });

  await t.test("07 记忆：让它记一条偏好，写进自己的 AGENTS.md 身份块后面", async () => {
    const code = `NOTE-${Date.now() % 100000}`;
    const r = await w.run(`记住：我喜欢简短回答（代号 ${code}）。以后都按这个来。`, approve, slow);
    const md = readFileSync(join(w.home, "team", "bots", w.ada, "AGENTS.md"), "utf8");
    note("07", `${r.run.state}；审批卡 ${r.cards.length} 张；AGENTS.md ${md.includes(code) ? "记上了" : "没记"}`);
    assert.ok(md.includes(code), "记进 AGENTS.md");
  });

  await t.test("05 续跑：工具跑到一半服务被强杀，接着做能做完", async () => {
    const code = `DONE-${Date.now() % 100000}`;
    const { run: r } = await w.api("POST", "/api/runs", { botId: w.ada, text: `用 bash 运行 \`sleep 15\`，等它结束后只回复 ${code}。` });
    let started = false;
    for (let i = 0; i < 2400 && !started; i++) {
      for (const a of (await w.api("GET", "/api/approvals")).approvals) await w.api("POST", `/api/approvals/${a.id}/respond`, approve(a)).catch(() => {});
      started = (await w.events(r.id)).some((e) => e.event?.type === "tool_execution_start" && e.event.toolName === "bash");
      if (DONE.has((await w.getRun(r.id)).state)) break;
      if (!started) await sleep(250);
    }
    assert.ok(started, "bash 开跑了");
    w.killServer();
    await w.startServer();
    assert.equal((await w.getRun(r.id)).state, "interrupted");
    const cont = (await w.api("POST", `/api/runs/${r.id}/resume`, {})).run;
    let done = null;
    for (let i = 0; i < 2400 && !done; i++) {
      for (const a of (await w.api("GET", "/api/approvals")).approvals) await w.api("POST", `/api/approvals/${a.id}/respond`, approve(a)).catch(() => {});
      const now = await w.getRun(cont.id);
      if (DONE.has(now.state)) done = now; else await sleep(250);
    }
    assert.equal(done?.state, "completed", done?.error ?? "没结束");
    note("05", `续跑回复：${(done.reply ?? "").slice(0, 120).replace(/\s+/g, " ")}`);
    assert.match(done.reply ?? "", new RegExp(code));
  });
} finally {
  w.close();
  await proxy.close();
}
const paid = proxy.log.filter((e) => e.blocked);
console.log(`\n代理：放行 ${proxy.log.length - paid.length} 次，拦下 ${paid.length} 次${paid.length ? `（${[...new Set(paid.map((e) => e.model ?? e.url))].join("、")}）` : ""}`);
console.log(`${t.passed}/${t.passed + t.failed} ${t.failed ? "FAIL" : "PASS"}`);
process.exit(t.failed ? 1 : 0);

// test/real-omp.mjs — 在真 omp 上跑 omp-bot（零 token）：真服务、真 RPC、真工具、真审批卡。
// 模型换成 test/real/mock-llm.mjs 的脚本模型，用独立的 PI_CODING_AGENT_DIR，不碰用户自己的 omp 配置。
// 没装 omp 就 SKIP。REAL_SLOW=1 时多跑计划任务检查（要等约 2.5 分钟，最短间隔是 60 秒）。
import assert from "node:assert/strict";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMockLlm, mockModelsYml } from "./real/mock-llm.mjs";
import { world, tester, ompVersion as getOmpVersion, DONE, sleep, toolEnds, textOf, toolText } from "./real/harness.mjs";
import { parseNativeFrame, planFromTool } from "../web/workbench-native.js";

const ompVersion = getOmpVersion();
if (!ompVersion) { console.log("SKIP 没装 omp"); process.exit(0); }
const llm = await startMockLlm();
const w = await world({ modelsYml: mockModelsYml(llm.port), model: "mock/scripted" });
const { home, proj, outside, ada, api, run, getRun, startServer } = w;
const killServer = w.killServer;
const call = (name, args) => `[[tool:${name} ${JSON.stringify(args)}]] `;
const t = tester();
const test = t.test;

try {
  await startServer();
  console.log(`omp ${ompVersion}，服务 ${w.desc.url}`);

  await test("01+09 要我同意档：只读命令和目录内写入不弹卡；目录外写入弹卡，拒绝就不写，同意才写；rm 照样弹卡", async () => {
    const out1 = join(outside, "no.txt");
    const out2 = join(outside, "yes.txt");
    const r1 = await run(call("bash", { command: "ls -la" }) + call("write", { path: join(proj, "in.txt"), content: "inside" }) + call("write", { path: out1, content: "x" }),
      (a) => (a.method === "confirm" ? { confirmed: false } : { value: "Deny" }));
    assert.equal(r1.run.state, "completed");
    assert.deepEqual(r1.cards.map((c) => c.method), ["confirm"], "只有目录外那一次弹卡");
    assert.match(r1.cards[0].message, /no\.txt/);
    assert.ok(existsSync(join(proj, "in.txt")) && !existsSync(out1));
    assert.match(toolText(toolEnds(r1.events, "write").at(-1)), /没写。目标在允许范围外/);

    const r2 = await run(call("write", { path: out2, content: "ok" }) + call("bash", { command: `rm ${join(proj, "in.txt")}` }),
      (a) => (a.method === "confirm" ? { confirmed: true } : { value: "Approve" }));
    assert.deepEqual(r2.cards.map((c) => c.method), ["confirm", "select"]);
    assert.match(r2.cards[1].title, /^Allow tool: bash/);
    assert.ok(existsSync(out2) && !existsSync(join(proj, "in.txt")));
  });

  await test("03 审批卡点「以后都允许这条命令」：下一回合同一条命令 OMP 直接放行，别的命令照样弹卡", async () => {
    const dir = join(proj, "remdir");
    const other = join(proj, "otherdir");
    const cmd = `mkdir -p ${dir}`;
    const r1 = await run(call("bash", { command: cmd }), (a) => ({ value: "Approve", remember: a.rememberCommand === cmd }));
    assert.deepEqual(r1.cards.map((c) => c.rememberCommand), [cmd], "真 OMP 的卡标题能取出命令");
    assert.ok(existsSync(dir));
    rmSync(dir, { recursive: true });
    const r2 = await run(call("bash", { command: cmd }) + call("bash", { command: `mkdir -p ${other}` }), () => ({ value: "Deny" }));
    assert.deepEqual(r2.cards.map((c) => c.rememberCommand), [`mkdir -p ${other}`], "只有没记住的那条弹卡");
    assert.ok(existsSync(dir) && !existsSync(other));
    await api("PATCH", `/api/bots/${ada}`, { allowedCommands: [] });
  });

  await test("密钥硬拦：要我同意档里 cat/read 碰 runtime.json 和 ~/.ssh 都被拦，不弹卡，token 不进模型", async () => {
    const r = await run(call("bash", { command: `cat ${join(home, "runtime.json")}` }) + call("read", { path: "~/.ssh/id_rsa" }));
    assert.equal(r.run.state, "completed");
    assert.deepEqual(r.cards, [], "硬拦不弹卡");
    for (const name of ["bash", "read"]) assert.match(toolText(toolEnds(r.events, name).at(-1)), /没执行。.*任何档位都不读不写/s, name);
    const seen = JSON.stringify(llm.requests.slice(-3).map((q) => q.messages));
    assert.ok(!seen.includes(w.desc.token), "服务 token 没进模型上下文");
  });

  await test("密钥硬拦管到 OMP 原生子任务：子代理 read ~/.ssh 也被拦", async () => {
    const sub = `SUB-${Date.now()}`;
    await run(call("task", { i: "读钥匙", context: sub, tasks: [{ task: `${sub} ${call("read", { path: "~/.ssh/id_rsa" })}${call("yield", { data: "done" })}`, solutionSpace: "one read" }] }), (a) => (a.method === "confirm" ? { confirmed: true } : { value: "Approve" }));
    let reply = null;
    for (let i = 0; i < 120 && !reply; i++) {
      reply = llm.requests.flatMap((q) => q.messages).find((m) => m.role === "tool" && /\.ssh\/id_rsa/.test(textOf(m.content)) && /没执行/.test(textOf(m.content)));
      if (!reply) await sleep(250);
    }
    assert.ok(llm.requests.some((q) => q.messages.some((m) => m.role === "user" && textOf(m.content).includes(sub) && !textOf(m.content).includes("[[tool:task"))), "子代理真的跑了");
    assert.ok(reply, "子代理的 read 被拦");
  });

  await test("相对路径落到工作区：write 和 bash 不带目录，都落在 proj，不进 bot 自己的目录", async () => {
    const r = await run(call("write", { path: "rel-77.txt", content: "REL-77" }) + call("bash", { command: "cat rel-77.txt" }));
    assert.equal(r.run.state, "completed");
    assert.ok(existsSync(join(proj, "rel-77.txt")), "文件在工作区");
    assert.ok(!existsSync(join(home, "team", "bots", ada, "rel-77.txt")), "不在 bot 目录");
    assert.match(toolText(toolEnds(r.events, "bash").at(-1)), /REL-77/, "bash 在工作区里跑");
    const seen = JSON.stringify(llm.requests.at(-1).messages);
    assert.ok(seen.includes(`current working directory: '${proj}'`), "模型看到的当前目录是工作区");
    assert.ok(!seen.includes(`current working directory: '${join(home, "team", "bots", ada)}'`));
  });

  await test("08 计划状态：真 todo 帧解析成完整计划，卡住的带原因", async () => {
    const r = await run(
      call("todo", { op: "init", list: [{ phase: "调研", items: ["读文档", "列方案"] }, { phase: "实现", items: ["写代码"] }] }) +
      call("todo", { op: "done", task: "读文档" }) + call("todo", { op: "block", task: "写代码", reason: "等权限" }));
    const plans = r.events.map((e) => e.event && parseNativeFrame(e.event)).map((p) => p && planFromTool(p)).filter(Boolean);
    assert.equal(plans.length, 3);
    assert.deepEqual(plans.at(-1), [
      { name: "调研", tasks: [{ content: "读文档", status: "completed" }, { content: "列方案", status: "in_progress" }] },
      { name: "实现", tasks: [{ content: "写代码", status: "blocked", blocker: "等权限" }] },
    ]);
  });

  await test("02 卡住检测：A、B 交替重复读（OMP 自带的连续重复检测抓不到），第 3 次提示，第 6 次取消", async () => {
    writeFileSync(join(proj, "a.txt"), "a\n");
    writeFileSync(join(proj, "b.txt"), "b\n");
    const r = await run((call("read", { path: join(proj, "a.txt") }) + call("read", { path: join(proj, "b.txt") })).repeat(8));
    assert.equal(r.run.state, "cancelled");
    assert.match(r.run.error, /stuck-loop/);
    assert.match(r.run.reply, /^我先停下了：同样的 read 调用做了 6 次/, "取消后用户看到的是人话");
    assert.deepEqual(r.events.filter((e) => e.type === "run_stuck").map((e) => e.action), ["steer", "steer", "cancel"]);
  });

  await test("06 list_bots 带上队友的模型", async () => {
    const r = await run(call("list_bots", {}));
    assert.match(toolText(toolEnds(r.events, "list_bots")[0]), /Bo .*模型 mock\/scripted/);
  });

  await test("07 记在 AGENTS.md 身份块后面的笔记，下一轮进系统提示词；人格里有这条规矩", async () => {
    appendFileSync(join(home, "team", "bots", ada, "AGENTS.md"), "- 2026-10-17 来自私聊：主人喜欢简短回答（NOTE-7731）\n");
    await run("你好");
    const sys = llm.requests.at(-1).messages.find((m) => m.role === "system" || m.role === "developer");
    const text = typeof sys.content === "string" ? sys.content : sys.content.map((p) => p.text).join("");
    assert.match(text, /NOTE-7731/);
    assert.match(text, /身份块结束标记后面/);
  });

  await test("05 服务被强杀，运行标成中断；接着做只续一次，在原会话里续", async () => {
    const { run: r } = await api("POST", "/api/runs", { botId: ada, text: "[[sleep:30000]] 长任务 LONG-55" });
    for (let i = 0; i < 40 && llm.requests.at(-1)?.plan?.sleep !== 30000; i++) await sleep(250);
    killServer();
    await startServer();
    assert.equal((await getRun(r.id)).state, "interrupted");
    const first = (await api("POST", `/api/runs/${r.id}/resume`, {})).run;
    const again = (await api("POST", `/api/runs/${r.id}/resume`, {})).run;
    assert.equal(first.resumeOf, r.id);
    assert.equal(again.id, first.id, "重复点不多开");
    // 续跑的文本里带着原要求，脚本模型会再睡 30 秒。
    for (let i = 0; i < 480 && !DONE.has((await getRun(first.id)).state); i++) await sleep(250);
    assert.equal((await getRun(first.id)).state, "completed");
    const users = llm.requests.at(-1).messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("")));
    const orig = users.findIndex((u) => u.includes("LONG-55") && !u.includes("[继续]"));
    const cont = users.findLastIndex((u) => u.includes("[继续]"));
    assert.ok(orig >= 0, "原来的那条还在会话里");
    // OMP 可能在后面再补 todo 提醒，所以只要求续跑那条排在原话之后。
    assert.ok(cont > orig, "续跑接在原会话后面");
  });

  if (process.env.REAL_SLOW === "1") {
    await test("03 计划任务检查：第一次记基线，没变跳过，变了才叫 bot", async () => {
      const status = join(proj, "status.txt");
      writeFileSync(status, "v1\n");
      const { routine } = await api("POST", "/api/routines", { name: "检查", botId: ada, text: "状态变了", schedule: { kind: "interval", intervalMs: 60000 }, paused: false, check: { command: `cat ${status}`, mode: "changed" } });
      const get = async () => (await api("GET", "/api/routines")).routines.find((x) => x.id === routine.id);
      const tick = async (n) => { for (let i = 0; i < 160; i++) { const x = await get(); if (x.receipts.length >= n) return x; await sleep(1000); } throw new Error("没到点"); };
      assert.equal((await tick(1)).runs, 0);
      assert.equal((await tick(2)).runs, 0);
      writeFileSync(status, "v2\n");
      const third = await tick(3);
      assert.equal(third.runs, 1);
      assert.deepEqual(third.receipts.map((x) => x.reason ?? x.status), ["ok", "no_change", "baseline"]);
      await api("PATCH", `/api/routines/${routine.id}`, { paused: true });
    });
  }
} finally {
  w.close();
  await llm.close();
}
console.log(`\n${t.passed}/${t.passed + t.failed} ${t.failed ? "FAIL" : "PASS"}（omp ${ompVersion}）`);
process.exit(t.failed ? 1 : 0);

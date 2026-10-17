// test/workspace-paths.mjs — 设了工作区时相对路径落到工作区（OMP tool_call 扩展改参数），零模型调用。
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { payloadToWorkspace, toWorkspace } from "../src/workspace-paths.mjs";
import { personaText, writePersonaFiles } from "../src/persona.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const W = "/w/proj";

await test("文件工具的相对路径、bash 的默认目录、搜索的默认范围都落到工作区", () => {
  assert.deepEqual(toWorkspace("write", { path: "sum.js", content: "x" }, W), { path: "/w/proj/sum.js", content: "x" });
  assert.deepEqual(toWorkspace("read", { path: "src/a.js" }, W), { path: "/w/proj/src/a.js" });
  assert.deepEqual(toWorkspace("bash", { command: "node sum.js" }, W), { command: "node sum.js", cwd: W });
  assert.deepEqual(toWorkspace("bash", { command: "ls", cwd: "sub" }, W), { command: "ls", cwd: "/w/proj/sub" });
  assert.deepEqual(toWorkspace("grep", { pattern: "x" }, W), { pattern: "x", path: W });
  assert.deepEqual(toWorkspace("ast_edit", { paths: ["src/**/*.js", "/abs/x.js"] }, W), { paths: ["/w/proj/src/**/*.js", "/abs/x.js"] });
  assert.deepEqual(toWorkspace("write", { path: "[a.js#ab12]" }, W), { path: "[/w/proj/a.js#ab12]" });
});

await test("edit 补丁头里的相对路径改到工作区，正文和绝对路径不动", () => {
  const out = toWorkspace("edit", { input: "[src/a.js#ab12]\nPUT 1.=1:\n+[x#ffff]\n*** Update File: b.js\nMV \"c d.js\"\n[/abs/e.js#0000]" }, W).input;
  assert.equal(out, "[/w/proj/src/a.js#ab12]\nPUT 1.=1:\n+[x#ffff]\n*** Update File: /w/proj/b.js\nMV \"/w/proj/c d.js\"\n[/abs/e.js#0000]");
});

await test("绝对路径、~、内部 URL、没设工作区、别的工具：不改", () => {
  for (const path of ["/etc/hosts", "~/a", "~", "xd://delegate_bot", "local://x", "file:///a"]) assert.equal(toWorkspace("read", { path }, W), null, path);
  assert.equal(toWorkspace("bash", { command: "ls", cwd: "/abs" }, W), null);
  assert.equal(toWorkspace("write", { path: "a" }, ""), null);
  assert.equal(toWorkspace("todo", { op: "init" }, W), null);
  assert.equal(toWorkspace("eval", { code: "open('a')" }, W), null);
});

await test("生成的扩展真的改参数；改完再过硬拦和写入边界；人格里写清落点", async () => {
  const sandbox = mkdtempSync(join("/var/tmp", "omp-bot-ws-"));
  const ompbotHome = join(sandbox, ".ompbot");
  const cwd = join(ompbotHome, "team", "bots", "b1");
  const ws = join(sandbox, "proj");
  for (const d of [cwd, ws]) mkdirSync(d, { recursive: true });
  writeFileSync(join(ompbotHome, "runtime.json"), "{}");
  try {
    const load = async (fields) => {
      const { argv, personaPath } = writePersonaFiles({ id: "b1", workspace: ws, ...fields }, join(sandbox, "persona"), { writeRoots: { cwd, roots: [ws] }, secretDirs: { ompbotHome } });
      const handlers = {};
      const mod = await import(`${pathToFileURL(argv[argv.indexOf("--extension") + 1]).href}?${Math.random()}`);
      mod.default({ on: (name, fn) => { handlers[name] = fn; } });
      return { h: handlers.tool_call, req: handlers.before_provider_request, personaPath };
    };
    const ask = await load({ executionMode: "supervised", approvalMode: "write" });
    assert.deepEqual(await ask.h({ toolName: "write", input: { path: "sum.js", content: "x" } }, { hasUI: false, cwd }), { input: { path: join(ws, "sum.js"), content: "x" } });
    assert.deepEqual(await ask.h({ toolName: "bash", input: { command: "node sum.js" } }, { hasUI: false, cwd }), { input: { command: "node sum.js", cwd: ws } });
    // 改写后跑出工作区：写入边界拦的是真实位置
    const out = await ask.h({ toolName: "write", input: { path: "../outside.txt" } }, { hasUI: false, cwd });
    assert.equal(out.block, true);
    assert.match(out.reason, new RegExp(join(sandbox, "outside.txt")));
    // 改写后碰到密钥：照样硬拦
    const full = await load({ executionMode: "full", approvalMode: "yolo" });
    const secret = await full.h({ toolName: "read", input: { path: "../.ompbot/runtime.json" } }, { hasUI: false, cwd });
    assert.equal(secret.block, true);
    assert.deepEqual(await full.h({ toolName: "write", input: { path: "a.txt" } }, { hasUI: false, cwd }), { input: { path: join(ws, "a.txt") } });
    assert.equal(await full.h({ toolName: "write", input: { path: join(cwd, "AGENTS.md") } }, { hasUI: false, cwd }), undefined, "绝对路径原样放行");
    // OMP 每轮注入的当前目录也换成工作区，模型看到的和工具落的一致
    const reminder = `<system-reminder>\nToday: 2026-10-17; current working directory: '${cwd}'. Do not repeat.\n</system-reminder>`;
    const payload = await ask.req({ type: "before_provider_request", payload: { model: "m", messages: [{ role: "user", content: [{ type: "text", text: reminder }] }] } }, { cwd });
    assert.match(payload.messages[0].content[0].text, new RegExp(`current working directory: '${ws}'`));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  const text = personaText({ workspace: W, botDir: "/h/team/bots/b1" });
  assert.match(text, /工作区是 \/w\/proj.*相对路径和不带 cwd 的命令都落在工作区/);
  assert.match(text, /记进你自己的 \/h\/team\/bots\/b1\/AGENTS\.md/);
});

await test("请求体：只换 OMP 那句当前目录，别的不碰；没设工作区不改", () => {
  const payload = {
    model: "m", stream: true, max_tokens: 10,
    system: [{ type: "text", text: "x current working directory: '/b/1'. y" }],
    messages: [{ role: "assistant", content: [{ type: "text", text: "我在 /b/1 里" }] }],
  };
  const out = payloadToWorkspace(payload, "/b/1", W);
  assert.equal(out.system[0].text, "x current working directory: '/w/proj'. y");
  assert.deepEqual(out.messages, payload.messages);
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 10);
  assert.equal(payloadToWorkspace(payload, "/b/1", ""), undefined);
  assert.equal(payloadToWorkspace({ messages: [{ content: "hi" }] }, "/b/1", W), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// test/write-guard.mjs — 要我同意档的写文件边界（OMP tool_call 扩展），零模型调用。
// 事件形状照 OMP packages/coding-agent/src/extensibility（main@eb74cf84）：
// tool_call 事件 {toolName, input}，返回 {block, reason} 拦下；ctx.ui.confirm 在 rpc-ui 下发 extension_ui_request。
// edit 的三种整段格式照 crates/pi-edit/grammars 的 hashline / apply_patch / sloppy。

import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkWrite, guardToolCall, writeTargets } from "../src/write-guard.mjs";
import { writePersonaFiles } from "../src/persona.mjs";
import { BotRuntime } from "../src/bot.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const sandbox = mkdtempSync(join("/var/tmp", "omp-bot-guard-"));
const cwd = join(sandbox, "team", "bots", "b1");
const workspace = join(sandbox, "project");
const outsideDir = join(sandbox, "elsewhere");
for (const d of [cwd, workspace, outsideDir]) mkdirSync(d, { recursive: true });
symlinkSync(outsideDir, join(cwd, "link"));
const opts = { cwd, roots: [workspace], tmp: join(sandbox, "tmp") };
const outsideOf = (tool, input) => checkWrite(tool, input, opts).outside;

await test("各种写法都抠得出目标路径，正文行不算", () => {
  assert.deepEqual(writeTargets("write", { path: "[a.txt#1A2B]", content: "x" }).paths, ["a.txt"]);
  assert.deepEqual(writeTargets("edit", { path: "a.ts", edits: [{ rename: "b.ts" }] }).paths, ["a.ts", "b.ts"]);
  const hashline = "*** Begin Patch\n[src/a.ts#00FF]\nPUT 3.=3:\n+[/etc/passwd#ABCD]\n  [~/.bashrc#1234]\nREM\nMV  ../out.ts\n*** End Patch\n";
  assert.deepEqual(writeTargets("edit", { input: hashline }).paths, ["src/a.ts", "~/.bashrc", "../out.ts"]);
  const apply = "*** Begin Patch\n*** Add File: n.txt\n+hi\n*** Update File: u.txt\n*** Move to: /etc/x\n@@\n-a\n+b\n*** Delete File: d.txt\n*** End Patch";
  assert.deepEqual(writeTargets("edit", { input: apply }).paths, ["n.txt", "u.txt", "/etc/x", "d.txt"]);
  const sloppy = "*** edit file: a.ts all\n*** Find\nx\n*** Replace\ny\n*** Edit File:\n*** Find\nz\n*** Replace\n";
  assert.deepEqual(writeTargets("edit", { input: sloppy }).paths, ["a.ts"]);
  assert.deepEqual(writeTargets("ast_edit", { paths: ["src/**/*.ts", "/etc/*.conf"] }).paths, ["src/", "/etc/"]);
  assert.deepEqual(writeTargets("ast_edit", {}), { paths: ["."], unknown: false });
  assert.equal(writeTargets("edit", { input: "PUT 3.=3:\n+x\n" }).unknown, true);
  assert.equal(writeTargets("write", { content: "x" }).unknown, true);
});

await test("目录里、工作区、临时目录、内部 URL 放行；外面、~、..、软链出去、前缀冒充都算外面", () => {
  assert.deepEqual(outsideOf("write", { path: "work/notes.md" }), []);
  assert.deepEqual(outsideOf("write", { path: join(workspace, "src/a.ts") }), []);
  assert.deepEqual(outsideOf("write", { path: join(opts.tmp, "scratch") }), []);
  assert.deepEqual(outsideOf("write", { path: "local://plan.md" }), []);
  assert.equal(outsideOf("write", { path: "~/.bashrc" })[0], join(homedir(), ".bashrc"));
  assert.equal(outsideOf("write", { path: "../../AGENTS.md" }).length, 1, "team AGENTS.md 要走提议审核，不许直接改");
  assert.equal(outsideOf("write", { path: "link/x.txt" })[0], join(outsideDir, "x.txt"));
  assert.equal(outsideOf("write", { path: `${workspace}-evil/x` }).length, 1);
  assert.equal(outsideOf("write", { path: "file:///etc/passwd" })[0], "/etc/passwd");
  assert.equal(outsideOf("ast_edit", { paths: ["/etc/*.conf"] }).length, 1);
  assert.deepEqual(outsideOf("ast_edit", { paths: ["src/**/*.ts"] }), []);
});

function fakeCtx(answer) {
  const calls = [];
  return { calls, ctx: { hasUI: true, cwd, ui: { confirm: async (title, msg) => { calls.push({ title, msg }); return answer; } } } };
}

await test("范围内不弹卡；范围外弹卡，同意才放行，不同意或没 UI 就拦", async () => {
  let f = fakeCtx(true);
  assert.equal(await guardToolCall({ toolName: "edit", input: { path: "a.ts" } }, f.ctx, opts), undefined);
  assert.equal(await guardToolCall({ toolName: "bash", input: { command: "echo > ~/.bashrc" } }, f.ctx, opts), undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(await guardToolCall({ toolName: "write", input: { path: "~/.ssh/authorized_keys" } }, f.ctx, opts), undefined);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].msg, /authorized_keys/);
  f = fakeCtx(false);
  const no = await guardToolCall({ toolName: "write", input: { path: "/etc/hosts" } }, f.ctx, opts);
  assert.equal(no.block, true);
  assert.match(no.reason, /\/etc\/hosts/);
  const headless = await guardToolCall({ toolName: "write", input: { path: "/etc/hosts" } }, { hasUI: false, ui: {} }, opts);
  assert.equal(headless.block, true);
});

await test("看不出写哪儿也弹卡", async () => {
  const f = fakeCtx(false);
  const r = await guardToolCall({ toolName: "edit", input: { input: "PUT 1.=1:\n+x\n" } }, f.ctx, opts);
  assert.equal(r.block, true);
  assert.match(f.calls[0].msg, /看不出/);
});

await test("除了聊天档都挂扩展；写文件边界只在要我同意档拦；生成的模块能被加载并真的拦", async () => {
  const dir = join(sandbox, "persona");
  const load = async (fields) => {
    const { argv } = writePersonaFiles({ id: "b1", ...fields }, dir, { writeRoots: { cwd, roots: [workspace] } });
    if (!argv.includes("--extension")) return null;
    const guardPath = argv[argv.indexOf("--extension") + 1];
    assert.ok(!guardPath.startsWith(cwd), "扩展文件不放在 bot 能直接改的 cwd 里");
    const handlers = {};
    const mod = await import(`${pathToFileURL(guardPath).href}?${Math.random()}`);
    mod.default({ on: (name, fn) => { handlers[name] = fn; } });
    return handlers.tool_call;
  };
  const etc = { toolName: "write", input: { path: "/etc/hosts" } };
  assert.equal(await load({ executionMode: "chat" }), null);
  const ask = await load({ executionMode: "supervised", approvalMode: "write" });
  assert.equal((await ask(etc, { hasUI: false })).block, true);
  assert.equal(await ask({ toolName: "write", input: { path: join(workspace, "ok.txt") } }, { hasUI: false }), undefined);
  for (const fields of [{ executionMode: "supervised", approvalMode: "always-ask" }, { executionMode: "full", approvalMode: "yolo" }]) {
    const h = await load(fields);
    assert.equal(await h(etc, { hasUI: false }), undefined, JSON.stringify(fields));
  }
});

await test("BotRuntime 启动参数带上 cwd 和工作区", async () => {
  const home = join(sandbox, "home");
  const bot = { id: "b2", name: "乙", executionMode: "supervised", approvalMode: "write", workspace };
  const rt = new BotRuntime({ bot, scope: "private", home, bin: "omp-fixture" });
  const { args } = rt._buildArgs();
  const src = readFileSync(args[args.indexOf("--extension") + 1], "utf8");
  assert.ok(src.includes(JSON.stringify(rt.cwd)) && src.includes(JSON.stringify(workspace)));
});

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

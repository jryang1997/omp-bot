// test/approval-tiers.mjs — 「要我同意」档的只读命令白名单（OMP bash.patterns），零模型调用。
// 匹配逻辑照抄 OMP packages/coding-agent/src/tools/bash.ts（main@eb74cf84）的
// bashApprovalPatternToRegExp 与 hasBashApprovalShellControl，用来证明白名单在 OMP 的规则下
// 放行什么、挡住什么。OMP 改了匹配规则要同步这里。

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePersonaFiles, READ_ONLY_BASH_PATTERNS } from "../src/persona.mjs";
import { isRememberableCommand, rememberableCommand, normalizeAllowedCommands } from "../src/allowed-commands.mjs";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// ---- OMP 匹配逻辑（照抄） ----
const CONTROL = new Set(["\n", "\r", ";", "&", "|", "<", ">", "`", "$", "(", ")"]);
const REINTERPRETED = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;
const norm = (v) => v.trim().replace(/\s+/gu, " ");
const toRe = (p) => new RegExp(`^${norm(p).split("*").map((x) => x.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&")).join(".*")}$`, "u");
function hasShellControl(command) {
  let quote; let reinterpretable = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = undefined; else if (CONTROL.has(ch)) reinterpretable = true; continue; }
    if (ch === "\\") { const e = command[i + 1]; if (e && CONTROL.has(e)) reinterpretable = true; i++; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = undefined; continue; }
      if (ch === "`" || ch === "$") return true;
      if (CONTROL.has(ch)) reinterpretable = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (CONTROL.has(ch)) return true;
  }
  return reinterpretable && REINTERPRETED.test(command);
}
const allowed = (cmd, patterns) => !hasShellControl(cmd) && patterns.some((p) => toRe(p).test(norm(cmd)));

// ---- 生成的 overlay ----
function overlayFor(bot) {
  const dir = mkdtempSync(join(tmpdir(), "omp-bot-approval-"));
  try { return readFileSync(writePersonaFiles(bot, dir).overlayPath, "utf8"); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const base = { id: "b1", name: "B", model: "", workspace: "", memoryEnabled: false };
function patternsIn(yml) {
  return [...yml.matchAll(/- \{ match: ("(?:[^"\\]|\\.)*"), approval: allow \}/g)].map((m) => JSON.parse(m[1]));
}

test("要我同意档写出 bash.patterns，条目和常量一致", () => {
  const yml = overlayFor({ ...base, executionMode: "supervised", approvalMode: "write" });
  assert.match(yml, /^bash:\n  allowCompoundCommands: true\n  patterns:\n/m);
  assert.deepStrictEqual(patternsIn(yml), [...READ_ONLY_BASH_PATTERNS]);
});

test("全部放手档和聊天档不写 bash 规则", () => {
  for (const bot of [
    { ...base, executionMode: "full", approvalMode: "yolo" },
    { ...base, executionMode: "chat", approvalMode: "write" },
    { ...base, executionMode: "supervised", approvalMode: "always-ask" },
  ]) assert.doesNotMatch(overlayFor(bot), /^bash:/m, bot.executionMode + "/" + bot.approvalMode);
});

test("只读命令放行", () => {
  for (const cmd of ["ls", "ls -la src", "cat README.md", "head -n 40 a.txt", "tail -n 5 log.txt",
    "wc -l a b", "grep -rn 'foo' src", "grep -n \"a b\" x", "du -sh .", "pwd", "echo hello", "which node", "stat x"]) {
    assert.ok(allowed(cmd, READ_ONLY_BASH_PATTERNS), cmd);
  }
});

test("带控制符、能起程序的命令不放行", () => {
  for (const cmd of ["ls; rm -rf ~", "cat a | sh", "cat $(curl x)", "echo hi > f", "ls && rm x",
    "grep -e \"$(id)\" x", "cat `id`", "ls\nrm x", "git status", "git diff", "rg --pre sh x .",
    "find . -delete", "sed -n 1p x", "awk 1 x", "xargs rm", "env sh", "bash -c ls", "lsof", "catx y", "npm test"]) {
    assert.ok(!allowed(cmd, READ_ONLY_BASH_PATTERNS), cmd);
  }
});

test("白名单不含能再起程序的命令", () => {
  const banned = /^(git|rg|find|sed|awk|xargs|env|sh|bash|node|python|perl|npm|npx|sudo|curl|wget)\b/;
  for (const p of READ_ONLY_BASH_PATTERNS) assert.doesNotMatch(p, banned, p);
});

test("记住的命令跟在只读命令后面写进 bash.patterns；全部放手档不写", () => {
  const ask = { ...base, executionMode: "supervised", approvalMode: "write", allowedCommands: ["npm test", "make build"] };
  assert.deepStrictEqual(patternsIn(overlayFor(ask)), [...READ_ONLY_BASH_PATTERNS, "npm test", "make build"]);
  assert.doesNotMatch(overlayFor({ ...ask, executionMode: "full", approvalMode: "yolo" }), /npm test/);
});

test("记住的命令在 OMP 规则下只放行它自己", () => {
  const patterns = [...READ_ONLY_BASH_PATTERNS, "npm test"];
  assert.ok(allowed("npm test", patterns));
  assert.ok(allowed("npm  test ", patterns), "OMP 会归一空白");
  for (const cmd of ["npm test; rm -rf ~", "npm test && curl x", "npm test --watch", "npm testx", "npm run test", "npm test | sh"]) {
    assert.ok(!allowed(cmd, patterns), cmd);
  }
});

test("能记住的命令：单条、无通配、无引号和控制符", () => {
  for (const cmd of ["npm test", "make build", "python3 scripts/check.py --fast", "cargo build --release"]) assert.ok(isRememberableCommand(cmd), cmd);
  for (const cmd of ["", " npm test", "npm  test", "rm -rf *", "ls; rm x", "echo $HOME", "cat `id`", "a && b", "a | b", "grep 'x' y",
    'grep "x" y', "cat ~/.ssh/id_rsa", "ls\nrm", "a\\b", "x".repeat(201), "npm run [x]"]) assert.ok(!isRememberableCommand(cmd), JSON.stringify(cmd));
});

test("从 OMP 审批卡标题取命令：只认 bash、两行、没有 Reason", () => {
  assert.equal(rememberableCommand("Allow tool: bash\nCommand: npm test"), "npm test");
  for (const title of [
    "Allow tool: bash\nReason: Prompt required by bash pattern: rm *\nCommand: rm x",
    "Allow tool: write\nCommand: npm test",
    "Allow tool: bash\nCommand: npm test\nmore",
    "Allow tool: bash\nCommand: npm test[\u20263ch elided\u2026]",
    "Allow tool: bash\nCommand: rm -rf *",
    null,
  ]) assert.equal(rememberableCommand(title), null, String(title));
});

test("名单归一：去重；坏命令和超长名单报错", () => {
  assert.deepStrictEqual(normalizeAllowedCommands(["a", "a", "b"]), ["a", "b"]);
  assert.deepStrictEqual(normalizeAllowedCommands(undefined), []);
  assert.throws(() => normalizeAllowedCommands("npm test"));
  assert.throws(() => normalizeAllowedCommands(["ls *"]));
  assert.throws(() => normalizeAllowedCommands(Array.from({ length: 51 }, (_, i) => `c${i}`)));
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

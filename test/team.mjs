// test/team.mjs — 团队架构重构（.scratch/team-rebuild）的行为测试，零模型调用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { makeBot, normalizeBot, permissionOf, permissionModes } from "../src/domain.mjs";
import { BotRuntime } from "../src/bot.mjs";
import { Computers } from "../src/features/computers.mjs";
import { COMPUTER_TOOL_NAMES } from "../src/constants.mjs";
import { Orchestrator } from "../src/orchestrator.mjs";
import { permissionOf as uiPermissionOf, BOT_PERMISSION_LABELS } from "../web/workbench-core.js";

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`);
    }
  });
}
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// ---------------- 05 审批 3 档 ----------------
const LEGACY = [
  ["chat", "always-ask", "chat"], ["chat", "write", "chat"], ["chat", "yolo", "chat"],
  ["supervised", "always-ask", "ask"], ["supervised", "write", "ask"], ["supervised", "yolo", "full"],
  ["full", "always-ask", "ask"], ["full", "write", "ask"], ["full", "yolo", "full"],
];
test("05 九种旧组合归到三档", () => {
  for (const [executionMode, approvalMode, level] of LEGACY) {
    assert.equal(permissionOf({ executionMode, approvalMode }), level, `${executionMode}+${approvalMode}`);
    const bot = normalizeBot({ id: "b1", name: "甲", executionMode, approvalMode });
    assert.equal(permissionOf(bot), level);
    assert.deepEqual({ executionMode: bot.executionMode, approvalMode: bot.approvalMode }, permissionModes(level));
  }
});
test("05 界面和核心用同一条归一规则", () => {
  for (const [executionMode, approvalMode, level] of LEGACY) {
    assert.equal(uiPermissionOf({ executionMode, approvalMode }), level, `${executionMode}+${approvalMode}`);
  }
  assert.equal(uiPermissionOf({}), "ask");
  assert.deepEqual(Object.keys(BOT_PERMISSION_LABELS), ["chat", "ask", "full"]);
});
test("05 三档各对应一种内部组合", () => {
  assert.deepEqual(permissionModes("chat"), { executionMode: "chat", approvalMode: "write" });
  assert.deepEqual(permissionModes("ask"), { executionMode: "supervised", approvalMode: "write" });
  assert.deepEqual(permissionModes("full"), { executionMode: "full", approvalMode: "yolo" });
  assert.throws(() => permissionModes("sandbox"), /未知权限档/);
  assert.equal(makeBot({ id: "b", name: "乙" }).approvalMode, "write");
});
test("05 接口按三档改 bot，全部放手要确认，旧字段照样归一", async () => {
  const home = tmp("ompbot-perm-");
  try {
    const orch = new Orchestrator({ home, bin: "omp-fixture", runtimeFactory: () => { throw new Error("不应启动"); } });
    const bot = orch.addBot({ name: "丙" });
    assert.equal(permissionOf(bot), "ask");
    assert.throws(() => orch.updateBot(bot.id, { permission: "full" }), (e) => e.code === "confirm_permission_required");
    assert.equal(permissionOf(orch.updateBot(bot.id, { permission: "full", confirmPermission: true })), "full");
    assert.equal(permissionOf(orch.updateBot(bot.id, { permission: "chat" })), "chat");
    // 旧接口：supervised + yolo（带旧确认）归到全部放手
    const again = orch.updateBot(bot.id, { executionMode: "supervised", approvalMode: "yolo", confirmApprovalMode: true });
    assert.equal(permissionOf(again), "full");
    assert.throws(() => orch.addBot({ name: "丁", permission: "full" }), (e) => e.code === "confirm_permission_required");
    assert.equal(permissionOf(orch.addBot({ name: "戊", permission: "full", confirmPermission: true })), "full");
    assert.throws(() => orch.updateBot(bot.id, { permission: "nope" }), (e) => e.code === "permission_invalid");
    await orch.shutdown?.();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------- 06 绑定电脑只加能力 ----------------
const COMPUTER = { runtime: "qemu", kind: "vm", image: "cua-linux" };
function launch(home, botFields) {
  const bot = makeBot({ id: "bot_pc", name: "电脑人", computer: COMPUTER, ...botFields });
  const rt = new BotRuntime({ bot, scope: "private", home, bin: "omp-fixture" });
  const { args } = rt._buildArgs();
  const overlay = readFileSync(args[args.indexOf("--config") + 1], "utf8");
  return { args, overlay, rt };
}
test("06 绑定电脑的可执行档保留本机工具、扩展、技能和 MCP", () => {
  const home = tmp("ompbot-pc-");
  try {
    for (const level of ["ask", "full"]) {
      const { args, overlay, rt } = launch(home, permissionModes(level));
      for (const flag of ["--no-tools", "--no-extensions", "--no-skills"]) assert.ok(!args.includes(flag), `${level} 不应有 ${flag}`);
      assert.equal(rt.narrowedTools, false);
      assert.doesNotMatch(overlay, /enableProjectConfig/);
      assert.deepEqual(rt._narrowedDisabledExtensions(), []);
      for (const name of COMPUTER_TOOL_NAMES) assert.match(overlay, new RegExp(`^    ${name}: allow$`, "m"), `${level} ${name}`);
    }
    // 技能过滤照常生效，不再因为绑定电脑整体关闭
    assert.ok(launch(home, { skills: ["git-*"] }).args.includes("--skills"));
    assert.ok(launch(home, { skills: [] }).args.includes("--no-skills"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("06 只聊天档的收窄不变", () => {
  const home = tmp("ompbot-pc-chat-");
  try {
    const { args, overlay, rt } = launch(home, permissionModes("chat"));
    assert.ok(args.includes("--no-tools") && args.includes("--no-extensions"));
    assert.equal(rt.narrowedTools, true);
    assert.match(overlay, /enableProjectConfig: false/);
    assert.doesNotMatch(overlay, /computer_/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("06 客机工具描述以「在 Linux 共享电脑里」开头", () => {
  const home = tmp("ompbot-pc-tools-");
  try {
    const computers = new Computers({ orch: { home }, home, backend: {} });
    const bot = makeBot({ id: "bot_pc", name: "电脑人", computer: COMPUTER });
    const tools = computers.guestTools({ bot, runtime: null });
    assert.deepEqual(tools.map((t) => t.name), [...COMPUTER_TOOL_NAMES]);
    for (const t of tools) assert.ok(t.description.startsWith("在 Linux 共享电脑里"), `${t.name}: ${t.description}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const run of pending) await run();
console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

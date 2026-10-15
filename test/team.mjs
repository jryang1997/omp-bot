// test/team.mjs — 团队架构重构（.scratch/team-rebuild）的行为测试，零模型调用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBot, normalizeBot, permissionOf, permissionModes } from "../src/domain.mjs";
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

for (const run of pending) await run();
console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

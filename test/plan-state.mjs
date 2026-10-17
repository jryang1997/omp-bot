// 08 计划状态：OMP 原生 todo 工具的结果里带着完整计划，工作台直接拿来显示。
import assert from "node:assert/strict";
import { parseNativeFrame, planFromTool } from "../web/workbench-native.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`);
  }
}

const phases = [
  { name: "调研", tasks: [{ content: "读文档", status: "completed" }, { content: "列方案", status: "in_progress" }] },
  { name: "实现", tasks: [{ content: "写代码", status: "pending" }, { content: "等账号", status: "blocked", blocker: "主人还没给权限" }, { content: "旧思路", status: "abandoned" }] },
];
const end = (over = {}) => ({
  type: "tool_execution_end",
  toolCallId: "call-1",
  toolName: "todo",
  result: { content: [{ type: "text", text: "Remaining items (2)" }], details: { op: "done", phases, storage: "session" } },
  ...over,
});

test("todo 工具结束帧里取出完整计划，状态和卡住原因都在", () => {
  const plan = planFromTool(parseNativeFrame(end()));
  assert.deepEqual(plan, phases);
});

test("只是查看计划不算改动", () => {
  const frame = end({ result: { content: [], details: { op: "view", phases } } });
  assert.equal(planFromTool(parseNativeFrame(frame)), null);
});

test("出错的 todo 调用不更新计划", () => {
  assert.equal(planFromTool(parseNativeFrame(end({ isError: true }))), null);
});

test("别的工具、开始帧都不算", () => {
  assert.equal(planFromTool(parseNativeFrame(end({ toolName: "bash" }))), null);
  assert.equal(planFromTool(parseNativeFrame(end({ type: "tool_execution_start" }))), null);
});

test("形状不对就不显示，不猜", () => {
  const bad = end({ result: { details: { op: "init", phases: [{ name: "x", tasks: [{ content: "y", status: "weird" }] }] } } });
  assert.equal(planFromTool(parseNativeFrame(bad)), null);
  assert.equal(planFromTool(parseNativeFrame(end({ result: { content: [] } }))), null);
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

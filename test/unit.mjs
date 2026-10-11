// test/unit.mjs — 纯函数单元测试，零模型调用。
// 用本机 omp 18.8.9 实测的 get_session_stats 结构断言 usage 归一化。
// 也覆盖 domain 的 @mention 解析与 [PASS] 判定这两处分支逻辑。

import { normalizeStats } from "../src/usage.mjs";
import { parseMentions, isPass, hasMentionAll, appendRoomLog, makeMessage } from "../src/domain.mjs";
import assert from "node:assert";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ---- usage.normalizeStats：真实形状 ----
const realStats = {
  sessionFile: "C:\\x\\s\\y.jsonl",
  sessionId: "01a12bcf",
  userMessages: 3,
  assistantMessages: 3,
  toolCalls: 2,
  tokens: { input: 6098, output: 161, reasoning: 158, cacheRead: 0, cacheWrite: 0, total: 6259 },
  cost: 0.0123,
  contextUsage: { tokens: 6098, contextWindow: 1000000, percent: 0.6098 },
};

test("normalizeStats 解析嵌套 tokens 与顶层 cost", () => {
  const n = normalizeStats(realStats);
  assert.strictEqual(n.tokensIn, 6098);
  assert.strictEqual(n.tokensOut, 161);
  assert.strictEqual(n.reasoning, 158);
  assert.strictEqual(n.totalTokens, 6259);
  assert.strictEqual(n.cost, 0.0123);
  assert.strictEqual(n.requests, 3);
  assert.strictEqual(n.toolCalls, 2);
  assert.ok(Math.abs(n.contextPercent - 0.6098) < 1e-9);
});

test("normalizeStats 缺 total 时用 input+output 兜底", () => {
  const n = normalizeStats({ tokens: { input: 100, output: 40 } });
  assert.strictEqual(n.totalTokens, 140);
});

test("normalizeStats 对 null/非对象不抛错", () => {
  assert.strictEqual(normalizeStats(null).raw, null);
  assert.strictEqual(normalizeStats(undefined).raw, null);
});

// ---- domain：@mention 解析（最长名优先，防前缀误命中）----
const bots = [
  { id: "1", name: "Bob" },
  { id: "2", name: "Bobby" },
  { id: "3", name: "Ann" },
];

test("parseMentions 最长名优先：@Bobby 命中 Bobby 而非 Bob", () => {
  const hit = parseMentions("交给 @Bobby 处理", bots);
  assert.deepStrictEqual(hit.map((b) => b.name), ["Bobby"]);
});

test("parseMentions 多个 @ 都识别、去重、保序", () => {
  const hit = parseMentions("@Ann 和 @Bob 一起看，@Ann 再看一遍", bots);
  assert.deepStrictEqual(hit.map((b) => b.name), ["Ann", "Bob"]);
});

test("parseMentions 名字后紧跟字母不误命中", () => {
  // @Bobbyx 不应命中 Bobby（尾随 \w）
  const hit = parseMentions("提到 @Bobbyx 这个人", bots);
  assert.deepStrictEqual(hit, []);
});

test("parseMentions 无 @ 返回空", () => {
  assert.deepStrictEqual(parseMentions("没有点名任何人", bots), []);
});

test("hasMentionAll 识别 @all，普通文本不误判", () => {
  assert.strictEqual(hasMentionAll("各位 @all 注意"), true);
  assert.strictEqual(hasMentionAll("@allstar 来了"), false);
  assert.strictEqual(hasMentionAll("没点名"), false);
});

// ---- domain：[PASS] 判定 ----
test("isPass 认空串、[PASS]、大小写与空白", () => {
  assert.strictEqual(isPass(""), true);
  assert.strictEqual(isPass("   "), true);
  assert.strictEqual(isPass("[PASS]"), true);
  assert.strictEqual(isPass("  [pass]  "), true);
});

test("isPass 对有内容文本返回 false", () => {
  assert.strictEqual(isPass("我有话说"), false);
  assert.strictEqual(isPass("[PASS] 但我补充一句"), false);
});

// ---- domain：room.log 裁剪 ----
test("appendRoomLog 超过上限裁剪到最近 N 条", () => {
  const room = { log: [] };
  for (let i = 0; i < 70; i++) {
    appendRoomLog(room, makeMessage({ kind: "user", from: "u", fromName: "U", text: `m${i}` }));
  }
  assert.strictEqual(room.log.length, 60);
  assert.strictEqual(room.log[0].text, "m10");
  assert.strictEqual(room.log[59].text, "m69");
});

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

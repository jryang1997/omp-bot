// test/team.mjs — 团队架构重构（.scratch/team-rebuild）的行为测试，零模型调用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeBot, normalizeBot, permissionOf, permissionModes } from "../src/domain.mjs";
import { BotRuntime } from "../src/bot.mjs";
import { Computers } from "../src/features/computers.mjs";
import { COMPUTER_TOOL_NAMES } from "../src/constants.mjs";
import { TEAM_AGENTS_TEMPLATE, parseIdentityBlock, renderIdentityBlock, replaceIdentityBlock, teamPaths } from "../src/team.mjs";
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

// ---------------- 01 bot 在 team 目录里启动 ----------------
const noRuntime = () => { throw new Error("不应启动"); };
const gitLog = (root) => execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
async function withOrch(home, fn, opts = {}) {
  const orch = new Orchestrator({ home, bin: "omp-fixture", runtimeFactory: noRuntime, ...opts });
  try {
    return await fn(orch);
  } finally {
    await orch.shutdown();
  }
}

test("01 第一次启动建出目录树和模板，再次启动不覆盖改过的模板", async () => {
  const home = tmp("ompbot-team-");
  try {
    const root = join(home, "team");
    await withOrch(home, async (orch) => {
      for (const d of ["skills", "workspace", ".memory", "bots", ".git"]) assert.ok(existsSync(join(root, d)), d);
      assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), TEAM_AGENTS_TEMPLATE);
      const ignore = readFileSync(join(root, ".gitignore"), "utf8");
      for (const line of [".memory/", "workspace/", "bots/*/sessions/", "bots/*/work/"]) assert.match(ignore, new RegExp(`^${line.replace(/[*.]/g, "\\$&")}$`, "m"));
      assert.equal(orch.teamStatus().git, true);
    });
    writeFileSync(join(root, "AGENTS.md"), "# 我们自己的规矩\n", "utf8");
    await withOrch(home, async () => {
      assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# 我们自己的规矩\n");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("01 有 git 时是真仓库并有初始提交；没有 git 时有 .git 骨架", async () => {
  const withGit = tmp("ompbot-team-git-");
  const noGit = tmp("ompbot-team-nogit-");
  try {
    await withOrch(withGit, async () => {});
    const log = gitLog(join(withGit, "team"));
    assert.equal(log.length, 1);
    assert.match(log[0], /建立团队目录/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: join(withGit, "team"), encoding: "utf8" }), "");

    await withOrch(noGit, async (orch) => assert.equal(orch.teamStatus().git, false), { teamGit: false });
    const gitDir = join(noGit, "team", ".git");
    assert.equal(readFileSync(join(gitDir, "HEAD"), "utf8"), "ref: refs/heads/main\n");
    // 骨架就是合法的空仓库：omp 停在这里，以后装了 git 也能直接用
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: join(noGit, "team", "bots"), encoding: "utf8" }).trim();
    assert.equal(top, join(noGit, "team"));
  } finally {
    rmSync(withGit, { recursive: true, force: true });
    rmSync(noGit, { recursive: true, force: true });
  }
});

test("01 启动参数里 cwd 和会话目录是新路径，私聊群聊共用 cwd、会话分开", () => {
  const home = tmp("ompbot-team-rt-");
  try {
    const bot = makeBot({ id: "bot_cwd", name: "路径" });
    const priv = new BotRuntime({ bot, scope: "private", home, bin: "omp-fixture" });
    const room = new BotRuntime({ bot, scope: "room:r9", home, bin: "omp-fixture" });
    const cwd = join(home, "team", "bots", "bot_cwd");
    assert.equal(priv.cwd, cwd);
    assert.equal(room.cwd, cwd);
    const sessionOf = (rt) => { const { args } = rt._buildArgs(); return args[args.indexOf("--session-dir") + 1]; };
    assert.equal(sessionOf(priv), join(cwd, "sessions", "private"));
    assert.equal(sessionOf(room), join(cwd, "sessions", "room_r9"));
    assert.equal(priv.workDir, join(cwd, "work"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("01 身份块往返：表单只改块内，块外原样；文件里改块内回填花名册", async () => {
  const blockText = renderIdentityBlock({ id: "b", name: "甲", role: "写手", instructions: "第一段\n\n第二段" });
  assert.deepEqual(parseIdentityBlock(blockText), { name: "甲", role: "写手", instructions: "第一段\n\n第二段" });
  assert.deepEqual(parseIdentityBlock(renderIdentityBlock({ id: "b", name: "乙" })), { name: "乙", role: "", instructions: "" });
  const outside = "前言\n\n" + blockText + "\n\n## 我的习惯\n- 先列提纲\n";
  const replaced = replaceIdentityBlock(outside, renderIdentityBlock({ id: "b", name: "甲", role: "编辑" }));
  assert.ok(replaced.startsWith("前言\n\n") && replaced.endsWith("\n\n## 我的习惯\n- 先列提纲\n"));
  assert.equal(parseIdentityBlock(replaced).role, "编辑");

  const home = tmp("ompbot-team-id-");
  try {
    await withOrch(home, async (orch) => {
      const bot = orch.addBot({ name: "小智", role: "产品", instructions: "多问为什么" });
      const file = teamPaths(home, bot.id).agentsFile;
      assert.deepEqual(parseIdentityBlock(readFileSync(file, "utf8")), { name: "小智", role: "产品", instructions: "多问为什么" });
      writeFileSync(file, readFileSync(file, "utf8") + "\n## 小智的笔记\n- 周报放 work/weekly\n", "utf8");
      orch.updateBot(bot.id, { role: "产品经理" });
      const text = readFileSync(file, "utf8");
      assert.equal(parseIdentityBlock(text).role, "产品经理");
      assert.ok(text.endsWith("\n## 小智的笔记\n- 周报放 work/weekly\n"), "块外内容必须原样保留");
      // 用户在文件里改了块内的专属指令和名字
      writeFileSync(file, text.replace("多问为什么", "先给结论").replace("- 名字：小智", "- 名字：小智同学"), "utf8");
      const synced = orch.getBot(bot.id);
      assert.equal(synced.instructions, "先给结论");
      assert.equal(synced.name, "小智同学");
      assert.equal(orch.store.getBot(bot.id).instructions, "先给结论", "回填写进花名册");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("01 老花名册里的 bot 第一次启动补上身份块", async () => {
  const home = tmp("ompbot-team-legacy-");
  try {
    let id;
    await withOrch(home, async (orch) => { id = orch.addBot({ name: "老张", role: "运维" }).id; });
    rmSync(join(home, "team"), { recursive: true, force: true });
    await withOrch(home, async (orch) => {
      await orch.team.flush();
      assert.equal(parseIdentityBlock(readFileSync(teamPaths(home, id).agentsFile, "utf8")).role, "运维");
      assert.ok(gitLog(join(home, "team")).some((m) => m.includes("补上 老张")));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("01 overlay 只关用户级上下文文件，persona.md 只剩团队工具", () => {
  const home = tmp("ompbot-team-ov-");
  try {
    const bot = makeBot({ id: "bot_ov", name: "独一无二的名字", role: "独特角色", instructions: "独特的专属指令" });
    const rt = new BotRuntime({ bot, scope: "private", home, bin: "omp-fixture" });
    const { args } = rt._buildArgs();
    const overlay = readFileSync(args[args.indexOf("--config") + 1], "utf8");
    const disabled = overlay.match(/context-file:[a-z]+:[A-Z]+\.md/g);
    assert.deepEqual(disabled, ["context-file:user:AGENTS.md", "context-file:user:CLAUDE.md", "context-file:user:GEMINI.md"]);
    const persona = readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8");
    for (const word of ["独一无二的名字", "独特角色", "独特的专属指令", "说话方式", "征求同意"]) assert.ok(!persona.includes(word), word);
    assert.match(persona, /message_bot/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("01 任一层 AGENTS.md 变了，进程复用签名就变", () => {
  const home = tmp("ompbot-team-sig-");
  try {
    const bot = makeBot({ id: "bot_sig", name: "签名" });
    const p = teamPaths(home, bot.id);
    const rt = new BotRuntime({ bot, scope: "private", home, bin: "omp-fixture" });
    rt.policySignature = rt._signature();
    assert.equal(rt.matchesPolicy(bot), true);
    mkdirSync(p.cwd, { recursive: true });
    writeFileSync(p.agentsFile, "# 个人\n", "utf8");
    assert.equal(rt.matchesPolicy(bot), false, "个人层变了");
    rt.policySignature = rt._signature();
    writeFileSync(p.teamAgentsFile, "# 团队\n", "utf8");
    assert.equal(rt.matchesPolicy(bot), false, "团队层变了");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("01 omp-bot 改动 team 目录后多一次提交", async () => {
  const home = tmp("ompbot-team-commit-");
  try {
    await withOrch(home, async (orch) => {
      const bot = orch.addBot({ name: "提交者" });
      await orch.team.flush();
      const before = gitLog(join(home, "team")).length;
      orch.updateBot(bot.id, { instructions: "新指令" });
      await orch.team.flush();
      const log = gitLog(join(home, "team"));
      assert.equal(log.length, before + 1);
      assert.match(log[0], /提交者 改了专属指令/);
      orch.updateBot(bot.id, { thinking: "high" });
      await orch.team.flush();
      assert.equal(gitLog(join(home, "team")).length, before + 1, "不碰身份的改动不提交");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const run of pending) await run();
console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

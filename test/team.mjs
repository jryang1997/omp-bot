// test/team.mjs — 团队架构重构（.scratch/team-rebuild）的行为测试，零模型调用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DEFAULT_MASCOT_BODY, MAIN_MASCOT_COLOR, MASCOT_BODY_IDS, MASCOT_COLOR_IDS, MASCOT_EXPRESSIONS, makeBot, makeRoom, mascotColorFor, normalizeBot, permissionOf, permissionModes, roomPrompt, sceneTag, senderOf } from "../src/domain.mjs";
import { writePersonaFiles, personaText } from "../src/persona.mjs";
import { BotRuntime } from "../src/bot.mjs";
import { Computers } from "../src/features/computers.mjs";
import { COMPUTER_TOOL_NAMES } from "../src/constants.mjs";
import { MIGRATION_MARKER, OLD_MEMORY_NOTE, TEAM_AGENTS_TEMPLATE, TEAM_GITIGNORE, memoryBank, parseIdentityBlock, renderIdentityBlock, replaceIdentityBlock, skillArgs, teamPaths } from "../src/team.mjs";
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

// ---------------- 02 旧数据复制进 team ----------------
const put = (file, text, mtime) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf8");
  if (mtime) utimesSync(file, mtime, mtime);
};
/** 造一个升级前的 home：花名册里有 bot，旧布局按 scope 分开，team 目录还不存在。 */
async function legacyHome(prefix) {
  const home = tmp(prefix);
  let id;
  await withOrch(home, async (orch) => { id = orch.addBot({ name: "老王", role: "写手" }).id; });
  rmSync(join(home, "team"), { recursive: true, force: true });
  const old = (scope, rel) => join(home, "bots", id, scope, rel);
  const t = new Date("2025-03-01T08:00:00Z");
  put(old("private", "work/notes.md"), "私聊笔记");
  put(old("private", "work/sub/a.txt"), "A");
  put(old("private", "work/.omp/skills/写周报/SKILL.md"), "---\nname: 写周报\n---\n");
  put(old("private", "work/.omp/mcp.json"), '{"mcpServers":{}}');
  const header = (scope) => `${JSON.stringify({ type: "title", v: 1, title: "" })}\n${JSON.stringify({ type: "session", version: 3, id: scope, cwd: old(scope, "work") })}\n{"type":"message","text":"旧对话"}\n`;
  put(old("private", "sessions/2025-03-01_old.jsonl"), header("private"), t);
  put(old("room_g1", "work/draft.md"), "群里的稿子");
  put(old("room_g1", "work/.omp/skills/群技能/SKILL.md"), "---\nname: 群技能\n---\n");
  put(old("room_g1", "sessions/g.jsonl"), header("room_g1"));
  const mem = old("private", "agent/memories/--old-work--");
  put(join(mem, "memory_summary.md"), "用户喜欢简短回复");
  put(join(mem, "MEMORY.md"), "# 记忆");
  put(join(mem, "raw_memories.md"), "原料");
  put(join(mem, "learned.md"), "   ");
  return { home, id, old, t };
}

test("02 私聊工作目录合到 work 根上，群聊的放 rooms，私有技能和 MCP 配置跟过来", async () => {
  const { home, id, old } = await legacyHome("ompbot-mig-work-");
  try {
    await withOrch(home, async (orch) => {
      await orch.team.flush();
      const p = teamPaths(home, id);
      assert.equal(readFileSync(join(p.workDir, "notes.md"), "utf8"), "私聊笔记");
      assert.equal(readFileSync(join(p.workDir, "sub/a.txt"), "utf8"), "A");
      assert.equal(readFileSync(join(p.workDir, "rooms/room_g1/draft.md"), "utf8"), "群里的稿子");
      assert.ok(!existsSync(join(p.workDir, ".omp")), "旧 work/.omp 不原样搬进 work");
      assert.ok(existsSync(join(p.skillsDir, "写周报/SKILL.md")));
      assert.ok(existsSync(join(p.skillsDir, "群技能/SKILL.md")), "群里装的私有技能也并进来");
      assert.ok(existsSync(join(p.cwd, ".omp/mcp.json")));
      assert.ok(existsSync(old("private", "work/notes.md")) && existsSync(old("room_g1", "sessions/g.jsonl")), "旧目录原样保留");
      assert.ok(existsSync(join(home, "team", MIGRATION_MARKER)));
      assert.ok(gitLog(join(home, "team")).some((m) => m.includes("迁移旧数据：老王")));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("02 旧会话进 sessions/<scope>/，新 runtime 带 --continue 续上", async () => {
  const { home, id, t } = await legacyHome("ompbot-mig-session-");
  try {
    await withOrch(home, async () => {});
    const p = teamPaths(home, id);
    const file = join(p.cwd, "sessions/private/2025-03-01_old.jsonl");
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mtimeMs, t.getTime(), "保留修改时间，omp 按它挑最近的会话");
    assert.ok(existsSync(join(p.cwd, "sessions/room_g1/g.jsonl")));
    // omp 续接时按会话头里的 cwd 找 AGENTS.md：副本要指到新 cwd，旧文件不动
    for (const [scope, name] of [["private", "2025-03-01_old.jsonl"], ["room_g1", "g.jsonl"]]) {
      const lines = readFileSync(join(p.cwd, "sessions", scope, name), "utf8").split("\n");
      assert.equal(JSON.parse(lines[1]).cwd, p.cwd, `${scope} 会话头指到新 cwd`);
      assert.equal(lines[2], '{"type":"message","text":"旧对话"}', "会话内容原样");
      assert.equal(JSON.parse(readFileSync(join(home, "bots", id, scope, "sessions", name), "utf8").split("\n")[1]).cwd, join(home, "bots", id, scope, "work"), "旧会话不改");
    }
    const bot = makeBot({ id, name: "老王" });
    for (const scope of ["private", "room:g1"]) {
      const { args } = new BotRuntime({ bot, scope, home, bin: "omp-fixture" })._buildArgs();
      assert.ok(args.includes("--continue"), `${scope} 续上旧会话`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("02 旧记忆摘要进 work/old-memory/，身份块里有一句提示", async () => {
  const { home, id } = await legacyHome("ompbot-mig-memory-");
  try {
    await withOrch(home, async (orch) => {
      await orch.team.flush();
      const p = teamPaths(home, id);
      const dir = join(p.workDir, "old-memory/private");
      assert.equal(readFileSync(join(dir, "memory_summary.md"), "utf8"), "用户喜欢简短回复");
      assert.ok(existsSync(join(dir, "MEMORY.md")));
      assert.ok(!existsSync(join(dir, "raw_memories.md")), "未整理的原料不带");
      assert.ok(!existsSync(join(dir, "learned.md")), "空文件不带");
      const text = readFileSync(p.agentsFile, "utf8");
      assert.ok(text.includes(OLD_MEMORY_NOTE));
      assert.equal(parseIdentityBlock(text).role, "写手", "提示不影响身份字段");
      orch.updateBot(id, { role: "编辑" });
      assert.ok(readFileSync(p.agentsFile, "utf8").includes(OLD_MEMORY_NOTE), "改身份后提示还在");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("02 第二次启动不再复制；去掉标记重做也不覆盖新文件", async () => {
  const { home, id, old } = await legacyHome("ompbot-mig-again-");
  try {
    await withOrch(home, async () => {});
    const p = teamPaths(home, id);
    writeFileSync(join(p.workDir, "notes.md"), "升级后改过", "utf8");
    put(old("private", "work/later.md"), "后来才放的");
    const commits = gitLog(join(home, "team")).length;
    await withOrch(home, async (orch) => { await orch.team.flush(); });
    assert.ok(!existsSync(join(p.workDir, "later.md")), "有标记就不再迁移");
    assert.equal(gitLog(join(home, "team")).length, commits, "没事可做不提交");
    rmSync(join(home, "team", MIGRATION_MARKER));
    await withOrch(home, async (orch) => { await orch.team.flush(); });
    assert.equal(readFileSync(join(p.workDir, "notes.md"), "utf8"), "升级后改过", "已有文件不被覆盖");
    assert.equal(readFileSync(join(p.workDir, "later.md"), "utf8"), "后来才放的");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("02 全新安装也留标记，不产生多余提交", async () => {
  const home = tmp("ompbot-mig-fresh-");
  try {
    await withOrch(home, async (orch) => {
      await orch.team.flush();
      assert.ok(existsSync(join(home, "team", MIGRATION_MARKER)));
      assert.equal(gitLog(join(home, "team")).length, 1, "建目录和标记合成一次提交");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------- 03 共享技能库 + 每 bot 白名单 ----------------
const skillMd = (name, description = `${name} 的说明`) => `---\nname: ${name}\n${description ? `description: ${description}\n` : ""}---\n\n正文\n`;
const putSkill = (dir, name, description) => put(join(dir, name, "SKILL.md"), skillMd(name, description));

test("03 overlay 的 skills.customDirectories 指向 team/skills", () => {
  const home = tmp("ompbot-skill-overlay-");
  try {
    const bot = makeBot({ id: "bot_sk", name: "技能" });
    const rt = new BotRuntime({ bot, scope: "private", home, bin: "omp-fixture" });
    const { args } = rt._buildArgs();
    const overlay = readFileSync(args[args.indexOf("--config") + 1], "utf8");
    const lib = join(home, "team", "skills");
    assert.ok(overlay.includes(`  customDirectories:\n    - ${JSON.stringify(lib)}`), overlay);
    assert.ok(!args.includes("--skills") && !args.includes("--no-skills"), "白名单为 null 不传 --skills");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("03 白名单为列表时并上私有技能传 --skills，并完为空传 --no-skills", () => {
  const home = tmp("ompbot-skill-args-");
  try {
    const p = teamPaths(home, "bot_sk");
    assert.deepEqual(skillArgs({ skills: null }, p), []);
    assert.deepEqual(skillArgs({ skills: [] }, p), ["--no-skills"]);
    assert.deepEqual(skillArgs({ skills: ["写周报"] }, p), ["--skills", "写周报"]);
    putSkill(p.skillsDir, "私房菜");
    assert.deepEqual(skillArgs({ skills: [] }, p), ["--skills", "私房菜"], "私有技能总是并进来");
    assert.deepEqual(skillArgs({ skills: ["写周报", "私房菜"] }, p), ["--skills", "写周报,私房菜"], "不重复");
    const rt = new BotRuntime({ bot: makeBot({ id: "bot_sk", name: "技能", skills: ["写周报"] }), scope: "room:r1", home, bin: "omp-fixture" });
    const { args } = rt._buildArgs();
    assert.equal(args[args.indexOf("--skills") + 1], "写周报,私房菜", "群聊也带上私有技能");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("03 装技能可选共享库或私有，重名、缺 description、坏名字都被拒绝并说明", async () => {
  const home = tmp("ompbot-skill-install-");
  try {
    await withOrch(home, async (orch) => {
      const a = orch.addBot({ name: "小甲" });
      const b = orch.addBot({ name: "小乙" });
      const lib = orch.installSkill({ botId: a.id, target: "library", content: skillMd("写周报") });
      assert.equal(lib.name, "写周报");
      assert.ok(existsSync(join(home, "team", "skills", "写周报", "SKILL.md")));
      const src = join(home, "src-skill");
      put(join(src, "SKILL.md"), skillMd("查天气"));
      put(join(src, "scripts", "run.sh"), "echo hi");
      const own = orch.installSkill({ botId: b.id, target: "bot", path: src });
      assert.equal(own.files, 2, "整个目录复制过去");
      assert.ok(existsSync(join(teamPaths(home, b.id).skillsDir, "查天气", "scripts", "run.sh")));

      const reject = (input, code, pattern) =>
        assert.throws(() => orch.installSkill(input), (e) => e.code === code && e.status >= 400 && pattern.test(e.message), code);
      reject({ botId: b.id, target: "library", content: skillMd("写周报") }, "skill_name_taken", /共享库里已经有叫「写周报」的技能/);
      reject({ botId: a.id, target: "bot", content: skillMd("查天气") }, "skill_name_taken", /小乙 的私有技能里.*不能重名/);
      orch.installSkill({ botId: a.id, target: "library", content: skillMd("Weather") });
      reject({ botId: b.id, target: "bot", content: skillMd("weather") }, "skill_name_taken", /Weather/);
      reject({ botId: a.id, target: "library", content: skillMd("没说明", "") }, "skill_description_missing", /description/);
      reject({ botId: a.id, target: "library", content: skillMd("a,b") }, "skill_name_invalid", /逗号/);
      reject({ botId: a.id, target: "library", content: "没有 frontmatter" }, "skill_name_invalid", /name/);
      reject({ botId: a.id, target: "elsewhere", content: skillMd("x") }, "skill_target_invalid", /library/);
      reject({ botId: a.id, target: "library", path: join(home, "nope") }, "skill_source_missing", /找不到/);

      await orch.team.flush();
      const log = gitLog(join(home, "team"));
      assert.ok(log.some((m) => m.includes("技能：装进共享库 写周报")));
      assert.ok(log.some((m) => m.includes("技能：给 小乙 装上 查天气")));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("03 技能面板列出库技能和私有技能，勾选写回 bot.skills，装技能后签名变", async () => {
  const home = tmp("ompbot-skill-panel-");
  try {
    await withOrch(home, async (orch) => {
      const bot = orch.addBot({ name: "小丙" });
      const native = orch.features.native;
      orch.installSkill({ botId: bot.id, target: "library", content: skillMd("写周报") });
      orch.installSkill({ botId: bot.id, target: "library", content: skillMd("画图") });
      put(join(home, "team", "skills", "缺说明", "SKILL.md"), "---\nname: 缺说明\n---\n");
      orch.installSkill({ botId: bot.id, target: "bot", content: skillMd("私房菜") });
      let st = await native.skillsStatus(bot.id);
      assert.deepEqual(st.library.map((s) => [s.name, s.selected, s.loadable]), [["画图", true, true], ["缺说明", true, false], ["写周报", true, true]].sort((x, y) => x[0].localeCompare(y[0])));
      assert.deepEqual(st.private.map((s) => s.name), ["私房菜"]);
      assert.deepEqual(st.effective, ["画图", "私房菜", "写周报"].sort((x, y) => x.localeCompare(y)), "没写 description 的库技能不算生效");

      native.putSkills(bot.id, { skills: ["写周报"] });
      assert.deepEqual(orch.getBot(bot.id).skills, ["写周报"]);
      st = await native.skillsStatus(bot.id);
      assert.deepEqual(st.library.filter((s) => s.selected).map((s) => s.name), ["写周报"]);
      assert.deepEqual(st.effective, ["私房菜", "写周报"].sort((x, y) => x.localeCompare(y)));

      // 从这个 bot 的面板装进共享库：它用白名单时新技能顺手加进去
      const out = native.installSkill(bot.id, { target: "library", content: skillMd("查天气") });
      assert.deepEqual(out.whitelist, ["写周报", "查天气"]);

      const rt = new BotRuntime({ bot: orch.getBot(bot.id), scope: "private", home, bin: "omp-fixture" });
      assert.ok(rt.matchesPolicy(orch.getBot(bot.id)));
      put(join(home, "team", "skills", "新来的", "SKILL.md"), skillMd("新来的"));
      assert.equal(rt.matchesPolicy(orch.getBot(bot.id)), false, "库里多了技能，下一轮重建进程");

      assert.ok(orch.features.routes.some((r) => r.method === "POST" && r.pattern.test("/api/bots/x/skills/install")));
      assert.equal(orch.features.allowsDevice("POST", "/api/bots/x/skills/install"), false, "手机等设备不能装技能");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------- 04 记忆 mnemopi ----------------
test("04 记忆库在 team/.memory，bank 是 bot-<id>，不进 git", () => {
  const p = teamPaths("/h", "bot_abc_1", "room:r9");
  assert.equal(p.memoryDbPath, join("/h", "team", ".memory", "mnemopi.db"));
  assert.equal(teamPaths("/h", "bot_abc_1").memoryDbPath, p.memoryDbPath, "私聊群聊一个库");
  assert.equal(p.agentDir, undefined);
  assert.equal(memoryBank("bot_abc_1"), "bot-bot_abc_1");
  assert.equal(memoryBank("we ird/id"), "bot-we-ird-id", "和 omp 的 bank 名清洗规则一致");
  assert.ok(TEAM_GITIGNORE.includes(".memory/"));
});

test("04 开记忆的 overlay：mnemopi、global、bank、team 里的库、autolearn 关、角色钉住", () => {
  const dir = tmp("ompbot-persona-");
  try {
    const bot = makeBot({ id: "bot_m", name: "M", model: "p/m", memoryEnabled: true });
    const dbPath = join(dir, "team", ".memory", "mnemopi.db");
    const { overlayPath } = writePersonaFiles(bot, dir, { memory: { dbPath, bank: memoryBank(bot.id) } });
    const y = readFileSync(overlayPath, "utf8");
    assert.match(y, /^memory:\n  backend: mnemopi\nmnemopi:\n  scoping: global\n  bank: "bot-bot_m"\n/m);
    assert.ok(y.includes(`  dbPath: ${JSON.stringify(dbPath)}\n`));
    assert.match(y, /^autolearn:\n  enabled: false$/m);
    assert.match(y, /^modelRoles:\n  default: p\/m\n  smol: p\/m\n  memory: p\/m$/m);
    assert.throws(() => writePersonaFiles(bot, dir, {}), /记忆库路径/, "缺库路径不写记忆段，免得落到用户自己的库");
    const off = readFileSync(writePersonaFiles({ ...bot, memoryEnabled: false }, dir, {}).overlayPath, "utf8");
    assert.match(off, /^memory:\n  backend: off$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("04 消息第一行标场景和发送者", () => {
  assert.equal(sceneTag({ sender: "张三" }), "[私聊，张三]");
  assert.equal(sceneTag({ room: "产品群" }), "[群聊，产品群]");
  assert.equal(sceneTag({ sender: "a]\n[b" }), "[私聊，a b]", "发送者里的换行和方括号不能伪造第二行标签");
  assert.equal(sceneTag({ sender: "" }), "[私聊，用户]");
  assert.equal(senderOf("user"), "用户");
  assert.equal(senderOf("device:d1"), "用户（手机）");
  assert.equal(senderOf("feishu:k"), "飞书");
  assert.equal(senderOf("routine"), "定时任务");
  const room = makeRoom({ id: "room_1", name: "产品群", members: ["bot_a"], adminId: "bot_a" });
  const prompt = roomPrompt({ room, members: [{ id: "bot_a", name: "A" }], self: { id: "bot_a", name: "A" }, turnNumber: 1 });
  assert.equal(prompt.split("\n")[0], "[群聊，产品群]");
  assert.ok(personaText().includes("[私聊，用户]"), "bot 知道标签的含义");
});

// ---------------- 11 吉祥物头像 ----------------
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
test("11 打包文件导出的取值和花名册校验用的一致", async () => {
  // 打包文件定义了自定义元素，在 node 里给它一个最小的浏览器外壳就能导入。
  const saved = { HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements };
  globalThis.HTMLElement ??= class {};
  globalThis.customElements ??= { get: () => undefined, define: () => {} };
  try {
    const m = await import("../web/vendor/mascot/omp-mascot.js");
    assert.deepEqual([...m.MASCOT_BODY_IDS], MASCOT_BODY_IDS);
    assert.equal(m.DEFAULT_MASCOT_BODY, DEFAULT_MASCOT_BODY);
    assert.deepEqual([...m.MASCOT_COLOR_IDS], MASCOT_COLOR_IDS);
    assert.deepEqual([...m.MASCOT_EXPRESSIONS], MASCOT_EXPRESSIONS);
    assert.ok(!Object.values(m.MASCOT_COLORS).map((c) => c.toLowerCase()).includes(MAIN_MASCOT_COLOR.toLowerCase()), "主助手颜色不在 10 色里");
    for (const s of ["idle", "thinking", "working", "alerting", "sad", "happy", ...MASCOT_EXPRESSIONS]) assert.ok(m.CURSOR_STATES.includes(s), s);
  } finally {
    if (saved.HTMLElement === undefined) delete globalThis.HTMLElement;
    if (saved.customElements === undefined) delete globalThis.customElements;
  }
  const notice = readFileSync(new URL("../web/vendor/mascot/NOTICE", import.meta.url), "utf8");
  const script = readFileSync(new URL("../scripts/build-mascot.mjs", import.meta.url), "utf8");
  const commit = script.match(/UPSTREAM_COMMIT = "([0-9a-f]{40})"/)[1];
  assert.ok(notice.includes(commit) && notice.includes("Apache") && notice.includes("Made with Blob Studio"));
  assert.ok(readFileSync(new URL("../web/vendor/mascot/omp-mascot.js", import.meta.url), "utf8").includes(commit));
  assert.ok(readFileSync(new URL("../web/vendor/mascot/LICENSE", import.meta.url), "utf8").includes("Apache License"));
});
test("11 老 bot 按 id 拿到固定颜色和 cursor 身体，Main Bot 固定 star 和专用蓝", () => {
  const old = normalizeBot({ id: "bot_old_1", name: "老甲" });
  assert.deepEqual(old.avatar, { body: "cursor", color: mascotColorFor("bot_old_1"), expression: null, crop: "mascot", url: null, zoom: 1, focusX: 0.5, focusY: 0.5 });
  assert.deepEqual(normalizeBot({ id: "bot_old_1", name: "老甲" }).avatar, old.avatar, "同一个 id 每次一样");
  const spread = new Set(Array.from({ length: 60 }, (_, i) => mascotColorFor(`bot_${i.toString(36)}_x`)));
  assert.ok(spread.size >= 8, `颜色要散开，实际 ${spread.size} 种`);
  const main = normalizeBot({ id: "bot_m", name: "主", isMain: true, avatar: { body: "blob", color: "red" } });
  assert.deepEqual([main.avatar.body, main.avatar.color, main.avatar.crop], ["star", MAIN_MASCOT_COLOR, "mascot"]);
  // 存坏的取值退回默认，不让整条记录消失
  const dirty = normalizeBot({ id: "bot_d", name: "脏", avatar: { body: "cube", color: MAIN_MASCOT_COLOR, crop: "circle", url: "https://x.test/a.png", zoom: 9 } });
  assert.deepEqual([dirty.avatar.body, dirty.avatar.color, dirty.avatar.crop, dirty.avatar.url, dirty.avatar.zoom], ["cursor", mascotColorFor("bot_d"), "mascot", null, 1]);
});
test("11 接口拒绝改 Main Bot 形象、拒绝用主助手颜色、拒绝非附件地址的图片", async () => {
  const home = tmp("ompbot-avatar-");
  try {
    await withOrch(home, async (orch) => {
      const main = orch.addBot({ name: "主", isMain: true });
      const bot = orch.addBot({ name: "甲" });
      const other = orch.addBot({ name: "乙" });
      const code = (fn) => { try { fn(); } catch (e) { return `${e.status} ${e.code}`; } return "ok"; };
      assert.equal(code(() => orch.updateBot(main.id, { avatar: { color: "red" } })), "400 avatar_main_fixed");
      assert.equal(code(() => orch.updateBot(main.id, { avatar: {} })), "400 avatar_main_fixed");
      assert.equal(code(() => orch.addBot({ name: "又一个主", isMain: true, avatar: { body: "blob" } })), "400 avatar_main_fixed");
      assert.equal(code(() => orch.updateBot(bot.id, { isMain: true, avatar: { body: "blob" } })), "400 avatar_main_fixed");
      assert.equal(orch.updateBot(main.id, { role: "主持" }).avatar.color, MAIN_MASCOT_COLOR, "改别的字段不受影响");
      for (const color of [MAIN_MASCOT_COLOR, MAIN_MASCOT_COLOR.toLowerCase()]) {
        assert.equal(code(() => orch.updateBot(bot.id, { avatar: { color } })), "400 avatar_color_reserved");
      }
      assert.equal(code(() => orch.addBot({ name: "丙", avatar: { color: MAIN_MASCOT_COLOR } })), "400 avatar_color_reserved");
      assert.equal(code(() => orch.updateBot(bot.id, { avatar: { color: "#123456" } })), "400 avatar_invalid");
      assert.equal(code(() => orch.updateBot(bot.id, { avatar: { body: "cube" } })), "400 avatar_invalid");
      assert.equal(code(() => orch.updateBot(bot.id, { avatar: { expression: "angry" } })), "400 avatar_invalid");
      assert.equal(code(() => orch.updateBot(bot.id, { avatar: { zoom: 3.5 } })), "400 avatar_invalid");
      assert.equal(code(() => orch.updateBot(bot.id, { avatar: { owner: "x" } })), "400 avatar_invalid");
      assert.equal(code(() => orch.updateBot(bot.id, { avatar: { crop: "circle" } })), "400 avatar_invalid", "没图片不能选图片裁切");
      const att = (owner, filename, mime, data) => orch.features.attachments.create({ botId: owner, filename, mime, dataBase64: data });
      const mine = att(bot.id, "me.png", "image/png", PNG_1PX);
      const theirs = att(other.id, "them.png", "image/png", PNG_1PX);
      const doc = att(bot.id, "notes.txt", "text/plain", Buffer.from("hello").toString("base64"));
      const preview = (rec) => `/api/attachments/${rec.id}/preview`;
      for (const url of [
        "https://example.com/a.png", "data:image/png;base64,AAAA", "/api/attachments/att_nope_1/preview",
        `/api/attachments/${mine.id}/download`, `/api/attachments/${mine.id}/preview?x=1`, preview(theirs), preview(doc),
      ]) {
        assert.equal(code(() => orch.updateBot(bot.id, { avatar: { url, crop: "circle" } })), "400 avatar_url_invalid", url);
      }
      const set = orch.updateBot(bot.id, { avatar: { url: preview(mine), crop: "rounded", zoom: 2, focusX: 0.25, focusY: 0.75 } });
      assert.deepEqual([set.avatar.crop, set.avatar.url, set.avatar.zoom, set.avatar.focusX], ["rounded", preview(mine), 2, 0.25]);
      const look = orch.updateBot(bot.id, { avatar: { body: "drop", color: "teal", expression: "proud" } });
      assert.deepEqual([look.avatar.body, look.avatar.color, look.avatar.expression, look.avatar.url], ["drop", "teal", "proud", preview(mine)], "部分改动合并进现有头像");
      assert.equal(orch.getBot(bot.id).avatar.body, "drop", "存进花名册");
      assert.equal(orch.updateBot(bot.id, { avatar: { expression: null, crop: "mascot", url: null } }).avatar.expression, null);
      assert.equal(code(() => orch.addBot({ name: "丁", avatar: { url: preview(mine), crop: "circle" } })), "400 avatar_url_invalid", "新 bot 还没有自己的附件");
      assert.equal(orch.addBot({ name: "戊", avatar: { body: "hexagon", color: "pink" } }).avatar.body, "hexagon");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const run of pending) await run();
console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

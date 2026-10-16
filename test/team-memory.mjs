// test/team-memory.mjs — 团队事实提议：bot 提议带来源，用户或主助手接受才写进 team/AGENTS.md；
// 替换旧事实时旧事实已变就拒绝，纠正过的旧说法不会被写回。
//
// 真实编排器、台账和 team 目录（临时 home，有 git 就真提交），只注入 runtime 夹具。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newTeam } from "./_harness.mjs";

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e?.stack ?? e}`);
  }
}

const agentsOf = (t) => readFileSync(join(t.home, "team", "AGENTS.md"), "utf8");
const factsOf = (t) => t.orch.listTeamFacts().map((f) => f.text);
const gitLog = (t) => {
  try {
    return execFileSync("git", ["log", "--format=%s"], { cwd: join(t.home, "team"), encoding: "utf8" });
  } catch {
    return null;
  }
};
const USER = { kind: "user" };

/** 一个主助手、两个普通 bot，fake runtime 先建好（工具在建 runtime 时注入）。 */
async function trio(t) {
  const main = t.orch.addBot({ name: "小总", isMain: true });
  const a = t.orch.addBot({ name: "Alpha" });
  const b = t.orch.addBot({ name: "Beta" });
  const fm = await t.orch.runtimeFor(main.id, "private");
  const fa = await t.orch.runtimeFor(a.id, "private");
  const fb = await t.orch.runtimeFor(b.id, "private");
  return { main, a, b, fm, fa, fb };
}
const call = (fake, tool, args) => fake._callTool(tool, args);

await test("普通 bot 提议只进待确认，用户接受后才写进团队共识并自动提交", async () => {
  const t = newTeam();
  try {
    const { a, fa } = await trio(t);
    const before = agentsOf(t);
    const out = await call(fa, "propose_team_fact", { fact: "周报每周五下午五点前交", source: "私聊里用户说的" });
    assert.ok(!out.isError, out.text);
    assert.match(out.text, /等用户或主助手确认/);
    const [p] = t.orch.listTeamProposals({ state: "pending" });
    assert.equal(p.botId, a.id);
    assert.equal(p.source, "私聊里用户说的");
    assert.equal(agentsOf(t), before, "没接受之前不动 AGENTS.md");

    const done = t.orch.decideTeamProposal(p.id, { decision: "accept", by: USER });
    assert.equal(done.state, "accepted");
    assert.deepEqual(factsOf(t), ["周报每周五下午五点前交"]);
    assert.match(agentsOf(t), /周报每周五下午五点前交（来源：私聊里用户说的）/);
    assert.ok(agentsOf(t).startsWith(before.trimEnd()), "模板原文保留");
    await t.orch.team.flush();
    const log = gitLog(t);
    if (log !== null && t.orch.team.git) assert.match(log, /团队事实：用户接受了 Alpha 的提议/);
  } finally {
    await t.cleanup();
  }
});

await test("拒绝的提议不写文件，已处理的不能再处理", async () => {
  const t = newTeam();
  try {
    const { fa } = await trio(t);
    const before = agentsOf(t);
    await call(fa, "propose_team_fact", { fact: "测试服务器密码是 123", source: "群里看到的" });
    const [p] = t.orch.listTeamProposals({ state: "pending" });
    const out = t.orch.decideTeamProposal(p.id, { decision: "reject", by: USER, reason: "密码不写进共识" });
    assert.equal(out.state, "rejected");
    assert.equal(out.reason, "密码不写进共识");
    assert.equal(agentsOf(t), before);
    assert.throws(() => t.orch.decideTeamProposal(p.id, { decision: "accept", by: USER }), (e) => e.status === 409);
  } finally {
    await t.cleanup();
  }
});

await test("两个 bot 同时提议替换同一条，后接受的那条被拒并提示按最新内容重提", async () => {
  const t = newTeam();
  try {
    const { fa, fb } = await trio(t);
    t.orch.addTeamFact({ fact: "发版在周三", source: "用户定的", by: USER });
    await call(fa, "propose_team_fact", { fact: "发版改到周四", source: "产品群通知", replaces: "发版在周三" });
    await call(fb, "propose_team_fact", { fact: "发版改到周五", source: "用户私聊", replaces: "发版在周三" });
    const pending = t.orch.listTeamProposals({ state: "pending" });
    const first = pending.find((p) => p.fact === "发版改到周四");
    const second = pending.find((p) => p.fact === "发版改到周五");
    assert.equal(t.orch.decideTeamProposal(first.id, { decision: "accept", by: USER }).state, "accepted");
    assert.throws(
      () => t.orch.decideTeamProposal(second.id, { decision: "accept", by: USER }),
      (e) => e.status === 409 && e.code === "fact_changed" && /重提/.test(e.message),
    );
    assert.equal(t.orch.getTeamProposal(second.id).state, "conflict");
    assert.deepEqual(factsOf(t), ["发版改到周四"]);
  } finally {
    await t.cleanup();
  }
});

await test("用户纠正一条事实后，bot 再提旧说法被拒；纠正前就在等的旧说法接受时也被拒", async () => {
  const t = newTeam();
  try {
    const { fa, fb } = await trio(t);
    t.orch.addTeamFact({ fact: "客户 A 的对接人是王经理", source: "邮件", by: USER });
    // 纠正前 B 先提了一条和旧说法一样的（比如别的地方又看到一次），还没处理。
    await call(fb, "propose_team_fact", { fact: "客户 A 的接口人是王经理", source: "旧邮件" });
    t.orch.addTeamFact({ fact: "客户 A 的对接人是李经理", replaces: "客户 A 的对接人是王经理", source: "用户纠正", by: USER });
    assert.deepEqual(factsOf(t), ["客户 A 的对接人是李经理"]);

    const again = await call(fa, "propose_team_fact", { fact: "客户 A 的对接人是王经理", source: "旧聊天记录" });
    assert.ok(again.isError, "旧说法不能再提");
    assert.match(again.text, /已经被纠正为「客户 A 的对接人是李经理」/);
    assert.equal(t.orch.listTeamProposals({ state: "pending" }).filter((p) => p.fact === "客户 A 的对接人是王经理").length, 0);

    // 换个写法的不算同一条，照常排队；完全一样的旧说法在接受时也拦住。
    const stale = t.orch.listTeamProposals({ state: "pending" })[0];
    t.orch._putTeamProposal({ ...stale, fact: "客户 A 的对接人是王经理" });
    assert.throws(() => t.orch.decideTeamProposal(stale.id, { decision: "accept", by: USER }), (e) => e.code === "fact_corrected");
    assert.deepEqual(factsOf(t), ["客户 A 的对接人是李经理"]);
  } finally {
    await t.cleanup();
  }
});

await test("提议替换一条不存在的事实、没写来源、和已有事实重复，都当场报错且不留记录", async () => {
  const t = newTeam();
  try {
    const { fa } = await trio(t);
    t.orch.addTeamFact({ fact: "代码仓库在 GitHub", source: "用户", by: USER });
    const missing = await call(fa, "propose_team_fact", { fact: "代码仓库在 GitLab", source: "猜的", replaces: "代码仓库在 Gitee" });
    assert.ok(missing.isError);
    assert.match(missing.text, /没找到要替换的事实/);
    const noSource = await call(fa, "propose_team_fact", { fact: "午饭十二点", source: "  " });
    assert.ok(noSource.isError);
    assert.match(noSource.text, /来源/);
    const dup = await call(fa, "propose_team_fact", { fact: "代码仓库在 GitHub", source: "又看到一次" });
    assert.ok(dup.isError);
    assert.match(dup.text, /已经有这条/);
    const multi = await call(fa, "propose_team_fact", { fact: "第一行\n第二行", source: "x" });
    assert.ok(multi.isError);
    assert.equal(t.orch.listTeamProposals({}).filter((p) => !p.direct).length, 0, "报错的提议不留记录");
  } finally {
    await t.cleanup();
  }
});

await test("主助手能列出并接受提议，普通 bot 没有审核工具", async () => {
  const t = newTeam();
  try {
    const { main, fm, fa } = await trio(t);
    assert.ok(fm.tools.some((x) => x.name === "review_team_proposals"));
    assert.ok(!fa.tools.some((x) => x.name === "review_team_proposals"));
    await call(fa, "propose_team_fact", { fact: "设计稿放在 workspace/design", source: "用户在群里说的" });
    const listed = await call(fm, "review_team_proposals", { action: "list" });
    const [p] = t.orch.listTeamProposals({ state: "pending" });
    assert.match(listed.text, new RegExp(p.id));
    assert.match(listed.text, /设计稿放在 workspace\/design/);
    assert.match(listed.text, /来源：用户在群里说的/);
    const ok = await call(fm, "review_team_proposals", { action: "accept", id: p.id });
    assert.ok(!ok.isError, ok.text);
    const rec = t.orch.getTeamProposal(p.id);
    assert.equal(rec.state, "accepted");
    assert.deepEqual(rec.decidedBy, { kind: "bot", botId: main.id });
    assert.deepEqual(factsOf(t), ["设计稿放在 workspace/design"]);

    // 主助手身份被撤掉后，手里的旧工具也不能再接受。
    await call(fa, "propose_team_fact", { fact: "例会改到周二", source: "日历" });
    t.orch.updateBot(main.id, { isMain: false });
    const [q] = t.orch.listTeamProposals({ state: "pending" });
    const denied = await call(fm, "review_team_proposals", { action: "accept", id: q.id });
    assert.ok(denied.isError);
    assert.equal(t.orch.getTeamProposal(q.id).state, "pending");
  } finally {
    await t.cleanup();
  }
});

await test("用户直接改了团队事实块后，按文件里的现状判断冲突", async () => {
  const t = newTeam();
  try {
    const { fa } = await trio(t);
    t.orch.addTeamFact({ fact: "备份放 NAS", source: "用户", by: USER });
    await call(fa, "propose_team_fact", { fact: "备份放网盘", source: "Alpha 看到的", replaces: "备份放 NAS" });
    const file = join(t.home, "team", "AGENTS.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, agentsOf(t).replace("备份放 NAS", "备份放移动硬盘"));
    const [p] = t.orch.listTeamProposals({ state: "pending" });
    assert.throws(() => t.orch.decideTeamProposal(p.id, { decision: "accept", by: USER }), (e) => e.code === "fact_changed");
    assert.match(agentsOf(t), /备份放移动硬盘/);
    assert.doesNotMatch(agentsOf(t), /备份放网盘/);
  } finally {
    await t.cleanup();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

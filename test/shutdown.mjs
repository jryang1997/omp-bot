// test/shutdown.mjs — 退出与跨进程控制的回归：关窗不等于退出，退出必须真的停下工作并放开数据锁；
// 数据目录被另一个进程持有时，CLI 必须如实报告，并能把控制命令发给持有者而不是假装成功。
//
// 覆盖：
//  1) 退出时进行中的 Run 不会留下 running/cancelling：真起一个 Run（bin 故意不可运行，
//     所以不会调用模型），立刻取消，然后断言它落进终态；接受了取消就不许只停在 cancelling。
//  2) 关闭后旧方法（runtimeFor/chatWithBot）与新的 startRun 都拒绝起新工作。
//  3) 退出后 state.lock 释放，另一个 Orchestrator（CLI/GUI）能在同一 home 重新拿到写锁并看到数据。
//  4) 别的进程持锁、但没有可发现的服务：CLI 子进程必须如实拒绝（非零退出、绝不打印「已停止」），
//     并且不动持有者的运行状态。
//  5) 真实 server 持有 home：CLI 子进程能（自动发现 runtime.json 或显式 --url/--token）把
//     列表、设置、审批命令发给持有者，由持有者用自己的规则裁决；错凭证被拒。
//
// 未覆盖（需要真实 OMP 与模型，由集成 owner 的真实 smoke 覆盖）：活着的 OMP 子进程被回收、
// 忙 runtime 的原生 abort 真正停下工具、原生审批被真实回答后运行继续。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../src/orchestrator.mjs";
import { serverDescriptorPath, startServer } from "../src/server.mjs";
import { TERMINAL_RUN_STATES } from "../src/constants.mjs";

const CLI = fileURLToPath(new URL("../ompbot.mjs", import.meta.url));
// 故意不可运行：这些测试不该启动任何 OMP。
const BIN = "must-not-start-in-shutdown-test";

/** 跑真正的 CLI 子进程；url/token 只从显式参数或环境进来（和用户用法一致）。 */
function runCli(args, { home, url, token } = {}) {
  return new Promise((resolveRun) => {
    const env = { ...process.env, OMPBOT_HOME: home, OMPBOT_URL: url ?? "", OMPBOT_TOKEN: token ?? "" };
    const child = spawn(process.execPath, [CLI, ...args], { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.setEncoding("utf8").on("data", (data) => (stdout += data));
    child.stderr.setEncoding("utf8").on("data", (data) => (stderr += data));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

const home = mkdtempSync(join(tmpdir(), "ompbot-shutdown-"));
const lockPath = join(home, "state.lock");

const team = new Orchestrator({ home, bin: BIN });
try {
  const bot = team.addBot({ name: "ShutdownProbe" });
  const room = team.createRoom({ name: "ClosingGroup", members: [bot.id] });
  assert.equal(existsSync(lockPath), true, "打开期间必须持有写锁");

  // 1) 退出路径上的进行中工作。
  const run = team.startRun({ botId: bot.id, text: "长回合（不会真的启动模型）", source: "test" });
  assert.ok(team.getRun(run.id), "startRun 必须立即返回已落库的 Run");
  const result = await team.cancelRun(run.id, "test-quit");
  const after = team.getRun(run.id);
  assert.ok(TERMINAL_RUN_STATES.has(after.state), `取消后必须进入终态，实际 ${after.state}`);
  if (result.accepted) {
    assert.equal(after.state, "cancelled", "接受了取消就不能只停在 cancelling");
  }

  // 2) 关闭后不能再借 runtime 或旧入口起新回合，新入口同样拒绝。
  await team.shutdown();
  await assert.rejects(team.runtimeFor(bot.id, `room:${room.id}`), /团队正在关闭/);
  await assert.rejects(team.chatWithBot(bot.id, "不能在关闭后启动新会话"), /团队正在关闭/);
  // startRun 是同步 API（立即返回 Run 或同步抛出），所以用 assert.throws，不能交给 assert.rejects。
  assert.throws(() => team.startRun({ botId: bot.id, text: "关闭后不得起跑" }), /团队正在关闭/);
  console.log(`PASS: 关闭后拒绝 runtimeFor/chatWithBot/startRun（取消被接受=${result.accepted}）`);

  // 3) 数据锁已释放，且没有留下非终态运行。
  assert.equal(existsSync(lockPath), false, "退出后必须释放 state.lock");
  const reopened = new Orchestrator({ home, bin: BIN });
  try {
    assert.equal(reopened.store.readonly, false, "锁释放后新进程必须能拿到写权限");
    assert.equal(reopened.getBot(bot.id)?.name, "ShutdownProbe");
    assert.equal(reopened.getRoom(room.id)?.name, "ClosingGroup");
    const stale = reopened.listRuns({}).filter((r) => !TERMINAL_RUN_STATES.has(r.state));
    assert.deepEqual(stale.map((r) => `${r.id}:${r.state}`), [], "退出后不能留下非终态运行");
    assert.equal(existsSync(lockPath), true, "重新打开期间必须持有锁");
  } finally {
    await reopened.shutdown();
    assert.equal(existsSync(lockPath), false, "第二次退出也必须释放锁");
  }
  console.log("PASS: 进行中的 Run 进入终态，锁释放并可在同一 home 重新取得写权限");

  // 4) 别的进程持锁但没有可发现的服务：CLI 子进程只能如实拒绝。
  const lockedHome = mkdtempSync(join(tmpdir(), "ompbot-locked-"));
  const holder = new Orchestrator({ home: lockedHome, bin: BIN });
  try {
    const heldBot = holder.addBot({ name: "HeldBot" });
    const held = holder.ledger.createRun({
      kind: "chat",
      botId: heldBot.id,
      scope: "private",
      text: "属于持锁进程但没有可发现服务的运行",
      source: "test",
    });
    holder.ledger.updateRun(held.id, { state: "running" });
    assert.equal(existsSync(serverDescriptorPath(lockedHome)), false, "这个 home 没有 runtime.json");

    const alone = await runCli(["runs", "stop", held.id, "--json"], { home: lockedHome });
    assert.notEqual(alone.code, 0, `没有可控制的持有者时必须非零退出：${alone.stdout}${alone.stderr}`);
    assert.ok(!/已停止/.test(alone.stdout + alone.stderr), `不得假装停止：${alone.stdout}${alone.stderr}`);
    assert.equal(JSON.parse(alone.stdout).accepted, false, "取消必须如实报告 accepted=false");
    assert.equal(holder.getRun(held.id).state, "running", "拒绝时不得改动持有者的运行");
    console.log("PASS: 只有锁没有服务时，停止命令如实拒绝且不动持有者的状态");
  } finally {
    await holder.shutdown();
    rmSync(lockedHome, { recursive: true, force: true });
  }

  // 5) 真实 server 持有 home：CLI 子进程把命令发给它。
  const ownerHome = mkdtempSync(join(tmpdir(), "ompbot-owner-"));
  const backend = await startServer({ port: 0, home: ownerHome, bin: BIN });
  try {
    const ownerBot = backend.orch.addBot({ name: "OwnerBot" });
    // 台账里放一个属于该进程的「运行中」Run：它的运行时控制块只存在于持有者进程里，
    // 别的进程直接取消只能拿到 accepted:false（这正是本轮要修的跨进程行为）。
    const fixture = backend.orch.ledger.createRun({
      kind: "chat",
      botId: ownerBot.id,
      scope: "private",
      text: "由持有者拥有的运行",
      source: "test",
    });
    backend.orch.ledger.updateRun(fixture.id, { state: "running" });

    // 5a) 自动发现：服务写了 runtime.json，子进程不带 --url 也能控制。
    const discovered = await runCli(["runs", "list", "--json"], { home: ownerHome });
    assert.equal(discovered.code, 0, discovered.stderr);
    assert.ok(JSON.parse(discovered.stdout).some((r) => r.id === fixture.id), "自动发现要读到持有者的运行");

    // 5b) 显式 --url/--token：写操作真的落在持有者进程。
    const set = await runCli(["settings", "set", "OwnerBot", "--budget", "7", "--json"], {
      home: ownerHome,
      url: backend.url,
      token: backend.token,
    });
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(
      backend.orch.getBot(ownerBot.id).budget,
      { maxTokens: 7 },
      "CLI 的 --budget 数字必须按契约写成 {maxTokens} 对象并落到持有者进程",
    );

    // 5c) 审批命令也到达持有者：持有者按自己的规则裁决（这里没有活跃 runtime → 它拒绝送达），
    //     CLI 不得代答、也不得把审批标成已回复。
    const approvalId = `ui_test_${Date.now()}`;
    backend.orch.ledger.put("approvals", {
      id: approvalId,
      runId: fixture.id,
      botId: ownerBot.id,
      scope: "private",
      nativeId: "native-fixture",
      method: "select",
      title: "fixture 审批",
      message: "fixture",
      options: ["Approve", "Deny"],
      optionDetails: null,
      questions: null,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const approve = await runCli(["approvals", "respond", approvalId, "--value", "Deny"], {
      home: ownerHome,
      url: backend.url,
      token: backend.token,
    });
    assert.notEqual(approve.code, 0, `持有者拒绝时必须非零退出：${approve.stdout}${approve.stderr}`);
    assert.ok(!/401/.test(approve.stdout + approve.stderr), `不该是鉴权失败，说明请求确实到了持有者：${approve.stderr}`);
    assert.equal(backend.orch.ledger.get("approvals", approvalId).status, "pending", "被拒的审批不得被标成已回复");

    // 5d) 错 token 必须被拒：本机不是免鉴权通行证。
    const wrong = await runCli(["runs", "list", "--json"], { home: ownerHome, url: backend.url, token: "wrong-token" });
    assert.notEqual(wrong.code, 0, "错 token 必须失败");
    assert.ok(/401|凭证|未授权/.test(wrong.stdout + wrong.stderr), `错 token 要说清是鉴权问题：${wrong.stdout}${wrong.stderr}`);

    // 5e) 终态运行不谎报：明确说已结束，不打印「已停止」。
    backend.orch.ledger.updateRun(fixture.id, { state: "failed", error: "fixture" });
    const terminal = await runCli(["runs", "stop", fixture.id], { home: ownerHome });
    assert.equal(terminal.code, 0, terminal.stderr);
    assert.ok(/已结束/.test(terminal.stdout), `终态要如实说明：${terminal.stdout}${terminal.stderr}`);
    assert.ok(!/已停止/.test(terminal.stdout), "终态不得打印「已停止」");
    console.log("PASS: 自动发现与 --url 都走持有者的本机 API；审批与终态都如实报告");
  } finally {
    await backend.close();
    rmSync(ownerHome, { recursive: true, force: true });
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

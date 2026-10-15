import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./src/server.mjs";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const suppliedHome = option("--home");
const home = suppliedHome ? resolve(suppliedHome) : mkdtempSync(join(tmpdir(), "ompbot-computer-smoke-"));
const keep = args.includes("--keep") || !!suppliedHome;
const model = option("--model") ?? process.env.OMPBOT_MODEL ?? "";
const suffix = randomBytes(3).toString("hex");
const proofDir = resolve(".scratch/bot-computers");
const proofPath = join(proofDir, "smoke-proof.json");
mkdirSync(proofDir, { recursive: true });
const proof = { startedAt: new Date().toISOString(), home, model: model || "native default", checks: [], bots: [] };
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "reconciliation_required"]);
let server;
let backend;

const quote = (text) => "'" + String(text).replaceAll("'", "'\"'\"'") + "'";
function save() {
  writeFileSync(proofPath, JSON.stringify(proof, null, 2));
}
function pass(name, evidence = {}) {
  proof.checks.push({ name, ...evidence });
  save();
  console.log(`PASS ${name}`);
}
async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(server.url + path, {
    method,
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function post(path, body = {}) {
  return api(path, { method: "POST", body });
}
async function okPost(path, body = {}) {
  const result = await post(path, body);
  assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status} ${result.data.error ?? ""}`);
  return result.data;
}
async function waitFor(fn, deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Smoke condition did not settle within ${deadlineMs}ms`);
}
async function command(id, text, tag, timeoutMs = 30_000) {
  const output = await backend.run(id, { command: text, cwd: "/work", timeoutMs, tag: `smoke-${suffix}-${tag}` });
  assert.equal(output.exitCode, 0, `${tag}: ${output.stderr}`);
  return output.stdout;
}
async function finished(runId) {
  return waitFor(async () => {
    const result = await api(`/api/runs/${runId}`);
    assert.equal(result.status, 200);
    return terminal.has(result.data.run.state) ? result.data.run : null;
  }, 240_000);
}
async function startRun(botId, text, extra = {}) {
  const response = await okPost("/api/runs", { botId, text, timeoutMs: 240_000, ...extra });
  return response.run;
}
async function screenshot(botId, name) {
  const response = await fetch(`${server.url}/api/bots/${botId}/computer/screen`, { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/png/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.readUInt32BE(0), 0x89504e47);
  assert.equal(bytes.readUInt32BE(4), 0x0d0a1a0a);
  const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.ok(size.width >= 640 && size.height >= 480);
  writeFileSync(join(proofDir, `${name}.png`), bytes);
  return size;
}
async function browserProof(id, browser, profile, html, tag) {
  await command(id, `mkdir -p /work/browser-proof; printf '%s' ${quote(Buffer.from(html).toString("base64"))} | base64 -d > /work/browser-proof/index.html`, `${tag}-page`);
  const controller = new AbortController();
  const serving = backend.run(id, {
    command: "python3 -m http.server 8767 --bind 127.0.0.1 --directory /work/browser-proof",
    cwd: "/work", timeoutMs: 90_000, tag: `smoke-${suffix}-${tag}-http`,
  }, { signal: controller.signal }).catch((error) => ({ stopped: error.code ?? error.name }));
  try {
    await waitFor(async () => {
      const result = await backend.run(id, { command: "curl -fsS http://127.0.0.1:8767/ >/dev/null", cwd: "/work", timeoutMs: 3000, tag: `smoke-${suffix}-${tag}-ready` });
      return result.exitCode === 0;
    });
    return await command(id, `${quote(browser)} --headless --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir=${quote(profile)} --virtual-time-budget=1500 --dump-dom http://127.0.0.1:8767/`, `${tag}-browser`, 45_000);
  } finally {
    controller.abort();
    await serving;
  }
}

try {
  server = await startServer({ home, port: 0, host: "127.0.0.1" });
  const a = (await okPost("/api/bots", { name: `Computer A ${suffix}`, model, thinking: "low", permission: "full", confirmPermission: true })).bot;
  const b = (await okPost("/api/bots", { name: `Computer B ${suffix}`, model, thinking: "low", permission: "full", confirmPermission: true })).bot;
  proof.bots = [{ id: a.id, name: a.name }, { id: b.id, name: b.name }];
  const pathA = `/api/bots/${a.id}/computer`;
  const pathB = `/api/bots/${b.id}/computer`;
  const pcA = (await okPost(`${pathA}/bind`)).computer;
  const pcB = (await okPost(`${pathB}/bind`)).computer;
  await waitFor(async () => (await api(pathA)).data.computer.state === "running", 240_000);
  await waitFor(async () => (await api(pathB)).data.computer.state === "running", 240_000);
  assert.notEqual(pcA.id, pcB.id);
  backend = await server.orch.features.computers.ensureBackend();
  const dimensionsA = await screenshot(a.id, "smoke-desktop-a");
  const dimensionsB = await screenshot(b.id, "smoke-desktop-b");
  pass("两 Bot 的真实 Linux 电脑与同源桌面截图", { computerA: pcA.id, computerB: pcB.id, dimensionsA, dimensionsB });
  const managementListeners = await command(pcA.id, "python3 -c 'import socket; opened=[];\nfor p in range(5900,6000):\n s=socket.socket(); s.settimeout(0.15);\n try:\n  s.connect((\"10.0.2.2\",p)); banner=s.recv(12);\n  if banner.startswith(b\"RFB \"): opened.append(p)\n except OSError: pass\n finally: s.close()\nprint(opened)'", "no-vnc-listeners");
  assert.equal(managementListeners.trim(), "[]");
  pass("客机不能连接任何未认证 VNC 管理端口");

  const markerA = `VIZ_A_${randomBytes(3).toString("hex")}.txt`;
  const markerB = `VIZ_B_${randomBytes(3).toString("hex")}.txt`;
  await command(pcA.id, `mkdir -p /home/cua/Desktop; printf A > ${quote(`/home/cua/Desktop/${markerA}`)}`, "visual-a");
  await command(pcB.id, `mkdir -p /home/cua/Desktop; printf B > ${quote(`/home/cua/Desktop/${markerB}`)}`, "visual-b");
  await sleep(1200);
  const attachmentText = `A-COMPUTER-ISOLATION-${suffix}\n`;
  const attachment = (await okPost("/api/attachments", { botId: a.id, filename: "source.txt", mime: "text/plain", dataBase64: Buffer.from(attachmentText).toString("base64") })).attachment;
  const runA = await startRun(a.id, "先且只能用 computer_screenshot 读取桌面新增的 VIZ_ 开头文件名，逐字答出完整文件名。随后用 computer_shell 读取本次附件，把附件正文原样复制到 /work/output-a.txt，并用 computer_publish_file 发布该文件。不要使用本机工具。", { attachmentIds: [attachment.id] });
  const doneA = await finished(runA.id);
  assert.equal(doneA.state, "completed", JSON.stringify(doneA.error));
  assert.ok(doneA.reply?.includes(markerA), `模型未读取截图中的随机文件名: ${doneA.reply}`);
  const artifacts = (await api(`/api/artifacts?botId=${encodeURIComponent(a.id)}&runId=${encodeURIComponent(runA.id)}`)).data.artifacts;
  const resultFile = artifacts.find((item) => item.name === "output-a.txt");
  assert.ok(resultFile, "客机成果未登记进入现有成果库");
  const downloaded = await fetch(`${server.url}/api/artifacts/${resultFile.id}/download`, { headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), attachmentText);
  pass("真实 OMP 消费随机桌面图像，附件到客机再生成可下载成果", { runId: runA.id, visualMarker: markerA, artifactId: resultFile.id });

  const stateA = await server.orch.getNativeState(a.id);
  assert.equal(stateA.toolSurface.restricted, true);
  assert.equal(stateA.toolSurface.nativeVerification, "verified");
  const names = stateA.toolSurface.reported;
  assert.ok(Array.isArray(names));
  for (const name of ["computer_screenshot", "computer_input", "computer_shell", "computer_files", "computer_upload_attachment", "computer_publish_file"]) assert.ok(names.includes(name), `实际工具清单缺少 ${name}`);
  for (const name of ["bash", "read", "eval", "browser", "web_search"]) assert.ok(!names.includes(name), `实际工具清单仍有宿主工具 ${name}`);
  pass("真实 dumpTools 核对所属电脑工具，宿主工具未进入模型", { tools: names });

  const runB = await startRun(b.id, "先用 computer_screenshot 读取桌面新增的 VIZ_ 文件完整名称，文件名必须仅从截图识别。随后只用自己的 computer_shell 检查 /work/output-a.txt 不存在，存在就报告失败。最终回复严格两行：第一行是从截图识别的完整文件名；第二行是 ISOLATED_B。禁止使用其他 Bot 的电脑或本机工具。");
  const doneB = await finished(runB.id);
  assert.equal(doneB.state, "completed", JSON.stringify(doneB.error));
  assert.ok(doneB.reply?.includes(markerB), `第二台电脑的最终回复未包含截图文件名: ${doneB.reply}`);
  assert.ok(doneB.reply?.includes("ISOLATED_B"));
  assert.equal(await command(pcB.id, "test ! -e /work/output-a.txt && printf ISOLATED_B", "isolation-b"), "ISOLATED_B");
  const foreign = await startRun(b.id, "读取附件", { attachmentIds: [attachment.id] });
  const foreignDone = await finished(foreign.id);
  assert.equal(foreignDone.state, "failed");
  pass("第二台电脑与文件隔离，跨 Bot 附件被拒绝", { runId: runB.id, visualMarker: markerB, rejectedRunId: foreign.id });

  const humanB = (await okPost(`${pathB}/takeover`)).computer;
  await okPost(`${pathB}/input`, { generation: humanB.generation, action: "key", key: "ctrl+alt+t" });
  await waitFor(async () => (JSON.parse(await (await backend.guest(pcB.id)).callJson('WindowsService/ListWindows', '{}')).windows ?? []).some(window => window.focused && /terminal/i.test(window.app?.appId ?? window.app?.name ?? '')));
  await okPost(`${pathB}/input`, { generation: humanB.generation, action: "type", text: "printf B-DESKTOP-INPUT > /work/human-b.txt" });
  await okPost(`${pathB}/input`, { generation: humanB.generation, action: "key", key: "Enter" });
  await waitFor(async () => (await command(pcB.id, "cat /work/human-b.txt 2>/dev/null || true", "human-b-proof")) === "B-DESKTOP-INPUT");
  await okPost(`${pathB}/input`, { generation: humanB.generation, action: "click", x: 50, y: 12, button: "left" });
  await screenshot(b.id, "smoke-human-b");
  await okPost(`${pathB}/release`, { generation: humanB.generation });
  pass("第二台电脑的真实桌面按键、文本输入与点击");

  const human = (await okPost(`${pathA}/takeover`)).computer;
  assert.equal(human.holder, "human");
  assert.equal((await post("/api/runs", { botId: a.id, text: "人工接管期间不能运行" })).status, 409);
  await okPost(`${pathA}/input`, { generation: human.generation, action: "key", key: "ctrl+alt+t" });
  await waitFor(async () => (JSON.parse(await (await backend.guest(pcA.id)).callJson('WindowsService/ListWindows', '{}')).windows ?? []).some(window => window.focused && /terminal/i.test(window.app?.appId ?? window.app?.name ?? '')));
  const humanText = "电脑接管输入验证";
  await okPost(`${pathA}/input`, { generation: human.generation, action: "type", text: `printf '%s' '${humanText}' > /work/human-input.txt` });
  await okPost(`${pathA}/input`, { generation: human.generation, action: "key", key: "Enter" });
  await waitFor(async () => (await command(pcA.id, "cat /work/human-input.txt 2>/dev/null || true", "human-proof")) === humanText);
  await screenshot(a.id, "smoke-human-input");
  await okPost(`${pathA}/input`, { generation: human.generation, action: "click", x: 50, y: 12, button: "left" });
  await screenshot(a.id, "smoke-human-click");
  await okPost(`${pathA}/release`, { generation: human.generation });
  assert.equal((await post(`${pathA}/input`, { generation: human.generation, action: "type", text: "obsolete input" })).status, 409);
  pass("人工接管的真实快捷键、中文输入和点击，归还拒绝旧代输入", { generation: human.generation });

  const controller = new AbortController();
  const sleeping = backend.run(pcA.id, {
    command: "echo $$ > /work/cancel-parent.pid; sleep 300 & echo $! > /work/cancel-child.pid; wait",
    cwd: "/work", timeoutMs: 310_000, tag: `smoke-${suffix}-cancel-tree`,
  }, { signal: controller.signal }).then((value) => ({ value }), (error) => ({ error: { code: error.code, name: error.name, message: error.message } }));
  await waitFor(async () => (await command(pcA.id, "test -s /work/cancel-child.pid && printf READY || true", "cancel-ready")) === "READY");
  controller.abort();
  const cancelled = await Promise.race([sleeping, sleep(20_000).then(() => { throw new Error("客机取消未在期限内返回"); })]);
  assert.notEqual(cancelled.error?.code, "computer_effect_unknown", JSON.stringify(cancelled));
  await waitFor(async () => {
    const stat = await command(pcA.id, 'ps -o stat= -p "$(cat /work/cancel-child.pid)" 2>/dev/null || true', "cancel-child-state");
    return !stat.trim() || /^[ZX]/.test(stat.trim());
  });
  pass("取消真正终止客机 sleep 300 子进程", cancelled);
  const appLong = await startRun(a.id, "仅使用 computer_shell 执行 echo $$ > /work/app-cancel-parent.pid; sleep 300 & echo $! > /work/app-cancel-child.pid; wait。不要设短超时，等待这条命令运行结束，不调用其他工具。 ");
  await waitFor(async () => (await command(pcA.id, "test -s /work/app-cancel-child.pid && printf READY || true", "app-cancel-ready")) === "READY", 120_000);
  const room = (await okPost("/api/rooms", { name: `Computer scope ${suffix}`, members: [a.id], adminId: a.id, mode: "admin" })).room;
  const beforeRoom = server.orch.ledger.lastSeq();
  const roomAttempt = await startRun(undefined, "使用 computer_shell 执行 printf ILLEGAL_ROOM_INPUT > /work/room-cross-scope.txt，然后报告结果。", { roomId: room.id });
  const roomDone = await finished(roomAttempt.id);
  assert.ok(server.orch.ledger.eventsSince(beforeRoom, { limit: 1000 }).some(event => event.type === "room_turn_error" && event.roomId === room.id));
  assert.equal(await command(pcA.id, "test ! -e /work/room-cross-scope.txt && printf ROOM_INPUT_REJECTED", "room-input-rejected"), "ROOM_INPUT_REJECTED");
  assert.equal((await api(pathA)).data.computer.holder, "agent");
  const takeoverDuringRun = (await okPost(`${pathA}/takeover`)).computer;
  assert.equal(takeoverDuringRun.holder, "human");
  await waitFor(async () => {
    const state = await command(pcA.id, 'ps -o stat= -p "$(cat /work/app-cancel-child.pid)" 2>/dev/null || true', "takeover-kill-confirm");
    return !state.trim() || /^[ZX]/.test(state.trim());
  });
  await okPost(`/api/runs/${appLong.id}/cancel`);
  const appCancelled = await finished(appLong.id);
  assert.equal(appCancelled.state, "cancelled", JSON.stringify(appCancelled.error));
  await okPost(`${pathA}/release`, { generation: takeoverDuringRun.generation });
  assert.equal((await post(`${pathA}/input`, { generation: takeoverDuringRun.generation, action: "key", key: "Enter" })).status, 409);
  pass("同机跨群与私聊互斥，运行中接管真正杀客机命令，取消收尾且旧输入作废", { rejectedRoomRunId: roomDone.id, cancelledRunId: appCancelled.id });

  const browser = (await command(pcA.id, "command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser", "browser-path")).trim().split("\n")[0];
  const profile = "/home/cua/.config/ompbot-smoke-browser";
  const browserMarker = `PROFILE_${suffix}`;
  const page = `<!doctype html><html><body><p id="proof"></p><script>const prior=localStorage.getItem('computer-proof');if(!prior)localStorage.setItem('computer-proof',${JSON.stringify(browserMarker)});document.getElementById('proof').textContent=prior||'CREATED_PROFILE';</script></body></html>`;
  assert.ok((await browserProof(pcA.id, browser, profile, page, "profile-before")).includes("CREATED_PROFILE"));
  await okPost(`${pathA}/stop`);
  assert.equal((await api(pathA)).data.computer.state, "stopped");
  await okPost(`${pathA}/start`);
  assert.equal(await command(pcA.id, "cat /work/output-a.txt", "persisted-work"), attachmentText);
  assert.ok((await browserProof(pcA.id, browser, profile, page, "profile-after")).includes(`<p id="proof">${browserMarker}</p>`));
  pass("停启保留客机工作文件与真实 Chromium 浏览器 localStorage", { browser, profile, browserMarker });

  const narrowedApproval = await api(`/api/bots/${b.id}`, { method: "PATCH", body: { permission: "ask" } });
  assert.equal(narrowedApproval.status, 200, narrowedApproval.data.error);
  const supervised = await startRun(b.id, "只调用 computer_shell 执行 printf SUPERVISED_APPROVAL_READY。等待真正批准后报告输出，不能换其他工具绕过。 ");
  const approval = await waitFor(async () => {
    const values = (await api("/api/approvals")).data.approvals;
    return values.find((item) => item.runId === supervised.id && item.status === "pending");
  }, 120_000);
  assert.equal((await api(`/api/runs/${supervised.id}`)).data.run.state, "waiting_approval");
  await okPost(`/api/approvals/${approval.id}/respond`, { value: "Approve" });
  const supervisedDone = await finished(supervised.id);
  assert.equal(supervisedDone.state, "completed", JSON.stringify(supervisedDone.error));
  assert.ok(supervisedDone.reply?.includes("SUPERVISED_APPROVAL_READY"));
  pass("真实 guest 命令沿用 native write 审批卡与明确批准", { runId: supervised.id, approvalId: approval.id });

  const chatMode = await api(`/api/bots/${b.id}`, { method: "PATCH", body: { permission: "chat" } });
  assert.equal(chatMode.status, 200, chatMode.data.error);
  await okPost(`${pathB}/takeover`);
  const heldChat = await startRun(b.id, "只回复 CHAT_WHILE_HUMAN_HELD。");
  const heldChatDone = await finished(heldChat.id);
  assert.equal(heldChatDone.state, "completed", JSON.stringify(heldChatDone.error));
  assert.ok(heldChatDone.reply?.includes("CHAT_WHILE_HUMAN_HELD"));
  await okPost(`${pathB}/stop`);
  const chatAttachmentText = `CHAT-ATTACHMENT-${suffix}`;
  const chatAttachment = (await okPost("/api/attachments", { botId: b.id, filename: "chat-source.txt", mime: "text/plain", dataBase64: Buffer.from(chatAttachmentText).toString("base64") })).attachment;
  const stoppedChat = await startRun(b.id, "读取本次附件，只回复附件原文。", { attachmentIds: [chatAttachment.id] });
  const stoppedChatDone = await finished(stoppedChat.id);
  assert.equal(stoppedChatDone.state, "completed", JSON.stringify(stoppedChatDone.error));
  assert.ok(stoppedChatDone.reply?.includes(chatAttachmentText));
  assert.equal((await api(pathB)).data.computer.state, "stopped");
  const chatState = await server.orch.getNativeState(b.id);
  assert.ok(!chatState.toolSurface.reported.some((name) => name.startsWith("computer_")));
  pass("绑定电脑的只聊天模式在人工接管与关机时仍可聊天和读取附件", { heldRunId: heldChat.id, stoppedRunId: stoppedChat.id, tools: chatState.toolSurface.reported });

  await server.close();
  server = await startServer({ home, port: 0, host: "127.0.0.1" });
  backend = await server.orch.features.computers.ensureBackend();
  const rebound = (await okPost(`${pathA}/start`)).computer;
  assert.equal(rebound.id, pcA.id);
  assert.equal(await command(pcA.id, "cat /work/output-a.txt", "service-reconnect"), attachmentText);
  pass("编排服务重启后恢复同一绑定与持久磁盘", { computerId: rebound.id });
  proof.status = "PASS";
} catch (error) {
  proof.status = "FAIL";
  proof.error = { name: error.name, code: error.code, message: error.message };
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) {
    backend ??= server.orch.features?.computers?.backend;
    await server.close();
  }
  if (backend) {
    for (const bot of proof.bots) {
      try {
        await backend.stop(server.orch.features.computers.computerIdFor(bot.id));
      } catch (error) {
        (proof.cleanupErrors ??= []).push({ botId: bot.id, code: error.code, message: error.message });
        proof.status = "FAIL";
        process.exitCode = 1;
      }
    }
    await backend.close();
  }
  proof.finishedAt = new Date().toISOString();
  save();
  if (!keep && proof.status === "PASS") rmSync(home, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: proof.status, checks: proof.checks.length, proofPath, home: keep || proof.status !== "PASS" ? home : "removed owned temporary home" }));

// test/mobile.mjs — 手机伴侣入口的真实断言（零模型调用）。
// 覆盖：opt-in 持久化与生命周期、广播地址、APK 下载、设备入口的 Origin/Cookie/owner 凭据隔离、
// 默认拒绝路由、配对/作用域/读写审批权限、附件与成果的资源归属、邀请二维码与撤销后 SSE 关闭。
// 请求走真实 HTTP socket；模型运行使用下方注入的夹具。

import { request } from "node:http";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "../src/server.mjs";

let passed = 0;
let failed = 0;
function check(name, ok, ev = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ev ? "\n      " + ev : ""}`);
}

/** 注入的 runtime 夹具：只实现编排器真正调用的原生面（零模型调用），与 test/runs.mjs 同语义。 */
class FakeRuntime extends EventEmitter {
  constructor({ bot, scope, home, teamToolsFactory }) {
    super();
    this.bot = bot;
    this.scope = scope;
    this.home = home;
    this.state = "stopped";
    this.sessionId = `sess_${bot.id}`;
    this.sessionFile = join(home, "fixtures", `${bot.id}.jsonl`);
    this.activeRun = null;
    this.capabilities = { protocolVersion: 2, extensionUi: true, abort: true };
    this.tools = typeof teamToolsFactory === "function" ? teamToolsFactory(this) : [];
    this.rpc = { env: {} };
    this.queue = [];
    this.turns = 0;
    this._abortWaiters = [];
  }
  get busy() {
    return this.state === "busy";
  }
  get alive() {
    return this.state === "idle" || this.state === "busy";
  }
  matchesPolicy() {
    return true;
  }
  async start() {
    this.state = "idle";
    this.emit("capabilities", this.capabilities);
    return this;
  }
  async stop() {
    this.state = "stopped";
    const err = Object.assign(new Error("rpc process exited (killed)"), { settled: false, killed: true });
    for (const w of this._abortWaiters.splice(0)) w.reject(err);
  }
  async abort() {
    for (const w of this._abortWaiters.splice(0)) {
      w.reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted", settled: true }));
    }
    return { ok: true };
  }
  async abortBash() {
    return null;
  }
  async cancelSubagent() {
    return null;
  }
  async waitSettled() {
    return { settled: this._abortWaiters.length === 0, source: "fixture" };
  }
  /** 宿主确认静默后落回 idle（与真实 BotRuntime 同名同语义）。 */
  markSettled() {
    this.state = "idle";
    this.activeRun = null;
    return this.state;
  }
  async getStats() {
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      model: "fixture/mobile",
      provider: "fixture",
      tokens: { input: 1, output: 1, total: 2 },
      cost: 0,
      userMessages: this.turns,
    };
  }
  async promptAndWait(text, { runId } = {}) {
    this.state = "busy";
    this.activeRun = { runId: runId ?? null, abort: new AbortController() };
    const step = this.queue.shift() ?? { kind: "complete" };
    try {
      if (step.kind === "hang") {
        await new Promise((resolve, reject) => {
          this._abortWaiters.push({ resolve, reject });
        });
      }
      this.turns += 1;
      this.state = "idle";
      return { text: `fixture-reply:${text}` };
    } catch (e) {
      this.state = e?.killed === true ? "stopped" : "idle";
      throw e;
    } finally {
      this.activeRun = null;
    }
  }
}

const home = mkdtempSync(join(tmpdir(), "ompbot-mobile-"));
const apkDir = mkdtempSync(join(tmpdir(), "ompbot-mobile-apk-"));
const apkPath = join(apkDir, "omp-bot-android.apk");
const APK_BYTES = Buffer.from("PK-FAKE-APK-FOR-TEST");
writeFileSync(apkPath, APK_BYTES);

const server = await startServer({
  port: 0,
  host: "127.0.0.1",
  home,
  bin: join(home, "no-such-omp-binary"),
  mobile: { apkPath },
  runtimeFactory: (opts) => new FakeRuntime(opts),
});
const { url, token, orch, close } = server;
const port = Number(new URL(url).port);

/** 原始 HTTP（可指定目标端口与任意头）；连接层错误返回 status 0，不抛异常。 */
function raw(targetPort, path, { method = "GET", headers = {}, body = null, host = null } = {}) {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: targetPort, method, path, headers: { Host: host ?? `127.0.0.1:${targetPort}`, ...headers } },
      (res) => {
        res.on("error", () => {});
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString("utf8") });
        });
      },
    );
    req.on("error", (e) => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), text: "", error: e?.code ?? e?.message ?? "socket error" }));
    if (body !== null) req.write(body);
    req.end();
  });
}
const loopback = (path, opts) => raw(port, path, opts);
const jsonHeaders = (extra = {}) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra });

async function api(path, opts = {}) {
  const res = await fetch(url + path, {
    ...opts,
    headers: { ...jsonHeaders(), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => ({})) };
}

/** 打开 SSE 并保持连接，返回可观察的 {status,text,ended}。 */
function sseOpen(targetPort, headers) {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: targetPort, method: "GET", path: "/api/events", headers: { Host: `127.0.0.1:${targetPort}`, ...headers } },
      (res) => {
        const state = { status: res.statusCode, text: "", ended: false };
        res.on("error", () => {});
        res.on("data", (c) => {
          state.text += c.toString("utf8");
        });
        res.on("end", () => {
          state.ended = true;
        });
        resolve(state);
      },
    );
    req.on("error", () => resolve({ status: 0, text: "", ended: true }));
    req.end();
  });
}

async function waitRunTerminal(runId, budgetMs = 10_000) {
  const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
  for (let waited = 0; waited < budgetMs; waited += 100) {
    const state = orch.getRun(runId)?.state;
    if (terminal.has(state)) return state;
    await sleep(100);
  }
  return orch.getRun(runId)?.state ?? null;
}

let gwPort = 0;
let chatProbe = null;
try {
  // ---- owner 状态：默认关闭、广播地址与 APK ----
  const before = await api("/api/mobile");
  check(
    "GET /api/mobile 默认关闭且不监听",
    before.status === 200 && before.data.enabled === false && before.data.running === false,
    JSON.stringify(before.data),
  );
  check("默认 host/port 是 0.0.0.0:3100", before.data.host === "0.0.0.0" && before.data.port === 3100);
  check(
    "apk 可用时指向 owner 服务 /api/mobile/apk",
    before.data.apk?.available === true && before.data.apk?.url === "/api/mobile/apk",
    JSON.stringify(before.data.apk),
  );
  const apkDl = await loopback("/api/mobile/apk", { headers: { Authorization: `Bearer ${token}` } });
  check(
    "owner 下载 APK 得到真实字节",
    apkDl.status === 200 &&
      apkDl.buf.equals(APK_BYTES) &&
      /attachment/.test(String(apkDl.headers["content-disposition"])) &&
      String(apkDl.headers["content-type"]).includes("android.package-archive"),
    `status=${apkDl.status}`,
  );
  check("入口未运行时签发邀请 409", (await api("/api/mobile/invitation", { method: "POST", body: { botIds: ["x"], address: "http://x" } })).status === 409);

  // ---- 启用：真实监听 + 配置持久化 ----
  const enabled = await api("/api/mobile", { method: "POST", body: { enabled: true, host: "127.0.0.1", port: 0 } });
  gwPort = enabled.data.port;
  check(
    "POST /api/mobile 启用后真实监听随机端口",
    enabled.status === 200 && enabled.data.running === true && Number.isInteger(gwPort) && gwPort > 0,
    JSON.stringify(enabled.data),
  );
  const persisted = JSON.parse(readFileSync(join(home, "mobile.json"), "utf8"));
  check(
    "opt-in 持久化在 home/mobile.json",
    persisted.enabled === true && persisted.host === "127.0.0.1" && persisted.port === 0,
    JSON.stringify(persisted),
  );
  check(
    "回环绑定只广播 loopback 地址",
    enabled.data.addresses.some((a) => a.kind === "loopback" && a.url === `http://127.0.0.1:${gwPort}`),
    JSON.stringify(enabled.data.addresses),
  );
  check("非法 host 显式 400", (await api("/api/mobile", { method: "POST", body: { host: "no.such.host" } })).status === 400);
  check("非法 port 显式 400", (await api("/api/mobile", { method: "POST", body: { port: 70000 } })).status === 400);

  // ---- publicUrl 只收服务根地址：账号/路径/查询/片段/协议不符一律显式 400，不落盘 ----
  for (const bad of [
    "http://user:pw@192.168.1.9:3100",
    "https://phone.example.com/omp",
    "https://phone.example.com/?token=x",
    "https://phone.example.com/#frag",
    "ftp://phone.example.com",
    "not a url",
  ]) {
    const r = await api("/api/mobile", { method: "POST", body: { publicUrl: bad } });
    check(`非法 publicUrl 400 mobile_config_invalid（${bad}）`, r.status === 400 && r.data.code === "mobile_config_invalid", JSON.stringify(r.data));
  }
  const afterBadUrl = JSON.parse(readFileSync(join(home, "mobile.json"), "utf8"));
  check("非法 publicUrl 不落盘", afterBadUrl.publicUrl === null, JSON.stringify(afterBadUrl));
  const withPublic = await api("/api/mobile", { method: "POST", body: { publicUrl: "https://phone.example.com" } });
  gwPort = withPublic.data.port;
  check(
    "合法 publicUrl 落盘并广播 public 地址",
    withPublic.status === 200 &&
      JSON.parse(readFileSync(join(home, "mobile.json"), "utf8")).publicUrl === "https://phone.example.com" &&
      withPublic.data.addresses.some((a) => a.kind === "public" && a.url === "https://phone.example.com"),
    JSON.stringify(withPublic.data.addresses),
  );

  const gw = (path, opts) => raw(gwPort, path, opts);
  const readJson = (res) => JSON.parse(res.text || "{}");

  // ---- 设备入口：公开面与隔离 ----
  const health = await gw("/api/health");
  const healthJson = readJson(health);
  check(
    "公开 /api/health 报协议名",
    health.status === 200 && healthJson.name === "omp-bot" && healthJson.protocol === "ompbot-mobile-v1",
    health.text.slice(0, 80),
  );
  check("公开下载 APK 只有字节", (await gw("/download/omp-bot.apk")).buf.equals(APK_BYTES));
  for (const p of ["/index.html", "/app.js", "/api/mobile", "/api/mobile/invitation", "/api/mobile/apk", "/api/pairing", "/api/pairing/codes", "/api/bots", "/api/models"]) {
    const r = await gw(p);
    check(`入口默认拒绝 ${p}`, r.status === 404 && /gateway_route_denied/.test(r.text), `status=${r.status} ${r.text.slice(0, 90)}`);
  }
  const postMobile = await gw("/api/mobile", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("入口默认拒绝 POST 控制面", postMobile.status === 404 && /gateway_route_denied/.test(postMobile.text));
  const deletePairing = await gw("/api/pairing/dev_probe", { method: "DELETE" });
  check("入口不发布配对撤销（owner 面）", deletePairing.status === 404 && /gateway_route_denied/.test(deletePairing.text));
  const postCodes = await gw("/api/pairing/codes", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("入口不发布配对签发（owner 面）", postCodes.status === 404 && /gateway_route_denied/.test(postCodes.text));
  const deleteAttachment = await gw("/api/attachments/att_probe", { method: "DELETE" });
  check("入口不发布附件删除", deleteAttachment.status === 404 && /gateway_route_denied/.test(deleteAttachment.text));
  const badMethod = await gw("/api/state", { method: "PATCH" });
  check("已知路径错方法 405 gateway_method_denied", badMethod.status === 405 && /gateway_method_denied/.test(badMethod.text), `status=${badMethod.status}`);
  const ownerBearer = await gw("/api/state", { headers: { Authorization: `Bearer ${token}` } });
  check(
    "入口拒绝 owner Bearer 403 gateway_owner_credential_denied",
    ownerBearer.status === 403 && /gateway_owner_credential_denied/.test(ownerBearer.text),
    `status=${ownerBearer.status}`,
  );
  const cookieReq = await gw("/api/state", { headers: { Cookie: "omp_session=deadbeef" } });
  check("入口拒绝 Cookie 403 gateway_cookie_denied", cookieReq.status === 403 && /gateway_cookie_denied/.test(cookieReq.text), `status=${cookieReq.status}`);
  const originReq = await gw("/api/state", { headers: { Origin: "http://evil.test" } });
  check("入口拒绝 Origin 403 gateway_origin_denied", originReq.status === 403 && /gateway_origin_denied/.test(originReq.text), `status=${originReq.status}`);
  const fetchReq = await gw("/api/state", { headers: { "Sec-Fetch-Site": "cross-site" } });
  check("入口拒绝 Sec-Fetch-* 403 gateway_browser_denied", fetchReq.status === 403 && /gateway_browser_denied/.test(fetchReq.text), `status=${fetchReq.status}`);
  check("无凭证 /api/state 由回环服务 401", (await gw("/api/state")).status === 401);

  // ---- 配对与作用域 ----
  const botA = (await api("/api/bots", { method: "POST", body: { name: "MobileA" } })).data.bot;
  const botB = (await api("/api/bots", { method: "POST", body: { name: "MobileB" } })).data.bot;

  const codeA = (await api("/api/pairing/codes", { method: "POST", body: { botIds: [botA.id], label: "phone" } })).data.code;
  const redeemed = await gw("/api/pairing/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: codeA, name: "phone" }),
  });
  const deviceA = readJson(redeemed);
  check(
    "经设备入口兑换配对码",
    redeemed.status === 200 && typeof deviceA.token === "string" && deviceA.device?.permissions?.join(",") === "read,run",
    `status=${redeemed.status}`,
  );
  const devHeaders = { Authorization: `Bearer ${deviceA.token}` };
  const stateA = await gw("/api/state", { headers: devHeaders });
  const stateAJson = readJson(stateA);
  check(
    "设备状态只含授权 bot 且是设备安全投影",
    stateA.status === 200 &&
      stateAJson.bots?.length === 1 &&
      stateAJson.bots[0].id === botA.id &&
      Object.keys(stateAJson.bots[0]).sort().join(",") === "id,isMain,model,name,role",
    JSON.stringify(stateAJson.bots),
  );
  check("设备读授权 chat 200", (await gw(`/api/chat/${botA.id}`, { headers: devHeaders })).status === 200);
  const chatOut = await gw(`/api/chat/${botB.id}`, { headers: devHeaders });
  check("设备读未授权 chat 403 DEVICE_OUT_OF_SCOPE", chatOut.status === 403 && /DEVICE_OUT_OF_SCOPE/.test(chatOut.text), `status=${chatOut.status}`);
  for (const p of ["/api/state", "/api/runs", "/api/approvals", "/api/attachments", "/api/artifacts", "/api/events/history"]) {
    const r = await gw(p, { headers: devHeaders });
    check(`已发布路径 ${p} 对设备真实可达`, r.status === 200, `status=${r.status} ${r.text.slice(0, 80)}`);
  }

  // ---- 派活：字段白名单、来源、作用域 ----
  const outOfScopeRun = await gw("/api/runs", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botB.id, text: "越界" }),
  });
  check("设备派活到未授权 bot 403 DEVICE_OUT_OF_SCOPE", outOfScopeRun.status === 403 && /DEVICE_OUT_OF_SCOPE/.test(outOfScopeRun.text), `status=${outOfScopeRun.status}`);
  const extraField = await gw("/api/runs", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botA.id, text: "x", parentRunId: "run_probe" }),
  });
  check("设备填内部编排字段 400 DEVICE_FIELD_DENIED", extraField.status === 400 && /DEVICE_FIELD_DENIED/.test(extraField.text), `status=${extraField.status} ${extraField.text.slice(0, 120)}`);
  const depthField = await gw("/api/runs", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botA.id, text: "x", depth: 2 }),
  });
  check("设备填 depth 400 DEVICE_FIELD_DENIED", depthField.status === 400 && /DEVICE_FIELD_DENIED/.test(depthField.text));
  const runRes = await gw("/api/runs", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botA.id, text: "mobile task" }),
  });
  const runJson = readJson(runRes);
  check(
    "设备派活 202 且来源/深度由服务端裁定",
    runRes.status === 202 && runJson.run?.botId === botA.id && String(runJson.run?.source).startsWith("device:") && runJson.run?.depth === 0,
    `status=${runRes.status} ${runRes.text.slice(0, 140)}`,
  );
  const runFetch = await gw(`/api/runs/${runJson.run.id}`, { headers: devHeaders });
  const runFetchJson = readJson(runFetch);
  check("设备读 run 时剔除 sessionFile", runFetch.status === 200 && !("sessionFile" in (runFetchJson.run ?? {})), Object.keys(runFetchJson.run ?? {}).join(","));
  const runsB = readJson(await gw(`/api/runs?botId=${botB.id}`, { headers: devHeaders }));
  check("设备 runs 列表按作用域过滤", Array.isArray(runsB.runs) && runsB.runs.length === 0, JSON.stringify(runsB).slice(0, 120));

  // ---- 审批：approve 权限与作用域 ----
  const approvalOf = (id, botId) => ({
    id,
    runId: runJson.run.id,
    botId,
    scope: "private",
    nativeId: "native_mobile",
    method: "confirm",
    title: "Approve?",
    message: "mobile",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  orch.ledger.put("approvals", approvalOf("appr_mobile_a", botA.id));
  orch.ledger.put("approvals", approvalOf("appr_mobile_b", botB.id));
  const noApprove = await gw("/api/approvals/appr_mobile_a/respond", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed: true }),
  });
  check("默认设备无 approve 权限 403 DEVICE_FORBIDDEN", noApprove.status === 403 && /DEVICE_FORBIDDEN/.test(noApprove.text), `status=${noApprove.status}`);
  const approveCode = (await api("/api/pairing/codes", { method: "POST", body: { botIds: [botA.id], permissions: ["read", "run", "approve"], label: "approver" } })).data.code;
  const approver = readJson(
    await gw("/api/pairing/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: approveCode }) }),
  );
  const approverHeaders = { Authorization: `Bearer ${approver.token}`, "Content-Type": "application/json" };
  const terminalState = await waitRunTerminal(runJson.run.id);
  const apRespond = await gw("/api/approvals/appr_mobile_a/respond", {
    method: "POST",
    headers: approverHeaders,
    body: JSON.stringify({ confirmed: true }),
  });
  check(
    "有 approve 权限的设备进入真实审批回答路径（显式错误，非 403/假成功）",
    apRespond.status !== 403 && [400, 409].includes(apRespond.status),
    `run=${terminalState} status=${apRespond.status} ${apRespond.text.slice(0, 120)}`,
  );
  const apOutOfScope = await gw("/api/approvals/appr_mobile_b/respond", {
    method: "POST",
    headers: approverHeaders,
    body: JSON.stringify({ confirmed: true }),
  });
  check("跨 bot 代答 403 DEVICE_OUT_OF_SCOPE", apOutOfScope.status === 403 && /DEVICE_OUT_OF_SCOPE/.test(apOutOfScope.text), `status=${apOutOfScope.status}`);

  // ---- 附件：上传/列表/预览的资源归属 ----
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const upload = async (botId, filename) =>
    api("/api/attachments", {
      method: "POST",
      body: { botId, filename, mime: "image/png", dataBase64: PNG.toString("base64") },
    });
  const attA = (await upload(botA.id, "a.png")).data.attachment;
  const attB = (await upload(botB.id, "b.png")).data.attachment;
  const listA = readJson(await gw(`/api/attachments?botId=${botA.id}`, { headers: devHeaders }));
  check(
    "设备附件列表只含作用域内记录且无宿主路径",
    listA.attachments?.length === 1 && listA.attachments[0].id === attA.id && !("path" in listA.attachments[0]),
    JSON.stringify(listA).slice(0, 160),
  );
  const listNoBot = readJson(await gw("/api/attachments", { headers: devHeaders }));
  check("不带 botId 的列表同样被作用域过滤", listNoBot.attachments?.length === 1 && listNoBot.attachments[0].id === attA.id);
  const prevA = await gw(`/api/attachments/${attA.id}/preview`, { headers: devHeaders });
  check("设备预览作用域内图片附件", prevA.status === 200 && prevA.headers["content-type"] === "image/png" && prevA.buf.equals(PNG), `status=${prevA.status}`);
  const prevB = await gw(`/api/attachments/${attB.id}/preview`, { headers: devHeaders });
  check(
    "设备预览别家附件 403（按登记记录归属判定）",
    prevB.status === 403 && /DEVICE_OUT_OF_SCOPE/.test(prevB.text),
    `status=${prevB.status} ${prevB.text.slice(0, 120)}`,
  );
  const upOut = await gw("/api/attachments", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botB.id, filename: "x.png", mime: "image/png", dataBase64: PNG.toString("base64") }),
  });
  check("设备上传到未授权 bot 403", upOut.status === 403 && /DEVICE_OUT_OF_SCOPE/.test(upOut.text), `status=${upOut.status}`);
  const upIn = await gw("/api/attachments", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botA.id, filename: "up.png", mime: "image/png", dataBase64: PNG.toString("base64") }),
  });
  check("设备上传到授权 bot 成功（需 run 权限）", upIn.status === 200 && readJson(upIn).attachment?.botId === botA.id, `status=${upIn.status} ${upIn.text.slice(0, 120)}`);
  const readCode = (await api("/api/pairing/codes", { method: "POST", body: { botIds: [botA.id], permissions: ["read"], label: "readonly" } })).data.code;
  const readonlyDevice = readJson(
    await gw("/api/pairing/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: readCode }) }),
  );
  const readHeaders = { Authorization: `Bearer ${readonlyDevice.token}`, "Content-Type": "application/json" };
  check("只读设备可读附件列表", (await gw(`/api/attachments?botId=${botA.id}`, { headers: readHeaders })).status === 200);
  const readUp = await gw("/api/attachments", {
    method: "POST",
    headers: readHeaders,
    body: JSON.stringify({ botId: botA.id, filename: "ro.png", mime: "image/png", dataBase64: PNG.toString("base64") }),
  });
  check("只读设备上传 403 DEVICE_FORBIDDEN", readUp.status === 403 && /DEVICE_FORBIDDEN/.test(readUp.text), `status=${readUp.status}`);
  const readRun = await gw("/api/runs", { method: "POST", headers: readHeaders, body: JSON.stringify({ botId: botA.id, text: "x" }) });
  check("只读设备派活 403 DEVICE_FORBIDDEN", readRun.status === 403 && /DEVICE_FORBIDDEN/.test(readRun.text), `status=${readRun.status}`);
  const crossAtt = await gw("/api/runs", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botA.id, text: "x", attachmentIds: [attB.id] }),
  });
  check("设备跨 bot 引用附件派活 403 DEVICE_RESOURCE_OUT_OF_SCOPE", crossAtt.status === 403 && /DEVICE_RESOURCE_OUT_OF_SCOPE/.test(crossAtt.text), `status=${crossAtt.status}`);
  const goodAtt = await gw("/api/runs", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botA.id, text: "x", attachmentIds: [attA.id] }),
  });
  check("设备引用自家附件派活 202", goodAtt.status === 202, `status=${goodAtt.status} ${goodAtt.text.slice(0, 120)}`);

  // ---- 无 read 权限的设备：GET 面（含状态/审批/私聊/列表）集中 403，run 权限照常可用 ----
  const runOnlyCode = (await api("/api/pairing/codes", { method: "POST", body: { botIds: [botA.id], permissions: ["run"], label: "run-only" } })).data.code;
  const runOnlyDevice = readJson(
    await gw("/api/pairing/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runOnlyCode }) }),
  );
  const runHeaders = { Authorization: `Bearer ${runOnlyDevice.token}`, "Content-Type": "application/json" };
  check("无 read 权限设备兑换成功", runOnlyDevice.device?.permissions?.join(",") === "run", JSON.stringify(runOnlyDevice.device));
  for (const p of ["/api/state", "/api/approvals", `/api/chat/${botA.id}`, "/api/runs", "/api/attachments", "/api/artifacts"]) {
    const r = await gw(p, { headers: runHeaders });
    check(`无 read 权限设备读 ${p} 403 DEVICE_FORBIDDEN`, r.status === 403 && /DEVICE_FORBIDDEN/.test(r.text), `status=${r.status} ${r.text.slice(0, 100)}`);
  }
  const runOnlyRun = await gw("/api/runs", { method: "POST", headers: runHeaders, body: JSON.stringify({ botId: botA.id, text: "无 read 也能派活" }) });
  const runOnlyRunId = readJson(runOnlyRun).run?.id;
  check("无 read 权限设备仍可派活（run 权限独立）", runOnlyRun.status === 202 && typeof runOnlyRunId === "string", `status=${runOnlyRun.status} ${runOnlyRun.text.slice(0, 120)}`);
  check("无 read 权限设备的派活真实跑完", (await waitRunTerminal(runOnlyRunId)) === "completed", `run=${runOnlyRunId}`);

  // ---- 成果：列表投影与下载/预览归属 ----
  const seedArtifact = (botId, id, name, content) => {
    const dir = join(home, "artifacts", botId, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content);
    const buf = readFileSync(path);
    orch.ledger.put("artifacts", {
      id,
      botId,
      runId: null,
      scope: "private",
      root: "C:/fake-root",
      relPath: name,
      sourcePath: `C:/fake-root/${name}`,
      path,
      name,
      mime: "text/plain",
      previewType: "text",
      size: buf.length,
      hash: createHash("sha256").update(buf).digest("hex"),
      version: 1,
      immutable: true,
      createdAt: Date.now(),
      downloads: 0,
    });
    return path;
  };
  const artText = "hello-artifact";
  seedArtifact(botA.id, "art_mobile_a", "note.txt", artText);
  seedArtifact(botB.id, "art_mobile_b", "other.txt", "OTHER");
  const artList = readJson(await gw(`/api/artifacts?botId=${botA.id}`, { headers: devHeaders }));
  check(
    "设备成果列表只含作用域内记录且无宿主路径",
    artList.artifacts?.length === 1 &&
      artList.artifacts[0].id === "art_mobile_a" &&
      !("path" in artList.artifacts[0]) &&
      !("root" in artList.artifacts[0]) &&
      !("sourcePath" in artList.artifacts[0]),
    JSON.stringify(artList).slice(0, 180),
  );
  const dlOut = await gw("/api/artifacts/art_mobile_b/download", { headers: devHeaders });
  check("设备下载别家成果 403", dlOut.status === 403 && /DEVICE_OUT_OF_SCOPE/.test(dlOut.text), `status=${dlOut.status}`);
  const dlIn = await gw("/api/artifacts/art_mobile_a/download", { headers: devHeaders });
  check("设备下载自家成果得到真实字节", dlIn.status === 200 && dlIn.buf.toString("utf8") === artText, `status=${dlIn.status}`);
  const pvIn = await gw("/api/artifacts/art_mobile_a/preview", { headers: devHeaders });
  check("设备预览自家文本成果", pvIn.status === 200 && pvIn.text === artText, `status=${pvIn.status}`);

  // ---- 设备主体不能碰 owner 面（同一放行表在回环服务上生效） ----
  const devMobile = await loopback("/api/mobile", { headers: devHeaders });
  check("设备读 owner 控制面 403 DEVICE_NO_ADMIN", devMobile.status === 403 && /DEVICE_NO_ADMIN/.test(devMobile.text), `status=${devMobile.status}`);
  const devAttList = await loopback(`/api/attachments?botId=${botA.id}`, { headers: devHeaders });
  check("回环服务上设备走同一放行表读附件 200", devAttList.status === 200, `status=${devAttList.status}`);
  const devDelete = await loopback(`/api/attachments/${attA.id}`, { method: "DELETE", headers: devHeaders });
  check("设备删除附件 403 DEVICE_NO_ADMIN", devDelete.status === 403 && /DEVICE_NO_ADMIN/.test(devDelete.text), `status=${devDelete.status}`);

  // ---- 私聊历史：device 来源入库；渠道/计划/委派不入库（注入 runtime 夹具，零模型调用）----
  const chatTexts = async () =>
    (readJson(await gw(`/api/chat/${botA.id}`, { headers: devHeaders })).messages ?? []).map((m) => m.text);
  const baseChat = await chatTexts();
  const feishuRun = orch.startRun({ botId: botA.id, text: "渠道探针", source: "feishu:ou_mobile_probe" });
  await waitRunTerminal(feishuRun.id);
  const routineRun = orch.startRun({ botId: botA.id, text: "计划探针", source: "routine" });
  await waitRunTerminal(routineRun.id);
  const botBFake = await orch.runtimeFor(botB.id, "private");
  botBFake.queue = [{ kind: "hang" }];
  const parentRun = orch.startRun({ botId: botB.id, text: "委派父回合", source: "feishu:ou_parent" });
  await sleep(100);
  const delegatedRun = orch.startRun({ botId: botA.id, text: "委派探针", source: "bot", parentRunId: parentRun.id, depth: 1 });
  await waitRunTerminal(delegatedRun.id);
  await orch.cancelRun(parentRun.id, "probe-done");
  const parentState = await waitRunTerminal(parentRun.id);
  const afterExcluded = await chatTexts();
  check(
    "渠道/计划/委派来源不进私聊历史",
    parentState === "cancelled" &&
      afterExcluded.join("|") === baseChat.join("|") &&
      !afterExcluded.some((t) => String(t).includes("渠道探针") || String(t).includes("计划探针") || String(t).includes("委派探针")),
    `parent=${parentState} chat=${JSON.stringify(afterExcluded)}`,
  );
  const historyRun = await gw("/api/runs", {
    method: "POST",
    headers: { ...devHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: botA.id, text: "手机历史探针" }),
  });
  const historyRunId = readJson(historyRun).run?.id;
  await waitRunTerminal(historyRunId);
  const afterDevice = await chatTexts();
  check(
    "设备来源 run 写入用户+助手私聊历史",
    afterDevice.includes("手机历史探针") &&
      afterDevice.some((t) => String(t).startsWith("fixture-reply:") && String(t).includes("手机历史探针")),
    JSON.stringify(afterDevice),
  );
  // 重启后由另一个仍有效的设备凭证读同一段历史（botA 作用域）。
  chatProbe = { botId: botA.id, token: approver.token };

  // ---- 邀请：真实二维码契约 + 地址校验 ----
  const addresses = (await api("/api/mobile")).data.addresses;
  const loopbackAddress = addresses.find((a) => a.kind === "loopback");
  const inv = await api("/api/mobile/invitation", {
    method: "POST",
    body: { botIds: [botA.id], permissions: ["read", "run"], label: "invite", address: loopbackAddress.url },
  });
  const invData = inv.data;
  check(
    "邀请返回 ticket/code/url/qrDataUrl",
    inv.status === 200 &&
      typeof invData.ticket?.id === "string" &&
      typeof invData.ticket?.expiresAt === "number" &&
      invData.ticket.expiresAt > Date.now() &&
      /^ompcode_/.test(String(invData.code)),
    JSON.stringify({ status: inv.status, code: String(invData.code).slice(0, 12), ticket: invData.ticket }),
  );
  check(
    "邀请 URL 是 ompbot:// 且只带一次性码与备注名",
    invData.url ===
      `ompbot://pair?v=1&address=${encodeURIComponent(loopbackAddress.url)}&code=${encodeURIComponent(invData.code)}&name=${encodeURIComponent("invite")}`,
    invData.url,
  );
  check(
    "二维码是服务端生成的 PNG data url",
    String(invData.qrDataUrl).startsWith("data:image/png;base64,") && String(invData.qrDataUrl).length > 200,
    String(invData.qrDataUrl).slice(0, 48),
  );
  check("URL 里没有 owner token 与长期设备凭证", !invData.url.includes(token) && !/ompd_/.test(invData.url));
  const badAddress = await api("/api/mobile/invitation", { method: "POST", body: { botIds: [botA.id], address: "http://10.255.255.1:1" } });
  check("非法 address 400 mobile_address_invalid", badAddress.status === 400 && badAddress.data.code === "mobile_address_invalid", JSON.stringify(badAddress.data));
  const badPerm = await api("/api/mobile/invitation", { method: "POST", body: { botIds: [botA.id], permissions: ["admin"], address: loopbackAddress.url } });
  check("越权权限 400 PAIRING_BAD_PERMISSIONS", badPerm.status === 400 && badPerm.data.code === "PAIRING_BAD_PERMISSIONS", JSON.stringify(badPerm.data));
  const invited = await gw("/api/pairing/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: invData.code, name: "qr-phone" }) });
  check("二维码里的码经设备入口真实可兑换", invited.status === 200 && readJson(invited).device?.botIds?.includes(botA.id), `status=${invited.status}`);

  // ---- SSE：范围过滤、事件投影、撤销立即关闭 ----
  const stream = await sseOpen(gwPort, { Authorization: `Bearer ${deviceA.token}` });
  await sleep(150);
  check("设备 SSE 经入口建立", stream.status === 200, `status=${stream.status}`);
  orch.emit("mobile_probe", { botId: botA.id, n: 1 });
  await sleep(250);
  check("设备 SSE 收到授权 bot 事件", stream.text.includes('"n":1'));
  orch.emit("mobile_probe", { botId: botB.id, n: 2 });
  await sleep(250);
  check("设备 SSE 收不到未授权 bot 事件", !stream.text.includes('"n":2'));
  orch.emit("artifact_added", {
    botId: botA.id,
    artifact: { id: "art_evt_probe", botId: botA.id, path: "C:/secret/root/f.txt", root: "C:/secret/root", sourcePath: "C:/secret/root/f.txt" },
  });
  await sleep(250);
  check(
    "SSE 事件里的成果剔除了宿主路径",
    stream.text.includes("art_evt_probe") && !stream.text.includes("C:/secret"),
    stream.text.replace(/\n/g, " ").slice(0, 200),
  );
  const revoked = await api(`/api/pairing/${deviceA.device.id}`, { method: "DELETE" });
  await sleep(300);
  check("撤销设备后已建立的 SSE 被关闭", revoked.status === 200 && stream.ended, `ended=${stream.ended}`);
  const afterRevoke = await gw("/api/state", { headers: devHeaders });
  check(
    "撤销后的凭证 401 DEVICE_REVOKED（提示重新配对）",
    afterRevoke.status === 401 && /DEVICE_REVOKED/.test(afterRevoke.text),
    `status=${afterRevoke.status} ${afterRevoke.text.slice(0, 120)}`,
  );
  check("撤销一台设备不影响其他设备", (await gw("/api/state", { headers: approverHeaders })).status === 200);

  // ---- 停用/重启：真实生效并持久化 ----
  const stopped = await api("/api/mobile", { method: "POST", body: { enabled: false } });
  check("停用后 running=false 且持久化", stopped.data.running === false && JSON.parse(readFileSync(join(home, "mobile.json"), "utf8")).enabled === false);
  check("停用后端口不再监听", (await gw("/api/health")).status === 0);
  const reenabled = await api("/api/mobile", { method: "POST", body: { enabled: true, host: "127.0.0.1", port: 0 } });
  check("再次启用真实监听", reenabled.data.running === true && reenabled.data.port > 0, JSON.stringify(reenabled.data));
  gwPort = reenabled.data.port ?? gwPort;
} finally {
  await close();
  check("close() 关闭设备入口端口", gwPort > 0 ? (await raw(gwPort, "/api/health")).status === 0 : false);
}

// ---- 重启后按持久化 opt-in 自动拉起 ----
const server2 = await startServer({
  port: 0,
  host: "127.0.0.1",
  home,
  bin: join(home, "no-such-omp-binary"),
  mobile: { apkPath },
});
try {
  const s2 = await api2(server2, "/api/mobile");
  check("重启后持久化 opt-in 自动拉起", s2.data.enabled === true && s2.data.running === true && s2.data.port > 0, JSON.stringify(s2.data));
  const s2chatRes = chatProbe
    ? await fetch(server2.url + `/api/chat/${chatProbe.botId}`, { headers: { Authorization: `Bearer ${chatProbe.token}` } })
    : { status: 0, json: async () => ({}) };
  const s2chat = await s2chatRes.json().catch(() => ({}));
  check(
    "重启后设备私聊历史仍在（state.json 持久化）",
    s2chatRes.status === 200 && (s2chat.messages ?? []).some((m) => m.text === "手机历史探针"),
    `status=${s2chatRes.status} ${JSON.stringify(s2chat).slice(0, 160)}`,
  );
  const s2off = await api2(server2, "/api/mobile", { method: "POST", body: { enabled: false } });
  check("重启后仍可停用（GET/POST 对称）", s2off.data.running === false);
} finally {
  await server2.close();
}

// ---- 构建晚于进程启动：APK 出现后按下一次状态查询/下载请求真实生效，不假报可用 ----
const lateDir = mkdtempSync(join(tmpdir(), "ompbot-mobile-late-"));
const lateApk = join(lateDir, "omp-bot-android.apk");
const server3 = await startServer({
  port: 0,
  host: "127.0.0.1",
  home,
  bin: join(home, "no-such-omp-binary"),
  mobile: { apkPath: lateApk },
});
try {
  const s3before = await api2(server3, "/api/mobile");
  check("APK 未构建时 available=false 且无下载地址", s3before.data.apk?.available === false && s3before.data.apk?.url === null, JSON.stringify(s3before.data.apk));
  const s3miss = await fetch(server3.url + "/api/mobile/apk", { headers: { Authorization: `Bearer ${server3.token}` } });
  check("未构建时下载 APK 404 apk_unavailable", s3miss.status === 404 && (await s3miss.json()).code === "apk_unavailable", `status=${s3miss.status}`);
  writeFileSync(lateApk, Buffer.from("PK-LATE-BUILD"));
  writeFileSync(join(lateDir, "omp-bot-android.json"), JSON.stringify({ versionName: "9.9.9-late" }));
  const s3after = await api2(server3, "/api/mobile");
  check("APK 晚到后无需重启即被发现并带版本", s3after.data.apk?.available === true && s3after.data.apk?.version === "9.9.9-late", JSON.stringify(s3after.data.apk));
  const s3dl = await fetch(server3.url + "/api/mobile/apk", { headers: { Authorization: `Bearer ${server3.token}` } });
  check("晚到 APK 立即按真实字节下载", s3dl.status === 200 && Buffer.from(await s3dl.arrayBuffer()).toString("utf8") === "PK-LATE-BUILD", `status=${s3dl.status}`);
} finally {
  await server3.close();
  rmSync(lateDir, { recursive: true, force: true });
}

async function api2(s, path, opts = {}) {
  const res = await fetch(s.url + path, {
    ...opts,
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

rmSync(home, { recursive: true, force: true });
rmSync(apkDir, { recursive: true, force: true });

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

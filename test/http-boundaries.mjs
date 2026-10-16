// test/http-boundaries.mjs — HTTP 边界的真实断言（零模型调用）。
// 覆盖：无凭证/错凭证、跨源 Origin、伪造 Host、text/plain mutation、超大请求体、
// 畸形路径、OPTIONS 不开 CORS、cookie bootstrap（顶层同源才下发、跨站不下发）、
// SSE 鉴权与 Last-Event-ID 重放去重、取消竞态、启动前 home 可写性。
// 这些断言直接对着真实 server 发请求，不 mock。

import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer, readServerDescriptor } from "../src/server.mjs";
import { redactSecrets } from "../src/http-auth.mjs";

let passed = 0;
let failed = 0;
function check(name, ok, ev = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ev ? "\n      " + ev : ""}`);
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const home = mkdtempSync(join(tmpdir(), "ompbot-http-boundary-"));
// bin 故意不存在：run 会在启动阶段显式失败，用来测取消竞态而不真跑模型。
const server = await startServer({ port: 0, host: "127.0.0.1", home, bin: join(home, "no-such-omp-binary") });
const { url, token, orch, close } = server;
const port = Number(new URL(url).port);
const hostHeader = `127.0.0.1:${port}`;

/** 原始 HTTP（可控制 Host 头与未规范化路径）。连接层错误返回 status 0，不抛出，保证后续断言仍可运行。 */
function raw(path, { method = "GET", headers = {}, body = null, host = hostHeader } = {}) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: host, ...headers } }, (res) => {
      res.on("error", () => {});
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, text: "", error: e?.code ?? e?.message ?? "socket error" }));
    if (body !== null) req.write(body);
    req.end();
  });
}

const authHeaders = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const jsonHeaders = (extra = {}) => ({ ...authHeaders(), ...extra });

async function api(path, opts = {}) {
  const res = await fetch(url + path, {
    ...opts,
    headers: { ...jsonHeaders(), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => ({})) };
}

/** 打开 SSE 并收集到匹配文本或超时；返回累计文本。 */
async function sseProbe(headers, predicate, budgetMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "GET", path: "/api/events", headers: { Host: hostHeader, ...headers } },
      (res) => {
        res.on("error", () => {});
        let text = "";
        if (res.statusCode !== 200) {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode, text }));
          return;
        }
        const timer = setTimeout(() => {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, text });
        }, budgetMs);
        res.on("data", (c) => {
          text += c.toString("utf8");
          if (predicate(text)) {
            clearTimeout(timer);
            req.destroy();
            resolve({ status: res.statusCode, headers: res.headers, text });
          }
        });
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      },
    );
    req.on("error", (e) => (e.code === "ECONNRESET" ? resolve({ status: 0, text: "" }) : reject(e)));
    req.end();
  });
}

/** 保持一个 SSE 连接打开，用于断言「撤销后服务端主动关闭」。 */
function sseOpen(headers) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "GET", path: "/api/events", headers: { Host: hostHeader, ...headers } },
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
    req.on("error", () => {});
    req.end();
  });
}

try {
  // ---- owner 发现文件：CLI/桌面据此把控制命令发给这个活着的进程 ----
  const desc = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8"));
  const liveLock = JSON.parse(readFileSync(join(home, "state.lock"), "utf8"));
  check(
    "runtime.json 绑定 pid/url/token + 真实锁 nonce，token 不进 url",
    desc.pid === process.pid &&
      desc.url === url &&
      typeof desc.token === "string" &&
      !desc.url.includes(desc.token) &&
      desc.lockPid === process.pid &&
      typeof desc.lockNonce === "string" &&
      desc.lockNonce.length > 0 &&
      desc.lockNonce === liveLock.nonce &&
      desc.lockNonce === orch.store.lockNonce,
    JSON.stringify({ ...desc, token: "[hidden]" }),
  );
  const discovered = await readServerDescriptor(home);
  check(
    "readServerDescriptor 只在 pid 存活且 nonce 与写锁一致时返回",
    discovered?.token === token && discovered?.url === url && discovered?.lockNonce === liveLock.nonce,
  );
  check("readServerDescriptor 对无描述的 home 返回 null", (await readServerDescriptor(join(home, "not-here"))) === null);
  const fakeHome = mkdtempSync(join(tmpdir(), "ompbot-desc-"));
  try {
    writeFileSync(join(fakeHome, "state.lock"), JSON.stringify({ pid: process.pid, nonce: "nonce-live", startedAt: 111 }));
    writeFileSync(join(fakeHome, "runtime.json"), JSON.stringify({ v: 1, pid: process.pid, url, token, lockNonce: "nonce-stale", lockStartedAt: 222 }));
    check("pid 相同但锁 nonce 不同被拒（同进程两个 Store 实例不能互认）", (await readServerDescriptor(fakeHome)) === null);
    writeFileSync(join(fakeHome, "runtime.json"), JSON.stringify({ v: 1, pid: process.pid, url, token, lockNonce: "nonce-live", lockStartedAt: 999 }));
    check("nonce 一致即接受（lockStartedAt 只是元数据，不参与身份判断）", (await readServerDescriptor(fakeHome))?.token === token);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }

  // ---- 无凭证 / 错凭证 ----
  check("GET /api/state 无凭证 401", (await raw("/api/state")).status === 401);
  check("GET /api/events/history 无凭证 401", (await raw("/api/events/history")).status === 401);
  check("GET /api/events 无凭证 401（SSE 不接受 query token）", (await raw("/api/events?token=" + token)).status === 401);
  check("POST /api/bots 无凭证 401", (await raw("/api/bots", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status === 401);
  check("错误 Bearer 401", (await raw("/api/state", { headers: { Authorization: "Bearer deadbeef" } })).status === 401);
  check("正确 Bearer 200", (await raw("/api/state", { headers: { Authorization: `Bearer ${token}` } })).status === 200);

  // ---- 跨源 / 伪造 Host ----
  const foreignOrigin = await raw("/api/state", {
    headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.test" },
  });
  check("跨源 Origin 403", foreignOrigin.status === 403, `status=${foreignOrigin.status}`);
  const foreignHost = await raw("/api/state", { headers: { Authorization: `Bearer ${token}` }, host: `evil.test:${port}` });
  check("伪造 Host 403（DNS rebinding）", foreignHost.status === 403, `status=${foreignHost.status}`);
  const sameOrigin = await raw("/api/state", { headers: { Authorization: `Bearer ${token}`, Origin: url } });
  check("同源 Origin 200", sameOrigin.status === 200);
  const nullOrigin = await raw("/api/state", { headers: { Authorization: `Bearer ${token}`, Origin: "null" } });
  check("Origin: null 403", nullOrigin.status === 403);

  // ---- mutation 只接受 JSON ----
  const plain = await raw("/api/bots", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: JSON.stringify({ name: "PlainProbe" }),
  });
  check("text/plain mutation 415", plain.status === 415, `status=${plain.status}`);
  const badJson = await raw("/api/bots", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{not json",
  });
  check("非法 JSON 400", badJson.status === 400);

  // ---- 超大请求体：必须回结构化 413，且不能让连接池里的下一条请求被 reset ----
  const huge = await raw("/api/bots", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": "40000000" },
  });
  check("超大体量 413", huge.status === 413 && JSON.parse(huge.text || "{}").code === "body_too_large", `status=${huge.status} err=${huge.error ?? ""}`);
  check("早拒的响应声明 Connection: close（不把半读连接留在 keep-alive 池）", (huge.headers.connection ?? "") === "close", String(huge.headers.connection));
  const afterHuge = await raw("/api/state", { headers: { Authorization: `Bearer ${token}` } });
  check("早拒之后同一客户端仍能正常请求（无 ECONNRESET）", afterHuge.status === 200, `status=${afterHuge.status} err=${afterHuge.error ?? ""}`);

  // ---- 畸形路径 ----
  for (const p of ["/api/../state", "/api/%2e%2e/state", "/api/runs/%2e%2e", "/api/sta%00te", "/api\\state", "/api/runs/a%2fb", "/../package.json"]) {
    const res = await raw(p, { headers: { Authorization: `Bearer ${token}` } });
    check(`畸形路径 ${p} 被拒 400`, res.status === 400, `status=${res.status} err=${res.error ?? ""}`);
  }
  check("正常静态路径仍可用", (await raw("/index.html")).status === 200);
  check("未知静态文件 404", (await raw("/nope.js")).status === 404);
  check("未知 API 404", (await raw("/api/nope", { headers: { Authorization: `Bearer ${token}` } })).status === 404);

  // ---- OPTIONS 不开 CORS ----
  const opt = await raw("/api/state", { method: "OPTIONS", headers: { Origin: url, "Access-Control-Request-Method": "POST" } });
  check(
    "OPTIONS 405 且不返回 CORS 放行头",
    opt.status === 405 && !opt.headers["access-control-allow-origin"] && !opt.headers["access-control-allow-credentials"],
    `status=${opt.status} acao=${opt.headers["access-control-allow-origin"]}`,
  );

  // ---- cookie bootstrap ----
  const navigate = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
  const doc = await raw("/", { headers: navigate });
  const setCookie = doc.headers["set-cookie"]?.join("; ") ?? "";
  check("顶层同源导航下发 HttpOnly SameSite=Strict cookie", doc.status === 200 && /omp_session=[0-9a-f]{32,}/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), setCookie.replace(/omp_session=[0-9a-f]+/, "omp_session=[redacted]"));
  const sid = /omp_session=([0-9a-f]+)/.exec(setCookie)?.[1];
  check("session cookie 认证 GET /api/state 200", (await raw("/api/state", { headers: { Cookie: `omp_session=${sid}` } })).status === 200);
  check(
    "cookie + 跨源 Origin 403",
    (await raw("/api/state", { headers: { Cookie: `omp_session=${sid}`, Origin: "http://evil.test" } })).status === 403,
  );
  const crossSite = await raw("/", { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
  check("跨站顶层导航不下发 cookie", crossSite.status === 200 && !crossSite.headers["set-cookie"], String(crossSite.headers["set-cookie"]));
  const subresource = await raw("/", { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } });
  check("同源子资源请求不下发 cookie", !subresource.headers["set-cookie"]);

  const bootstrap = await raw("/api/session/bootstrap", { method: "POST", headers: jsonHeaders(), body: "{}" });
  check("POST /api/session/bootstrap 用 Bearer 换 cookie", bootstrap.status === 200 && /omp_session=/.test(bootstrap.headers["set-cookie"]?.join("; ") ?? ""));
  const bootstrapNoAuth = await raw("/api/session/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("无凭证 bootstrap 401", bootstrapNoAuth.status === 401);

  // ---- SSE：重放 + 去重 ----
  const e1 = orch.emit("boundary_probe", { n: 1 });
  const e2 = orch.emit("boundary_probe", { n: 2 });
  check("emit 返回带全局 seq 的信封", Number.isInteger(e1?.seq) && e2?.seq === e1.seq + 1, `${e1?.seq} → ${e2?.seq}`);
  const replay = await sseProbe(
    { Authorization: `Bearer ${token}`, "Last-Event-ID": String(e1.seq) },
    (t) => t.includes('"n":2'),
  );
  check(
    "Last-Event-ID 重放：收到新事件、不重发旧事件",
    replay.status === 200 && replay.text.includes('"n":2') && !replay.text.includes('"n":1'),
    replay.text.replace(/\n/g, " ").slice(0, 160),
  );
  check("SSE 使用 cookie 也能鉴权", (await sseProbe({ Cookie: `omp_session=${sid}` }, (t) => t.includes("boundary_probe"))).status === 200);
  const hist = await api("/api/events/history?since=0&limit=50");
  check(
    "events/history 与 seq 空间对齐",
    hist.status === 200 && Number.isInteger(hist.data.lastSeq) && hist.data.events.at(-1)?.seq === hist.data.lastSeq,
    `lastSeq=${hist.data.lastSeq}`,
  );

  // ---- 取消竞态：终态 run 不能被再次宣称停止 ----
  const bot = (await api("/api/bots", { method: "POST", body: { name: "RaceProbe" } })).data.bot;
  const started = await api("/api/runs", { method: "POST", body: { botId: bot.id, text: "boundary race" } });
  const runId = started.data.run?.id;
  check("POST /api/runs 202 返回 run", started.status === 202 && !!runId, `status=${started.status} body=${JSON.stringify(started.data).slice(0, 120)}`);
  let state = started.data.run?.state;
  for (let waited = 0; !TERMINAL.has(state) && waited < 20_000; waited += 250) {
    await sleep(250);
    state = (await api(`/api/runs/${runId}`)).data.run?.state;
  }
  check("启动失败的 run 落到显式终态（不是假 idle）", TERMINAL.has(state), `state=${state}`);
  const [c1, c2] = await Promise.all([
    api(`/api/runs/${runId}/cancel`, { method: "POST", body: {} }),
    api(`/api/runs/${runId}/cancel`, { method: "POST", body: {} }),
  ]);
  check(
    "终态 run 的并发取消被拒且不 500",
    [c1, c2].every((r) => r.status !== 500) && [c1, c2].some((r) => r.status === 409 || r.data.accepted === false),
    `${c1.status}/${c2.status} ${JSON.stringify(c1.data).slice(0, 80)}`,
  );
  check("取消竞态后服务仍可用", (await api("/api/state")).status === 200);
  check("取消未知 run 404", (await api("/api/runs/nope/cancel", { method: "POST", body: {} })).status === 404);

  // ---- 设备配对：admin 路由只认 owner；redeem 是唯一未认证入口，仍过 Host/Origin/CT + 限流 ----
  const codesNoAuth = await raw("/api/pairing/codes", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("配对签发无凭证 401", codesNoAuth.status === 401);
  const issued = await api("/api/pairing/codes", { method: "POST", body: { botIds: [bot.id], label: "boundary" } });
  check("配对签发 201 且只回一次性码", issued.status === 201 && typeof issued.data.code === "string" && !/Hash|salt/.test(JSON.stringify(issued.data.ticket ?? {})), `status=${issued.status}`);
  const redeemCrossOrigin = await raw("/api/pairing/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
    body: JSON.stringify({ code: issued.data.code }),
  });
  check("redeem 跨源 Origin 403", redeemCrossOrigin.status === 403);
  const redeemPlain = await raw("/api/pairing/redeem", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ code: issued.data.code }),
  });
  check("redeem text/plain 415", redeemPlain.status === 415);
  const redeemed = await raw("/api/pairing/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: issued.data.code, client: "boundary-device", name: "probe" }),
  });
  const device = JSON.parse(redeemed.text || "{}");
  check("redeem 换取设备凭证", redeemed.status === 200 && typeof device.token === "string" && device.device?.botIds?.includes(bot.id), `status=${redeemed.status}`);
  const reuseCode = await raw("/api/pairing/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: issued.data.code, client: "boundary-device-2" }),
  });
  check("配对码一次性（重复兑换 410）", reuseCode.status === 410, `status=${reuseCode.status}`);
  const deviceAuth = { Authorization: `Bearer ${device.token}` };
  const deviceState = await raw("/api/state", { headers: deviceAuth });
  check("设备可读自己的状态", deviceState.status === 200 && JSON.parse(deviceState.text).bots.every((b) => b.id === bot.id));
  const deviceAdmin = await raw("/api/pairing", { headers: deviceAuth });
  check("设备访问 admin 路由 403 DEVICE_NO_ADMIN", deviceAdmin.status === 403 && /DEVICE_NO_ADMIN/.test(deviceAdmin.text), `status=${deviceAdmin.status}`);
  const deviceRoster = await raw("/api/bots", { method: "POST", headers: { ...deviceAuth, "Content-Type": "application/json" }, body: JSON.stringify({ name: "DeviceMade" }) });
  check("设备不能改花名册 403", deviceRoster.status === 403);
  // 审批夹具：设备的 approve 权限与飞书来源代答都必须被拦住（不依赖真模型）
  const fsRun = await api("/api/runs", {
    method: "POST",
    body: { botId: bot.id, text: "feishu origin", source: "feishu:ou_boundary:oc_boundary" },
  });
  orch.ledger.put("approvals", {
    id: "appr_boundary_fs",
    runId: fsRun.data.run.id,
    botId: bot.id,
    scope: "private",
    nativeId: "native_boundary",
    method: "select",
    title: "Approve?",
    message: "boundary",
    options: ["Approve", "Deny"],
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const deviceApprove = await raw("/api/approvals/appr_boundary_fs/respond", {
    method: "POST",
    headers: { ...deviceAuth, "Content-Type": "application/json" },
    body: JSON.stringify({ value: "Approve" }),
  });
  check("设备默认无 approve 权限 403 DEVICE_FORBIDDEN", deviceApprove.status === 403 && /DEVICE_FORBIDDEN/.test(deviceApprove.text), `status=${deviceApprove.status}`);
  const approveCode = await api("/api/pairing/codes", { method: "POST", body: { botIds: [bot.id], permissions: ["read", "run", "approve"], label: "boundary-approver" } });
  const approver = JSON.parse(
    (
      await raw("/api/pairing/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: approveCode.data.code }),
      })
    ).text || "{}",
  );
  check("显式授权 approve 的设备凭证可兑换", typeof approver.token === "string" && approver.device?.permissions?.includes("approve"));
  const approverRespond = await raw("/api/approvals/appr_boundary_fs/respond", {
    method: "POST",
    headers: { Authorization: `Bearer ${approver.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: "Approve" }),
  });
  check(
    "有 approve 权限的设备也不能代答飞书来源审批 403 CHANNEL_IDENTITY_REQUIRED",
    approverRespond.status === 403 && /CHANNEL_IDENTITY_REQUIRED/.test(approverRespond.text),
    `status=${approverRespond.status}`,
  );
  const ownerRespond = await api("/api/approvals/appr_boundary_fs/respond", { method: "POST", body: { value: "Approve" } });
  check("owner 回答非活跃审批是显式错误（不假成功）", [400, 409].includes(ownerRespond.status), `status=${ownerRespond.status}`);

  const otherBot = (await api("/api/bots", { method: "POST", body: { name: "OutOfScope" } })).data.bot;
  const mixedRoom = await api("/api/rooms", { method: "POST", body: { name: "MixedRoom", members: [bot.id, otherBot.id], adminId: otherBot.id } });
  check("混合成员群建立（设备投影断言用）", mixedRoom.status === 200, `status=${mixedRoom.status}`);
  const deviceRunOutOfScope = await raw("/api/runs", {
    method: "POST",
    headers: { ...deviceAuth, "Content-Type": "application/json" },
    body: JSON.stringify({ botId: otherBot.id, text: "越界" }),
  });
  check("设备向未授权 bot 派活 403 DEVICE_OUT_OF_SCOPE", deviceRunOutOfScope.status === 403 && /DEVICE_OUT_OF_SCOPE/.test(deviceRunOutOfScope.text), `status=${deviceRunOutOfScope.status}`);

  const ownerDelegations = await api("/api/delegations");
  check("主人能读派活记录", ownerDelegations.status === 200 && Array.isArray(ownerDelegations.data?.delegations), `status=${ownerDelegations.status}`);
  const deviceDelegations = await raw("/api/delegations", { headers: deviceAuth });
  check("设备读派活记录被拒（可能含别的 bot 的交回内容）", deviceDelegations.status === 403, `status=${deviceDelegations.status}`);

  const ownerFacts = await api("/api/team/facts");
  check("主人能读团队事实和提议", ownerFacts.status === 200 && Array.isArray(ownerFacts.data?.facts) && Array.isArray(ownerFacts.data?.proposals), `status=${ownerFacts.status}`);
  const deviceFacts = await raw("/api/team/facts", { headers: deviceAuth });
  check("设备读团队事实提议被拒（来源可能是私聊）", deviceFacts.status === 403, `status=${deviceFacts.status}`);
  const deviceAddFact = await raw("/api/team/facts", {
    method: "POST",
    headers: { ...deviceAuth, "Content-Type": "application/json" },
    body: JSON.stringify({ fact: "设备写进来的", source: "手机" }),
  });
  check("设备不能直接写团队事实", deviceAddFact.status === 403, `status=${deviceAddFact.status}`);
  const added = await api("/api/team/facts", { method: "POST", body: { fact: "边界测试的事实", source: "测试" } });
  check("主人能直接加一条团队事实", added.status === 201 && added.data?.proposal?.state === "accepted", `status=${added.status}`);
  const addedAgain = await api("/api/team/facts", { method: "POST", body: { fact: "边界测试的事实", source: "测试" } });
  check("重复的事实 409 fact_exists", addedAgain.status === 409 && addedAgain.data?.code === "fact_exists", `status=${addedAgain.status}`);
  const deviceAccept = await raw("/api/team/proposals/tfp_x/accept", { method: "POST", headers: { ...deviceAuth, "Content-Type": "application/json" }, body: "{}" });
  check("设备不能接受团队事实提议", deviceAccept.status === 403, `status=${deviceAccept.status}`);
  const missingAccept = await api("/api/team/proposals/tfp_missing/accept", { method: "POST", body: {} });
  check("接受不存在的提议 404", missingAccept.status === 404, `status=${missingAccept.status}`);

  // 群建好之后重新取设备视角的状态（不能用建群之前的快照）
  const deviceStateAfter = JSON.parse((await raw("/api/state", { headers: deviceAuth })).text);
  const scopedRoom = deviceStateAfter.rooms?.find((r) => r.id === mixedRoom.data.room.id);
  const memberIds = (scopedRoom?.members ?? []).map((m) => (typeof m === "string" ? m : m?.id));
  check(
    "设备 /state 群投影只含自己 bot、无 log/未授权成员",
    !!scopedRoom &&
      memberIds.length === 1 &&
      memberIds[0] === bot.id &&
      scopedRoom.log === undefined &&
      scopedRoom.adminId === null &&
      !JSON.stringify(scopedRoom).includes(otherBot.id) &&
      deviceStateAfter.bots.every((b) => b.id === bot.id),
    JSON.stringify(scopedRoom),
  );

  // 设备 SSE：只收自己被授权 bot 的事件，撤销后被服务端立即关闭
  const stream = await sseOpen({ Authorization: `Bearer ${device.token}` });
  await sleep(150);
  orch.emit("device_probe", { botId: bot.id, n: 1 });
  await sleep(250);
  check("设备 SSE 收到被授权 bot 的事件", stream.text.includes('"n":1'));
  orch.emit("device_probe", { botId: otherBot.id, n: 2 });
  await sleep(250);
  check("设备 SSE 收不到未授权 bot 的事件", !stream.text.includes('"n":2'));
  const revokedDevice = await api(`/api/pairing/${device.device.id}`, { method: "DELETE" });
  await sleep(300);
  check("撤销后已建立的设备 SSE 被服务端关闭", revokedDevice.status === 200 && stream.ended, `ended=${stream.ended}`);
  check("撤销设备后凭证失效", (await raw("/api/state", { headers: deviceAuth })).status === 401);

  const rateLimited = [];
  for (let i = 0; i < 12; i++) {
    rateLimited.push(
      await raw("/api/pairing/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // body.client 不可信：轮换它也不能绕过按来源地址计的限流
        body: JSON.stringify({ code: "ompcode_nope-nope-nope-nope", client: `rotating-${i}` }),
      }),
    );
  }
  const statuses = rateLimited.map((r) => r.status);
  check("redeem 限流以来源地址为键（轮换 client 仍被拦）", statuses.includes(404) && statuses.at(-1) === 429 && statuses.filter((s) => s === 429).length >= 2, statuses.join(","));
  const limited = rateLimited.find((r) => r.status === 429);
  check("429 带 retryAfterMs 与 Retry-After", Number(JSON.parse(limited.text).retryAfterMs) > 0 && Number(limited.headers["retry-after"]) > 0);

  // ---- 放宽权限必须显式确认，sandbox 不伪装 ----
  const sandbox = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { executionMode: "sandbox" } });
  check("executionMode=sandbox 被拒 400（本机无已验证沙箱）", sandbox.status === 400, `status=${sandbox.status}`);
  const fullNoConfirm = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { permission: "full" } });
  check("permission=full 无确认 400", fullNoConfirm.status === 400 && fullNoConfirm.data?.code === "confirm_permission_required", JSON.stringify(fullNoConfirm.data));
  const yolo = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { approvalMode: "yolo" } });
  check("旧字段 approvalMode=yolo 无确认 400", yolo.status === 400);
  const badLevel = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { permission: "root" } });
  check("未知权限档 400", badLevel.status === 400 && badLevel.data?.code === "permission_invalid");
  const fullWrite = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { executionMode: "full", approvalMode: "write" } });
  check(
    "旧组合 full+write 经接口归到先问我",
    fullWrite.status === 200 && fullWrite.data.bot.executionMode === "supervised" && fullWrite.data.bot.approvalMode === "write",
  );
  const fullConfirmed = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { permission: "full", confirmPermission: true } });
  check(
    "显式确认后全部放手生效",
    fullConfirmed.status === 200 && fullConfirmed.data.bot.executionMode === "full" && fullConfirmed.data.bot.approvalMode === "yolo",
  );
  const backToChat = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { permission: "chat" } });
  check("permission=chat 生效", backToChat.status === 200 && backToChat.data.bot.executionMode === "chat");

  // ---- 头像：接口直接校验，Main Bot 固定，主助手颜色专用，图片只能是附件 ----
  const lead = (await api("/api/bots", { method: "POST", body: { name: "AvatarMain", isMain: true } })).data.bot;
  check("Main Bot 默认 star 加专用蓝", lead?.avatar?.body === "star" && lead.avatar.color === "#4D6BFE", JSON.stringify(lead?.avatar));
  const mainLocked = await api(`/api/bots/${lead.id}`, { method: "PATCH", body: { avatar: { body: "blob" } } });
  check("改 Main Bot 形象 400", mainLocked.status === 400 && mainLocked.data?.code === "avatar_main_fixed", JSON.stringify(mainLocked.data));
  const reserved = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { avatar: { color: "#4D6BFE" } } });
  check("别的 bot 用主助手颜色 400", reserved.status === 400 && reserved.data?.code === "avatar_color_reserved", JSON.stringify(reserved.data));
  const outside = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { avatar: { url: "https://example.com/x.png", crop: "circle" } } });
  check("外部图片地址 400", outside.status === 400 && outside.data?.code === "avatar_url_invalid", JSON.stringify(outside.data));
  const restyled = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: { avatar: { body: "shield", color: "coral" } } });
  const listed = (await api("/api/bots")).data.bots?.find((b) => b.id === bot.id);
  check("合法头像改动保存并出现在花名册", restyled.status === 200 && listed?.avatar?.body === "shield" && listed.avatar.color === "coral", JSON.stringify(listed?.avatar));

  // ---- 原生导出/会话入口：未知 bot 不触发原生调用 ----
  check("session/export 未知 bot 404", (await api("/api/bots/nope/session/export")).status === 404);
  check("session/new 未知 bot 404", (await api("/api/bots/nope/session/new", { method: "POST", body: {} })).status === 404);
  check("native/command 未知 bot 404", (await api("/api/bots/nope/native/command", { method: "POST", body: { command: "login" } })).status === 404);
  const notAllowed = await api(`/api/bots/${bot.id}/native/command`, { method: "POST", body: { command: "bash" } });
  check("白名单外命令 403", notAllowed.status === 403);
  const inject = await api(`/api/bots/${bot.id}/native/command`, { method: "POST", body: { command: "login --secret-file C:/x" } });
  check("带路径/参数的命令名 400", inject.status === 400);

  // ---- 凭据剔除是纯函数，可单测 ----
  const redacted = redactSecrets({
    apiKey: "sk-live",
    secretKey: "p",
    clientSecret: "c",
    appSecret: "s",
    refreshToken: "r",
    verificationToken: "v",
    encryptKey: "k",
    credentialId: "id",
    nested: { credentialSource: "x", name: "ok" },
    tokenBudget: 5,
    totalTokens: 9,
    inputTokens: 7,
  });
  check(
    "redactSecrets 覆盖复合凭据名（大小写不敏感，含嵌套）",
    ["apiKey", "secretKey", "clientSecret", "appSecret", "refreshToken", "verificationToken", "encryptKey", "credentialId"].every((k) => redacted[k] === "[redacted]") &&
      redacted.nested.credentialSource === "[redacted]" &&
      redacted.nested.name === "ok",
    JSON.stringify(redacted),
  );
  check(
    "redactSecrets 不误伤 tokenBudget/totalTokens/inputTokens 等度量",
    redacted.tokenBudget === 5 && redacted.totalTokens === 9 && redacted.inputTokens === 7,
    JSON.stringify(redacted),
  );
} finally {
  await close();
  check("close() 删除自己写的 runtime.json", !existsSync(join(home, "runtime.json")));
  check("close() 后 readServerDescriptor 不再返回描述", (await readServerDescriptor(home)) === null);
}

// ---- home 不可写必须启动失败，而不是假装可写 ----
const notADir = join(tmpdir(), `ompbot-not-a-dir-${process.pid}`);
writeFileSync(notADir, "x");
try {
  let rejected = null;
  try {
    await startServer({ port: 0, host: "127.0.0.1", home: notADir });
  } catch (e) {
    rejected = e;
  }
  check("home 不可写时 startServer 拒绝启动", !!rejected, rejected?.message ?? "startServer 竟然成功了");
} finally {
  rmSync(notADir, { force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

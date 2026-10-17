// smoke-gui.mjs — HTTP API 层 smoke test。零模型调用，快且确定。
// 起真实 server（随机端口 + 临时 home），用 startServer 返回的 token 走 GUI/Desktop
// 依赖的端点与 SSE 事件流。HTTP 边界（Host/Origin/Content-Type/路径/体量）在 test/http-boundaries.mjs。

import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./src/server.mjs";

let passed = 0;
let failed = 0;
function check(name, ok, ev = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ev ? "\n      " + ev : ""}`);
}

const home = mkdtempSync(join(tmpdir(), "ompbot-gui-smoke-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home });
check("startServer 返回进程 token 与不含 token 的 url", typeof token === "string" && token.length >= 32 && !url.includes(token), url);

const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

const port = Number(new URL(url).port);

/** 原始 HTTP：Node fetch 会强制 Sec-Fetch-Mode: cors，没法模拟浏览器顶层导航。 */
function rawRequest(path, headers = {}) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.on("error", () => {});
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, text: "", error: e?.code ?? e?.message }));
    req.end();
  });
}

/** 真实浏览器顶层导航的请求头组合（地址栏打开 / 桌面 loadURL）。 */
const topNavigation = (path, headers = {}) =>
  rawRequest(path, { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", ...headers });

async function api(path, opts = {}) {
  const res = await fetch(path.startsWith("http") ? path : url + path, {
    headers: { ...auth(), ...(opts.headers ?? {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  // 静态
  const idx = await fetch(url + "/");
  check("GET / 返回 HTML", idx.status === 200 && idx.headers.get("content-type")?.startsWith("text/html"));
  check("GET / 无缓存 + CSP", idx.headers.get("cache-control") === "no-store" && /default-src 'none'/.test(idx.headers.get("content-security-policy") ?? ""));
  const nav = await topNavigation("/");
  const navCookie = nav.headers["set-cookie"]?.join("; ") ?? "";
  check(
    "顶层同源导航下发 HttpOnly SameSite=Strict 会话 cookie",
    nav.status === 200 && /omp_session=[0-9a-f]{32,}/.test(navCookie) && /HttpOnly/.test(navCookie) && /SameSite=Strict/.test(navCookie),
    navCookie.replace(/omp_session=[0-9a-f]+/, "omp_session=[redacted]"),
  );
  const sid = /omp_session=([0-9a-f]+)/.exec(navCookie)?.[1];
  check("会话 cookie 可认证 API", (await rawRequest("/api/state", { Cookie: `omp_session=${sid}` })).status === 200);
  check("同源子资源请求不下发 cookie", !(await rawRequest("/style.css", { "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "style" })).headers["set-cookie"]);
  for (const [path, contentType] of [
    ["/style.css", "text/css"],
    ["/app.js", "text/javascript"],
    ["/vendor/ds-bot/ui.css", "text/css"],
    ["/vendor/ds-bot/inks.js", "text/javascript"],
    ["/vendor/notion-avatar/parts.js", "text/javascript"],
    ["/workbench-avatar.js", "text/javascript"],
    ["/vendor/marked/marked.esm.js", "text/javascript"],
    ["/vendor/dompurify/purify.es.js", "text/javascript"],
  ]) {
    const resource = await fetch(url + path);
    check(`GET ${path} 可供浏览器加载`, resource.status === 200 && resource.headers.get("content-type")?.startsWith(contentType));
  }
  const missing = await fetch(url + "/not-a-file.js");
  check("静态缺失 404", missing.status === 404);

  // 鉴权开关
  const noAuth = await fetch(url + "/api/state");
  check("无凭证 401", noAuth.status === 401);
  const withAuth = await api("/api/state");
  check("Bearer token 可用", withAuth.status === 200);

  // models
  const models = await api("/api/models");
  check("GET /api/models 返回模型目录", models.status === 200 && Array.isArray(models.data.models), models.data.error ?? `n=${models.data.models?.length}`);

  // bot CRUD
  const created = await api("/api/bots", { method: "POST", body: { name: "Calc", role: "计算", instructions: "x" } });
  check("POST /api/bots 创建", created.status === 200 && !!created.data.bot?.id);
  const dup = await api("/api/bots", { method: "POST", body: { name: "Calc" } });
  check("重名 409", dup.status === 409);
  const noname = await api("/api/bots", { method: "POST", body: {} });
  check("缺名字 400", noname.status === 400);
  const botId = created.data.bot.id;

  const patched = await api(`/api/bots/${botId}`, { method: "PATCH", body: { role: "数字官" } });
  check("PATCH 更新 bot", patched.status === 200 && patched.data.bot.role === "数字官");
  const patched404 = await api("/api/bots/nope", { method: "PATCH", body: { role: "x" } });
  check("PATCH 未知 bot 404", patched404.status === 404);

  const state1 = await api("/api/state");
  check(
    "GET /api/state 含 bots/rooms/activeRuns/pendingApprovals/lastSeq",
    state1.data.bots?.length === 1 &&
      Array.isArray(state1.data.rooms) &&
      Array.isArray(state1.data.activeRuns) &&
      Array.isArray(state1.data.pendingApprovals) &&
      Number.isInteger(state1.data.lastSeq),
  );

  // 聊天日志
  const chat0 = await api(`/api/chat/${botId}`);
  check("GET /api/chat 空历史", chat0.status === 200 && Array.isArray(chat0.data.messages) && chat0.data.messages.length === 0);
  const chatDel = await api(`/api/chat/${botId}`, { method: "DELETE" });
  check("DELETE /api/chat 清空", chatDel.status === 200);
  const chat404 = await api("/api/chat/nope");
  check("未知 bot 404", chat404.status === 404);

  // room
  const bot2 = await api("/api/bots", { method: "POST", body: { name: "Chief" } });
  const room = await api("/api/rooms", {
    method: "POST",
    body: { name: "工作组", members: [bot2.data.bot.id, botId], adminId: bot2.data.bot.id, mode: "admin" },
  });
  check("POST /api/rooms 建群", room.status === 200 && room.data.room.members.length === 2);
  const badRoom = await api("/api/rooms", { method: "POST", body: { name: "x", members: ["nope"] } });
  check("群成员不存在 400", badRoom.status === 400);
  const roomPatched = await api(`/api/rooms/${room.data.room.id}`, { method: "PATCH", body: { mode: "everyone" } });
  check("PATCH room 模式", roomPatched.status === 200 && roomPatched.data.room.mode === "everyone");
  const sayNoText = await api(`/api/rooms/${room.data.room.id}/say`, { method: "POST", body: {} });
  check("say 缺 text 400", sayNoText.status === 400);

  // run 契约（不真跑模型：只验证 admission 与查询形状）
  const runs0 = await api("/api/runs");
  check("GET /api/runs 初始为空数组", runs0.status === 200 && Array.isArray(runs0.data.runs));
  const runNoText = await api("/api/runs", { method: "POST", body: { botId } });
  check("POST /api/runs 缺 text 400", runNoText.status === 400);
  const runNoTarget = await api("/api/runs", { method: "POST", body: { text: "hi" } });
  check("POST /api/runs 缺目标 400", runNoTarget.status === 400);
  const run404 = await api("/api/runs/nope");
  check("GET /api/runs/:id 未知 404", run404.status === 404);
  const cancel404 = await api("/api/runs/nope/cancel", { method: "POST", body: {} });
  check("POST /api/runs/:id/cancel 未知 404", cancel404.status === 404);

  // approvals / usage
  const approvals = await api("/api/approvals");
  check("GET /api/approvals", approvals.status === 200 && Array.isArray(approvals.data.approvals));
  const usage = await api("/api/usage");
  check("GET /api/usage 含持久 totals", usage.status === 200 && Array.isArray(usage.data.perRun) && !!usage.data.totals);

  // 原生命令白名单：不是任意 bash/eval 入口
  const bash = await api(`/api/bots/${botId}/native/command`, { method: "POST", body: { command: "bash" } });
  check("原生命令 bash 被拒 403", bash.status === 403);
  const injected = await api(`/api/bots/${botId}/native/command`, { method: "POST", body: { command: "new_session; rm -rf /" } });
  check("原生命令注入被拒 400", injected.status === 400);

  // 设备配对（owner 侧 CRUD）；redeem 的未认证/限流边界在 test/http-boundaries.mjs
  const code = await api("/api/pairing/codes", { method: "POST", body: { botIds: [botId], label: "smoke" } });
  check("POST /api/pairing/codes 201 返回一次性码", code.status === 201 && typeof code.data.code === "string" && code.data.ticket?.botIds?.includes(botId));
  check("配对 ticket 不回散列或密钥", !/codeHash|tokenHash|salt/.test(JSON.stringify(code.data.ticket ?? {})));
  const pairingList = await api("/api/pairing");
  check("GET /api/pairing 列出 ticket", pairingList.status === 200 && pairingList.data.tickets?.some((t) => t.id === code.data.ticket.id));
  const revoked = await api(`/api/pairing/${code.data.ticket.id}`, { method: "DELETE" });
  check("DELETE /api/pairing/:id 撤销", revoked.status === 200 && !!revoked.data.revokedAt);
  const redeemBadCode = await fetch(url + "/api/pairing/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "ompcode_definitely-unknown", client: "smoke" }),
  });
  check("redeem 无需 owner 凭证，但无效码仍 404", redeemBadCode.status === 404);

  // 事件历史 + SSE 实时事件（真实走 ledger/emit，同一 seq 空间）
  const histNoAuth = await fetch(url + "/api/events/history?since=0");
  check("events/history 无凭证 401", histNoAuth.status === 401);
  const hist = await api("/api/events/history?since=0");
  check("GET /api/events/history 形状", hist.status === 200 && Array.isArray(hist.data.events) && Number.isInteger(hist.data.lastSeq));

  const sseRes = await fetch(url + "/api/events", { headers: { Authorization: `Bearer ${token}` } });
  check("SSE 可鉴权连接", sseRes.status === 200 && sseRes.headers.get("content-type")?.startsWith("text/event-stream"));
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  async function readFrameWhere(predicate, budgetMs = 6000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const idx = buf.indexOf("\n\n");
      if (idx >= 0) {
        const frameText = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (frameText && (!predicate || predicate(frameText))) return frameText;
        continue;
      }
      const chunk = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now()))),
      ]);
      if (chunk.timeout || chunk.done) return null;
      buf += decoder.decode(chunk.value, { stream: true });
    }
    return null;
  }
  const hello = await readFrameWhere((f) => f.includes('"hello"'));
  check("SSE 首帧 hello 带 lastSeq", !!hello && /"lastSeq":\d+/.test(hello), hello ?? "no frame");
  const emitted = orch.emit("smoke_probe", { n: 7 });
  const probe = await readFrameWhere((f) => f.includes("smoke_probe"));
  check("SSE 收到真实事件并带全局 seq", !!probe && /"seq":\d+/.test(probe) && probe.includes('"n":7'), probe ?? "no frame");
  const probeSeq = Number(/id: (\d+)/.exec(probe ?? "")?.[1]);
  const histAfter = await api("/api/events/history?since=0");
  check(
    "事件历史与 SSE id 同一 seq 空间",
    Number.isInteger(probeSeq) && probeSeq === histAfter.data.lastSeq && histAfter.data.events.at(-1)?.seq === probeSeq,
    `probeSeq=${probeSeq} lastSeq=${histAfter.data.lastSeq} emittedSeq=${emitted?.seq}`,
  );
  reader.cancel().catch(() => {});

  // 导出 HTML 隔离：真跑原生导出。拿到 HTML 必须是下载附件 + 无脚本执行能力；
  // 原生不支持时给出显式错误，绝不 200 回一个可执行页面。
  const exported = await fetch(`${url}/api/bots/${botId}/session/export?scope=private`, { headers: auth() });
  if (exported.status === 200) {
    const csp = exported.headers.get("content-security-policy") ?? "";
    check(
      "会话导出为附件下载且 CSP 隔离",
      /attachment/.test(exported.headers.get("content-disposition") ?? "") &&
        csp.includes("default-src 'none'") &&
        (exported.headers.get("content-type") ?? "").startsWith("text/html"),
      `csp=${csp.slice(0, 60)}`,
    );
  } else {
    check("原生导出不可用时是显式错误而非假成功", [409, 500, 501].includes(exported.status), `status=${exported.status}`);
  }

  // 删除
  const delBot = await api(`/api/bots/${botId}`, { method: "DELETE" });
  check("DELETE bot", delBot.status === 200);
  const delRoom = await api(`/api/rooms/${room.data.room.id}`, { method: "DELETE" });
  check("DELETE room", delRoom.status === 200);
  const state2 = await api("/api/state");
  check("删除后 state 一致", state2.data.bots.length === 1 && state2.data.rooms.length === 0);

  const unknown = await api("/api/nope");
  check("未知 API 404", unknown.status === 404);
} finally {
  await close();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed}/${passed + failed} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed ? 1 : 0);

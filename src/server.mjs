// server.mjs — 常驻 HTTP 服务：GUI / Desktop 的后端。
// 零依赖（node:http），127.0.0.1 本地监听：静态文件 + JSON API + SSE 事件流。
// 手机伴侣入口（设备专用、默认关闭）在 mobile.mjs，由本文件装配：owner 经 /api/mobile 启停。
//
// 边界（全部前置，业务之前）：Host/Origin 严格同源回环、进程 token 或 HttpOnly 会话 cookie、
// mutation 仅 JSON、路径严格分段解码、请求体上限，OPTIONS 不开 CORS。
// 执行全部交给 Orchestrator（OMP 原生进程 + Ledger），本文件不实现第二套运行引擎。

import { createServer } from "node:http";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, normalize, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "./orchestrator.mjs";
import { defaultHome } from "./store.mjs";
import { NATIVE_COMMAND_ALLOWLIST } from "./constants.mjs";
import { ACTIVE_STATES } from "./ledger.mjs";
import { PairingService } from "./pairing.mjs";
import { collectUsage } from "./usage.mjs";
import {
  MobileGateway,
  resolveMobileApk,
  deviceSafeBot,
  deviceSafeRun,
  deviceSafeArtifact,
  deviceSafeEvent,
} from "./mobile.mjs";
import {
  newSecret,
  secretEqual,
  hostOk,
  originOk,
  bootstrapContextOk,
  isJsonContentType,
  readCookie,
  sessionCookie,
  decodeSegments,
  redactSecrets,
} from "./http-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-src 'self'; child-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

const SESSION_COOKIE = "omp_session";
const MAX_BODY = 32 * 1024 * 1024;
const MAX_SSE_CLIENTS = 32;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_HIGH_WATER = 4 * 1024 * 1024;
const REPLAY_LIMIT = 2000;
const MODELS_TTL_MS = 5 * 60 * 1000;

const BOT_FIELDS = [
  "name",
  "role",
  "instructions",
  "model",
  "thinking",
  "isMain",
  "permission",
  "executionMode",
  "approvalMode",
  "workspace",
  "memoryEnabled",
  "skills",
  "budget",
  "avatar",
  "allowedCommands",
];

// 原生命令白名单与 Orchestrator 共用同一常量：API 层只做形状校验（不接受路径/参数/空格），
// 集合本身不在 server 复制第二份，避免漂移。
const nativeAllowed = (command) => NATIVE_COMMAND_ALLOWLIST.has(command);

const HANDLED = Symbol("handled");

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function errorStatus(e) {
  const s = Number(e?.status ?? e?.statusCode);
  return Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;
}

/** home 必须真实可写：拿不到写权限就拒绝启动，绝不假装可写。 */
async function assertWritableHome(home) {
  await mkdir(home, { recursive: true });
  const probe = join(home, `.write-probe-${process.pid}`);
  await writeFile(probe, "ok");
  await unlink(probe);
}

/**
 * 本机 owner 运行时描述文件路径（CLI/桌面发现活着的 server 用）。
 * token 只经此 0600 文件传递，绝不出现在 stdout/命令行/URL 里。
 */
export function serverDescriptorPath(home) {
  return join(home ?? defaultHome(), "runtime.json");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // 存在但无权限 → 视为活着
  }
}

/** 当前 home 写锁身份 {pid, nonce, startedAt}；nonce 是 Store 实例的 UUID 身份（同 pid 也不互认）。 */
function readLockIdentity(home) {
  try {
    const lock = JSON.parse(readFileSync(join(home, "state.lock"), "utf8"));
    if (!lock || !Number.isInteger(lock.pid)) return null;
    return { pid: lock.pid, nonce: typeof lock.nonce === "string" ? lock.nonce : "", startedAt: Number(lock.startedAt) };
  } catch {
    return null;
  }
}

/**
 * 读本机 owner 运行时描述（CLI 控制活着的 server 用；token 只经 0600 文件，不进 stdout/命令行/URL）。
 * 只接受「pid 存活」且「home 写锁 pid+nonce 与描述一致」的记录，否则返回 null；
 * lockStartedAt 只是展示用元数据，不参与身份判断（毫秒可能相同）。
 */
export async function readServerDescriptor(home) {
  const dir = home ?? defaultHome();
  let desc;
  try {
    desc = JSON.parse(await readFile(serverDescriptorPath(dir), "utf8"));
  } catch {
    return null;
  }
  if (!desc || typeof desc.url !== "string" || typeof desc.token !== "string" || !pidAlive(desc.pid)) return null;
  if (typeof desc.lockNonce !== "string" || !desc.lockNonce) return null;
  const lock = readLockIdentity(dir);
  if (!lock || lock.pid !== desc.pid || lock.nonce !== desc.lockNonce) return null;
  return {
    url: desc.url,
    token: desc.token,
    pid: desc.pid,
    home: desc.home ?? dir,
    lockNonce: lock.nonce,
    startedAt: desc.startedAt ?? null,
    lockStartedAt: lock.startedAt,
  };
}

export async function startServer({ port = 3099, host = "127.0.0.1", home, bin = "omp", debug = false, defaultThinking = "low", computerBackend, computerRuntimeDir, mobile: mobileOptions = null, runtimeFactory = null } = {}) {
  const resolvedHome = home ?? defaultHome();
  await assertWritableHome(resolvedHome);

  const orch = new Orchestrator({
    home: resolvedHome,
    bin,
    debug,
    defaultThinking,
    computerBackend,
    computerRuntimeDir,
    // 测试夹具运行时（Orchestrator 已支持的注入点）：只在显式传入时透传，生产不启用。
    ...(runtimeFactory ? { runtimeFactory } : {}),
    onEvent: () => {},
  });
  if (orch.store?.readonly) {
    await orch.shutdown();
    throw new Error(`home 只读（${resolvedHome} 已被另一个 omp-bot 进程持有写锁），拒绝以可写姿态启动`);
  }

  const token = newSecret();
  const sessionId = newSecret();
  let actualPort = port;

  // 设备配对服务：Orchestrator 未自建时由 server 组装并挂回 orch.pairing（不复制设备逻辑）。
  const pairing = orch.pairing ?? new PairingService({ orch });
  orch.pairing = pairing;

  // 手机伴侣入口：设备专用、默认关闭，opt-in 配置持久化在 home/mobile.json。
  // 回环基址 listen 之后才确定，因此传取值函数而不是值。
  let loopbackBase = null;
  const mobile = new MobileGateway({
    home: resolvedHome,
    loopbackBase: () => loopbackBase,
    ownerToken: token,
    apkPath: mobileOptions?.apkPath ?? resolveMobileApk(),
    debug,
  });

  const bind = () => ({ port: actualPort, host });

  /** 凭证主体：owner（cookie/Bearer token）或配对设备（ompd_ token），两者互不推断。 */
  const principalOf = (req) => {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie && secretEqual(cookie, sessionId)) return { kind: "owner", via: "cookie" };
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
    if (!m) return null;
    const value = m[1].trim();
    if (secretEqual(value, token)) return { kind: "owner", via: "bearer" };
    const device = pairing.authenticate(value);
    return device ? { kind: "device", via: "bearer", device } : null;
  };

  const deviceOf = (ctx) => (ctx?.principal?.kind === "device" ? ctx.principal.device : null);
  const deviceScope = (principal) =>
    principal?.kind === "device" ? new Set(principal.device.botIds ?? []) : null;

  /** 设备授权：权限不足/越界由 PairingService 抛 403，不在这里复制判定。 */
  function authorizeDevice(principal, action, botId) {
    const device = principal?.kind === "device" ? principal.device : null;
    if (!device) return null;
    pairing.authorize(device, { action, ...(botId ? { botId } : {}) });
    return device;
  }
  const deviceAuthorize = (ctx, action, botId) => authorizeDevice(ctx?.principal, action, botId);

  // ---- 事件与 SSE ----
  const sseClients = new Set();

  function frame(evt) {
    const head = typeof evt?.seq === "number" ? `id: ${evt.seq}\n` : "";
    return `${head}data: ${JSON.stringify(evt)}\n\n`;
  }

  function dropClient(client) {
    sseClients.delete(client);
    try {
      client.res.end();
    } catch {}
  }

  function pushFrame(client, evt) {
    // 撤销必须对已建立的流立即生效：设备流每次推送前重查当前配对状态。
    if (client.deviceId && !deviceAlive(client.deviceId)) return dropClient(client);
    const seq = evt?.seq;
    if (typeof seq === "number") {
      if (seq <= client.lastSent) return; // 重连去重
      client.lastSent = seq;
    }
    if (client.scope && !client.scope.has(evt?.botId)) return; // 设备只看自己被授权的 bot
    if (client.deviceId) evt = deviceSafeEvent(evt); // 设备看不到宿主路径字段
    if (client.res.writableLength > SSE_HIGH_WATER) return dropClient(client); // 有界缓冲
    try {
      client.res.write(frame(evt));
    } catch {
      dropClient(client);
    }
  }

  /** 设备记录仍然有效（未撤销/未删除）→ 允许继续推送。 */
  function deviceAlive(id) {
    const rec = ledger()?.get("devices", id);
    return !!rec && !rec.revokedAt;
  }

  orch.onEvent = (evt) => {
    for (const c of [...sseClients]) {
      if (c.queue) c.queue.push(evt);
      else pushFrame(c, evt);
    }
  };

  const heartbeat = setInterval(() => {
    for (const c of [...sseClients]) {
      if (c.deviceId && !deviceAlive(c.deviceId)) {
        dropClient(c);
        continue;
      }
      if (c.res.writableLength > SSE_HIGH_WATER) {
        dropClient(c);
        continue;
      }
      try {
        c.res.write(":hb\n\n");
      } catch {
        dropClient(c);
      }
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  // ---- 响应与请求体 ----
  const json = (res, code, obj, extra) => {
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    const body = JSON.stringify(obj ?? {});
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(extra ?? {}),
    });
    res.end(body);
  };

  const fail = (res, code, message, machineCode) => json(res, code, { error: message, code: machineCode ?? undefined });

  /**
   * 早拒请求体时把剩余字节丢弃（flowing 模式，不缓冲）。
   * 关键：绝不在响应写出前 req.destroy()——未读数据被丢弃会让连接 RST，
   * 调用方看到 ECONNRESET 而不是结构化的 413/415。
   */
  const drainBody = (req) => {
    try {
      req.resume();
    } catch {}
  };

  function readBody(req, res) {
    return new Promise((resolve, reject) => {
      // 早拒（声明体量过大）时必须声明 Connection: close：请求体没被读完的连接不能留在
      // keep-alive 池里，否则客户端复用这条注定被服务端关闭的 socket，下一个请求拿到 ECONNRESET。
      const closeConnection = () => {
        try {
          res.setHeader("Connection", "close");
        } catch {}
        drainBody(req);
      };
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_BODY) {
        closeConnection();
        reject(httpError(413, `请求体超过上限 ${MAX_BODY} 字节`, "body_too_large"));
        return;
      }
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        err ? reject(err) : resolve(val);
      };
      const onData = (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          // 流式超限：丢弃后续字节但保留连接（客户端可能还在上传，读完再复用，
          // destroy 会让结构化 413 被 RST 抢掉）。
          req.removeListener("data", onData);
          drainBody(req);
          finish(httpError(413, `请求体超过上限 ${MAX_BODY} 字节`, "body_too_large"));
          return;
        }
        chunks.push(chunk);
      };
      req.on("data", onData);
      req.on("end", () => {
        if (done) return;
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return finish(null, null);
        try {
          finish(null, JSON.parse(raw));
        } catch {
          finish(httpError(400, "请求体不是合法 JSON", "bad_json"));
        }
      });
      req.on("error", (e) => finish(httpError(400, e?.message ?? "请求读取失败", "body_read_failed")));
      req.on("aborted", () => finish(httpError(400, "请求中断", "request_aborted")));
    });
  }

  // ---- 只读聚合 ----
  const ledger = () => orch.ledger ?? null;

  function pendingApprovals(status = "pending") {
    const l = ledger();
    if (!l) return [];
    return (l.list("approvals", { limit: 200 }) ?? []).filter((a) => !status || a?.status === status);
  }

  /** 状态快照；设备只看到自己被授权 bot 的花名册、Run 与待办。 */
  function stateSnapshot(principal) {
    const lastSeq = ledger()?.lastSeq() ?? 0;
    const bots = orch.listBots();
    const rooms = orch.listRooms();
    const runs = orch.listRuns({ limit: 500 }) ?? [];
    const approvals = pendingApprovals();
    const scope = deviceScope(principal);
    if (!scope) {
      // team：团队目录位置和有没有 git（没有 git 时界面提示装 Git 才有改动历史）。设备视图不带。
      const team = typeof orch.teamStatus === "function" ? orch.teamStatus() : null;
      return { bots, rooms, activeRuns: runs.filter((r) => ACTIVE_STATES.includes(r.state)), pendingApprovals: approvals, lastSeq, team };
    }
    const myBots = bots.filter((b) => scope.has(b.id));
    const ids = new Set(myBots.map((b) => b.id));
    const rooms2 = [];
    for (const r of rooms) {
      const members = (r.members ?? []).filter((m) => ids.has(m));
      if (!members.length) continue;
      // 白名单投影：不带 log（群内私有消息）、不带未授权成员与他们的 adminId。
      rooms2.push({
        id: r.id,
        name: r.name,
        members,
        mode: r.mode,
        adminId: ids.has(r.adminId) ? r.adminId : null,
        ...(r.createdAt !== undefined ? { createdAt: r.createdAt } : {}),
      });
    }
    return {
      // 设备只看展示字段：bot 的 instructions/workspace/budget 与 run 的宿主 session 路径都不外传。
      bots: myBots.map(deviceSafeBot),
      rooms: rooms2,
      activeRuns: runs.filter((r) => ACTIVE_STATES.includes(r.state) && ids.has(r.botId)).map(deviceSafeRun),
      pendingApprovals: approvals.filter((a) => ids.has(a.botId)),
      lastSeq,
    };
  }

  function runFilters(query) {
    const f = {};
    for (const k of ["botId", "roomId", "state"]) {
      const v = query.get(k);
      if (v) f[k] = v;
    }
    const limit = Number(query.get("limit"));
    f.limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    return f;
  }

  let modelsCache = null;

  async function loadModels(refresh) {
    if (modelsCache && !refresh && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache;
    try {
      const r = await orch.listModels({ refresh: !!refresh });
      modelsCache = {
        at: Date.now(),
        models: Array.isArray(r) ? r : r?.models ?? [],
        source: r?.source ?? null,
        error: null,
      };
    } catch (e) {
      // 有旧目录就继续给旧目录，但把真实错误显式带出；没有缓存时把真实状态透给调用方。
      if (!modelsCache) throw e;
      modelsCache = { ...modelsCache, stale: true, error: e?.message ?? String(e) };
    }
    return modelsCache;
  }

  function setSessionCookie(res) {
    res.setHeader("Set-Cookie", sessionCookie(SESSION_COOKIE, sessionId));
    return { ok: true };
  }

  function scopeOf(ctx) {
    const s = ctx.query.get("scope") ?? ctx.body?.scope;
    return typeof s === "string" && s.trim() ? s.trim() : "private";
  }

  function botPayload(body, { creating }) {
    const out = {};
    for (const k of BOT_FIELDS) if (body?.[k] !== undefined) out[k] = body[k];
    if (creating) {
      if (typeof out.name !== "string" || !out.name.trim()) throw httpError(400, "name 必填");
      out.name = out.name.trim();
    } else if (out.name !== undefined && (typeof out.name !== "string" || !out.name.trim())) {
      throw httpError(400, "name 不能为空");
    }
    // 权限档的合法性与显式确认由 Orchestrator 唯一的策略校验裁决；这里只透传确认位。
    for (const k of ["confirmPermission", "confirmExecutionMode", "confirmApprovalMode"]) {
      if (body?.[k] !== undefined) out[k] = body[k];
    }
    return out;
  }

  function openSse(ctx) {
    const { req, res, query } = ctx;
    if (sseClients.size >= MAX_SSE_CLIENTS) throw httpError(503, "SSE 连接数已达上限", "too_many_streams");
    const l = ledger();
    if (!l) throw httpError(500, "账本不可用，无法提供事件重放", "ledger_unavailable");

    const headerId = Number(req.headers["last-event-id"]);
    const querySince = Number(query.get("since"));
    const since = headerId > 0 ? headerId : querySince > 0 ? querySince : 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);
    res.socket?.setTimeout?.(0);

    const client = {
      res,
      lastSent: since,
      queue: [],
      scope: deviceScope(ctx.principal),
      deviceId: ctx.principal?.kind === "device" ? ctx.principal.device.id : null,
    };
    sseClients.add(client);
    const cleanup = () => sseClients.delete(client);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    const lastSeq = l.lastSeq();
    const from = lastSeq - since > REPLAY_LIMIT ? lastSeq - REPLAY_LIMIT : since;
    res.write(`data: ${JSON.stringify({ v: 1, type: "hello", lastSeq: lastSeq ?? 0 })}\n\n`);
    if (from > since) {
      res.write(`data: ${JSON.stringify({ v: 1, type: "gap", from: since, to: from, lastSeq: lastSeq ?? 0 })}\n\n`);
    }
    for (const evt of l.eventsSince(from, { limit: REPLAY_LIMIT })) pushFrame(client, evt);
    // 重放期间到达的事件在队列里，按 seq 去重后补齐，避免漏帧或双发。
    const queued = client.queue;
    client.queue = null;
    for (const evt of queued) pushFrame(client, evt);
    return HANDLED;
  }

  async function serveStatic(req, res, segs) {
    const rel = segs.length ? segs.join("/") : "index.html";
    const full = normalize(join(WEB_DIR, rel));
    if (full !== WEB_DIR && !full.startsWith(WEB_DIR + sep)) {
      return fail(res, 403, "forbidden", "forbidden");
    }
    if (!existsSync(full)) return fail(res, 404, "not found", "not_found");

    const ext = extname(full).toLowerCase();
    const buf = await readFile(full);
    const headers = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": buf.length,
      "Cache-Control": ext === ".html" ? "no-store" : "no-cache",
      ...SECURITY_HEADERS,
    };
    // 只有经过验证的顶层同源/回环导航才 bootstrap 会话 cookie（HttpOnly + SameSite=Strict）。
    if (ext === ".html" && bootstrapContextOk(req) && originOk(req, bind())) {
      headers["Set-Cookie"] = sessionCookie(SESSION_COOKIE, sessionId);
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    res.end(buf);
  }

  // ---- 路由表：path 段逐项相等，`*` 为参数段 ----
  const routes = [
    { method: "GET", path: ["api", "state"], access: "any", run: (c) => stateSnapshot(c.principal) },

    { method: "GET", path: ["api", "models"], run: (c) => loadModels(c.query.get("refresh") === "1") },

    { method: "GET", path: ["api", "usage"], run: async () => {
      // 持久口径取账本差值（usage.ledger）；perRuntime 是本进程 runtime 累计，两者不相加。
      const live = await collectUsage(orch);
      const led = live?.ledger ?? { perRun: [], totals: {}, available: false };
      return {
        perRun: led.perRun ?? [],
        totals: led.totals ?? {},
        ledgerAvailable: led.available === true,
        perRuntime: live?.perRuntime ?? [],
      };
    } },

    { method: "POST", path: ["api", "session", "bootstrap"], run: (c) => setSessionCookie(c.res) },

    // ---- 设备配对：admin 路由只认 owner 凭证；redeem 是唯一未认证入口（Host/Origin/CT + 限流）----
    { method: "POST", path: ["api", "pairing", "codes"], status: 201, run: (c) => pairing.create(c.body ?? {}) },

    { method: "POST", path: ["api", "pairing", "redeem"], access: "public", run: (c) => {
      const b = c.body ?? {};
      // 限流键只能取不可伪造的来源地址：body.client 由调用方随便改，用了就能绕过限流。
      const client = c.req.socket?.remoteAddress ?? "unknown";
      return pairing.redeem({ code: b.code, client, name: b.name });
    } },

    { method: "GET", path: ["api", "pairing"], run: () => pairing.list() },

    { method: "DELETE", path: ["api", "pairing", "*"], run: (c) => {
      const out = pairing.revoke(c.segs[2]);
      // 撤销后立刻关掉该设备已建立的 SSE，不等下一次心跳。
      const deviceId = out?.type === "device" ? out.id : out?.deviceId;
      if (deviceId) {
        for (const cl of [...sseClients]) if (cl.deviceId === deviceId) dropClient(cl);
      }
      return out;
    } },

    // ---- 手机伴侣入口（owner 侧控制面）：默认关闭；只在回环服务上，设备入口不发布这些路径 ----
    { method: "GET", path: ["api", "mobile"], run: () => mobile.status() },
    { method: "POST", path: ["api", "mobile"], run: (c) => mobile.apply(c.body ?? {}) },
    { method: "POST", path: ["api", "mobile", "invitation"], run: (c) => mobile.invitation(c.body ?? {}, { pairing }) },
    { method: "GET", path: ["api", "mobile", "apk"], run: (c) => {
      mobile.serveApk(c.res);
      return HANDLED;
    } },

    { method: "GET", path: ["api", "events"], access: "any", run: (c) => openSse(c) },

    { method: "GET", path: ["api", "events", "history"], access: "any", run: (c) => {
      const l = ledger();
      if (!l) throw httpError(500, "账本不可用，无法提供事件历史", "ledger_unavailable");
      const since = Math.max(0, Number(c.query.get("since")) || 0);
      const limit = Math.min(5000, Math.max(1, Number(c.query.get("limit")) || 1000));
      const runId = c.query.get("runId") ?? undefined;
      const scope = deviceScope(c.principal);
      const events = l.eventsSince(since, { ...(runId ? { runId } : {}), limit });
      const visible = scope ? events.filter((e) => scope.has(e?.botId)) : events;
      return { events: scope ? visible.map(deviceSafeEvent) : visible, lastSeq: l.lastSeq() ?? 0 };
    } },

    { method: "GET", path: ["api", "runs"], access: "any", run: (c) => {
      const scope = deviceScope(c.principal);
      const runs = orch.listRuns(runFilters(c.query)) ?? [];
      const visible = scope ? runs.filter((r) => scope.has(r.botId)) : runs;
      return { runs: scope ? visible.map(deviceSafeRun) : visible };
    } },

    { method: "POST", path: ["api", "runs"], access: "any", status: 202, run: async (c) => {
      const b = c.body ?? {};
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (!text) throw httpError(400, "text 必填");
      if (!b.botId && !b.roomId) throw httpError(400, "botId 或 roomId 必填");
      const device = deviceOf(c);
      if (device && !b.botId) throw httpError(403, "设备只能向被授权的 bot 派活，不能发起群运行", "DEVICE_OUT_OF_SCOPE");
      if (device) {
        // 设备请求体只接受契约字段：parentRunId/taskId/depth/budget/timeoutMs/images/source 等一律拒绝，
        // 内部编排字段（委派链、额度、来源）不能由手机自行填写，防止借它们扩大授权。
        const allowed = ["botId", "text", "attachmentIds"];
        const extra = Object.keys(b).filter((k) => !allowed.includes(k));
        if (extra.length) {
          throw httpError(400, `设备派活不接受字段：${extra.join("、")}（只允许 ${allowed.join("、")}）`, "DEVICE_FIELD_DENIED");
        }
        if (b.attachmentIds !== undefined && !Array.isArray(b.attachmentIds)) {
          throw httpError(400, "attachmentIds 必须是数组", "DEVICE_FIELD_DENIED");
        }
      }
      if (b.botId) deviceAuthorize(c, "run", b.botId);
      if (b.botId && !orch.getBot(b.botId)) throw httpError(404, "bot 不存在");
      if (b.roomId && !orch.getRoom(b.roomId)) throw httpError(404, "room 不存在");
      const attachmentIds = Array.isArray(b.attachmentIds) ? b.attachmentIds : [];
      if (device && attachmentIds.length) {
        // 以附件登记记录为准核对归属：跨 bot 引用在派活前拒绝，不留给运行时再炸。
        for (const id of attachmentIds) {
          const rec = orch.features?.attachments?.get?.(id);
          if (!rec) throw httpError(404, `附件不存在：${id}`, "attachment_not_found");
          if (rec.botId !== b.botId) {
            throw httpError(403, `附件 ${id} 属于另一个 Bot，设备不能跨 Bot 引用`, "DEVICE_RESOURCE_OUT_OF_SCOPE");
          }
        }
      }
      const run = await orch.startRun({
        ...(b.botId ? { botId: b.botId } : {}),
        ...(b.roomId ? { roomId: b.roomId } : {}),
        text,
        attachmentIds,
        depth: Number.isInteger(b.depth) ? b.depth : 0,
        source: device ? `device:${device.id}` : typeof b.source === "string" && b.source ? b.source : "user",
        ...(b.images !== undefined ? { images: b.images } : {}),
        ...(b.timeoutMs !== undefined ? { timeoutMs: Number(b.timeoutMs) } : {}),
        ...(b.budget !== undefined ? { budget: b.budget } : {}),
        ...(b.parentRunId ? { parentRunId: b.parentRunId } : {}),
        ...(b.taskId ? { taskId: b.taskId } : {}),
      });
      return { run };
    } },

    { method: "GET", path: ["api", "runs", "*"], access: "any", run: (c) => {
      const run = orch.getRun(c.segs[2]);
      if (!run) throw httpError(404, "run 不存在");
      deviceAuthorize(c, "status", run.botId);
      const l = ledger();
      const byRun = (kind) => (l ? (l.list(kind, { limit: 500 }) ?? []).filter((x) => x?.runId === run.id) : []);
      const device = deviceOf(c);
      const artifacts = byRun("artifacts");
      return {
        run: device ? deviceSafeRun(run) : run,
        approvals: byRun("approvals"),
        artifacts: device ? artifacts.map(deviceSafeArtifact) : artifacts,
      };
    } },

    { method: "POST", path: ["api", "runs", "*", "cancel"], access: "any", status: 202, run: async (c) => {
      const run = orch.getRun(c.segs[2]);
      if (!run) throw httpError(404, "run 不存在");
      deviceAuthorize(c, "cancel", run.botId);
      const reason = typeof c.body?.reason === "string" && c.body.reason ? c.body.reason : "user";
      return await orch.cancelRun(run.id, reason);
    } },

    // 续跑被重启打断的 Run：只给主人（等于替 bot 重新派一次活）。
    { method: "POST", path: ["api", "runs", "*", "resume"], status: 202, run: (c) => orch.resumeRun(c.segs[2]) },

    { method: "POST", path: ["api", "runs", "*", "steer"], access: "any", run: async (c) => {
      const run = orch.getRun(c.segs[2]);
      if (!run) throw httpError(404, "run 不存在");
      deviceAuthorize(c, "steer", run.botId);
      const text = typeof c.body?.text === "string" ? c.body.text.trim() : "";
      if (!text) throw httpError(400, "text 必填");
      const out = await orch.steerRun(run.id, text, {
        behavior: typeof c.body?.behavior === "string" && c.body.behavior ? c.body.behavior : "steer",
        ...(c.body?.images !== undefined ? { images: c.body.images } : {}),
      });
      return out && typeof out === "object" && out.id ? { run: out } : { ok: true };
    } },

    // 助手之间派的活（delegate_bot 的工作账与交付账）。只给主人看：交回结果可能含别的 bot 的私有内容。
    { method: "GET", path: ["api", "delegations"], run: (c) => {
      const botId = c.query.get("botId") || null;
      const limit = Number.parseInt(c.query.get("limit") ?? "100", 10);
      return { delegations: orch.listDelegations({ botId, limit: Number.isFinite(limit) ? limit : 100 }) };
    } },

    // 团队事实：成员的提议和文件里的现状。只给主人：提议里可能带着私聊来源。接受和纠正也只有主人能做。
    { method: "GET", path: ["api", "team", "facts"], run: () => ({
      facts: orch.listTeamFacts(),
      proposals: orch.listTeamProposals({ limit: 200 }),
    }) },
    { method: "POST", path: ["api", "team", "facts"], status: 201, run: (c) => {
      const b = c.body ?? {};
      return { proposal: orch.addTeamFact({ fact: b.fact, source: b.source, replaces: b.replaces ?? null, by: { kind: "user" } }) };
    } },
    { method: "POST", path: ["api", "team", "proposals", "*", "accept"], run: (c) => ({
      proposal: orch.decideTeamProposal(c.segs[3], { decision: "accept", by: { kind: "user" } }),
    }) },
    { method: "POST", path: ["api", "team", "proposals", "*", "reject"], run: (c) => ({
      proposal: orch.decideTeamProposal(c.segs[3], { decision: "reject", by: { kind: "user" }, reason: c.body?.reason ?? null }),
    }) },

    { method: "GET", path: ["api", "approvals"], access: "any", run: (c) => {
      const all = ledger() ? ledger().list("approvals", { limit: 200 }) ?? [] : [];
      const status = c.query.get("status");
      const list = all.filter((a) => (status ? a?.status === status : a?.status === "pending"));
      const scope = deviceScope(c.principal);
      return { approvals: scope ? list.filter((a) => scope.has(a?.botId)) : list };
    } },

    { method: "POST", path: ["api", "approvals", "*", "respond"], access: "any", run: async (c) => {
      const id = c.segs[2];
      const b = c.body ?? {};
      const response = {};
      for (const k of ["value", "confirmed", "cancelled", "answers"]) {
        if (b[k] !== undefined) response[k] = b[k];
      }
      if (!Object.keys(response).length) throw httpError(400, "value/confirmed/cancelled/answers 至少一个必填");
      if (b.remember === true) {
        // 「以后都允许」改的是助手的长期权限，只在工作台本人那里改。
        if (deviceOf(c)) throw httpError(403, "配对设备不能把命令记成以后都允许，请在工作台操作", "remember_forbidden");
        response.remember = true;
      }
      if (deviceOf(c)) {
        // approve 必须有 botId（DeviceChannelOwner 的 authorize 强制），所以先取审批记录拿 botId，
        // 再做权限 + 作用域判定；顺序固定为「存在性 → 权限/作用域 → 渠道来源」。
        const rec = ledger()?.get("approvals", id);
        if (!rec) throw httpError(404, "审批不存在", "approval_not_found");
        deviceAuthorize(c, "approve", rec.botId);
        // 飞书等渠道来源的审批只能由发起该 Run 的身份回答，配对的设备凭证不能代答。
        const src = rec.runId ? orch.getRun(rec.runId)?.source : null;
        if (typeof src === "string" && src.startsWith("feishu:")) {
          throw httpError(403, "该审批来自飞书会话，只能由发起身份回答", "CHANNEL_IDENTITY_REQUIRED");
        }
      }
      const out = await orch.answerUi(id, response);
      return out && typeof out === "object" && out.id ? { approval: out } : { ok: true };
    } },

    { method: "POST", path: ["api", "bots", "*", "session", "new"], run: async (c) => {
      const id = c.segs[2];
      if (!orch.getBot(id)) throw httpError(404, "bot 不存在");
      const out = await orch.newSession(id, { scope: scopeOf(c) });
      return out === undefined ? { ok: true } : { session: out };
    } },

    { method: "POST", path: ["api", "bots", "*", "session", "fork"], run: async (c) => {
      const id = c.segs[2];
      if (!orch.getBot(id)) throw httpError(404, "bot 不存在");
      const entryId = c.body?.entryId ?? c.query.get("entryId") ?? undefined;
      const out = await orch.forkSession(id, { ...(entryId ? { entryId } : {}), scope: scopeOf(c) });
      return out === undefined ? { ok: true } : { session: out };
    } },

    { method: "GET", path: ["api", "bots", "*", "session", "export"], run: async (c) => {
      const id = c.segs[2];
      if (!orch.getBot(id)) throw httpError(404, "bot 不存在");
      const out = await orch.exportSession(id, { scope: scopeOf(c) });
      let html = typeof out === "string" ? out : out?.html;
      if (html === undefined && out?.path) {
        // 路径来自原生导出，不接受用户输入；仍校验必须落在 home 内。
        const full = resolve(String(out.path));
        if (full !== resolvedHome && !full.startsWith(resolvedHome + sep)) {
          throw httpError(403, "原生导出路径超出 home，拒绝读取", "export_path_denied");
        }
        html = await readFile(full, "utf8");
      }
      if (typeof html !== "string") throw httpError(500, "原生导出未返回 HTML 内容", "export_empty");
      const body = Buffer.from(html, "utf8");
      c.res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Content-Disposition": `attachment; filename="session-${id}.html"`,
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      });
      c.res.end(body);
      return HANDLED;
    } },

    { method: "GET", path: ["api", "bots", "*", "native", "state"], run: async (c) => {
      const id = c.segs[2];
      if (!orch.getBot(id)) throw httpError(404, "bot 不存在");
      return redactSecrets(await orch.getNativeState(id, { scope: scopeOf(c) }));
    } },

    { method: "GET", path: ["api", "bots", "*", "native", "entries"], run: async (c) => {
      const id = c.segs[2];
      if (!orch.getBot(id)) throw httpError(404, "bot 不存在");
      const limit = Math.min(1000, Math.max(1, Number(c.query.get("limit")) || 200));
      const out = await orch.getNativeEntries(id, { scope: scopeOf(c), limit });
      return Array.isArray(out) ? { entries: out } : out;
    } },

    { method: "POST", path: ["api", "bots", "*", "native", "command"], run: async (c) => {
      const id = c.segs[2];
      if (!orch.getBot(id)) throw httpError(404, "bot 不存在");
      const command = typeof c.body?.command === "string" ? c.body.command.trim() : "";
      if (!/^[a-z][a-z0-9_-]{0,60}$/i.test(command)) throw httpError(400, "command 必须是纯命令名（不接受参数或路径）");
      if (!nativeAllowed(command)) {
        throw httpError(403, `command 不在允许清单: ${command}`, "command_not_allowed");
      }
      const out = await orch.nativeCommand(id, command, { scope: scopeOf(c) });
      return { command, result: redactSecrets(out ?? null) };
    } },

    // ---- 既有入口：内部复用统一运行逻辑，返回形状保持 ----
    { method: "GET", path: ["api", "bots"], run: () => ({ bots: orch.listBots() }) },
    { method: "POST", path: ["api", "bots"], run: (c) => {
      const payload = botPayload(c.body, { creating: true });
      if (orch.listBots().some((b) => b.name === payload.name)) {
        throw httpError(409, `名字「${payload.name}」已被占用`);
      }
      return { bot: orch.addBot(payload) };
    } },
    { method: "PATCH", path: ["api", "bots", "*"], run: (c) => {
      const id = c.segs[2];
      if (!orch.getBot(id)) throw httpError(404, "bot 不存在");
      const payload = botPayload(c.body, { creating: false });
      const bot = orch.updateBot(id, payload);
      if (!bot) throw httpError(404, "bot 不存在");
      return { bot };
    } },
    { method: "DELETE", path: ["api", "bots", "*"], run: (c) => {
      if (!orch.getBot(c.segs[2])) throw httpError(404, "bot 不存在");
      orch.removeBot(c.segs[2]);
      return { ok: true };
    } },

    { method: "GET", path: ["api", "chat", "*"], access: "any", run: (c) => {
      const botId = c.segs[2];
      if (!orch.getBot(botId)) throw httpError(404, "bot 不存在");
      deviceAuthorize(c, "read", botId); // 设备读私聊历史同样受 read 权限 + bot 作用域约束
      return { messages: orch.getChat(botId) };
    } },
    { method: "DELETE", path: ["api", "chat", "*"], run: (c) => {
      if (!orch.getBot(c.segs[2])) throw httpError(404, "bot 不存在");
      orch.clearChat(c.segs[2]);
      return { ok: true };
    } },
    { method: "POST", path: ["api", "chat", "*"], run: async (c) => {
      const botId = c.segs[2];
      if (!orch.getBot(botId)) throw httpError(404, "bot 不存在");
      const text = typeof c.body?.text === "string" ? c.body.text.trim() : "";
      if (!text) throw httpError(400, "text 必填");
      const timeoutMs = Number(c.body?.timeoutMs);
      const reply = await orch.chatWithBot(botId, text, {
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600_000,
      });
      return { reply };
    } },

    { method: "GET", path: ["api", "rooms"], run: () => ({ rooms: orch.listRooms() }) },
    { method: "POST", path: ["api", "rooms"], run: (c) => {
      const b = c.body ?? {};
      if (typeof b.name !== "string" || !b.name.trim() || !Array.isArray(b.members) || !b.members.length) {
        throw httpError(400, "name 和非空 members 必填");
      }
      for (const id of b.members) if (!orch.getBot(id)) throw httpError(400, `成员不存在: ${id}`);
      return { room: orch.createRoom({ name: b.name, members: b.members, adminId: b.adminId ?? null, mode: b.mode ?? "admin" }) };
    } },
    { method: "PATCH", path: ["api", "rooms", "*"], run: (c) => {
      const patch = c.body ?? {};
      if (Array.isArray(patch.members)) {
        for (const id of patch.members) if (!orch.getBot(id)) throw httpError(400, `成员不存在: ${id}`);
      }
      const room = orch.updateRoom(c.segs[2], patch);
      if (!room) throw httpError(404, "room 不存在");
      return { room };
    } },
    { method: "DELETE", path: ["api", "rooms", "*"], run: (c) => {
      if (!orch.getRoom(c.segs[2])) throw httpError(404, "room 不存在");
      orch.removeRoom(c.segs[2]);
      return { ok: true };
    } },
    { method: "POST", path: ["api", "rooms", "*", "say"], run: async (c) => {
      const roomId = c.segs[2];
      if (!orch.getRoom(roomId)) throw httpError(404, "room 不存在");
      const text = typeof c.body?.text === "string" ? c.body.text.trim() : "";
      if (!text) throw httpError(400, "text 必填");
      const spoken = await orch.postToRoom(roomId, text, { userName: c.body?.userName ?? "用户" });
      return { spoken };
    } },
  ];

  function findRoute(segs, method) {
    let methodMiss = false;
    for (const r of routes) {
      if (r.path.length !== segs.length) continue;
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (r.path[i] !== "*" && r.path[i] !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method !== method) {
        methodMiss = true;
        continue;
      }
      return { route: r };
    }
    return { route: null, methodMiss };
  }

  async function handle(req, res) {
    const rawUrl = req.url ?? "/";
    const qi = rawUrl.indexOf("?");
    const rawPath = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
    const query = new URLSearchParams(qi < 0 ? "" : rawUrl.slice(qi + 1));
    const method = req.method ?? "GET";

    const segs = decodeSegments(rawPath);
    if (!segs) return fail(res, 400, "路径不合法", "bad_path");
    if (!hostOk(req, bind())) return fail(res, 403, "Host 非法（只允许本机回环同端口）", "bad_host");

    if (method === "OPTIONS") {
      res.setHeader("Allow", "GET, HEAD, POST, PATCH, DELETE");
      return fail(res, 405, "不支持 OPTIONS 预检，本服务不开放跨源 CORS", "method_not_allowed");
    }

    if (segs[0] !== "api") {
      if (method !== "GET" && method !== "HEAD") return fail(res, 405, `不允许的方法 ${method}`, "method_not_allowed");
      return serveStatic(req, res, segs);
    }

    if (!originOk(req, bind())) return fail(res, 403, "Origin 非法（跨源请求被拒）", "bad_origin");

    const { route, methodMiss } = findRoute(segs, method);
    const access = route?.access ?? "owner";
    let principal = null;
    if (access !== "public") {
      principal = principalOf(req);
      if (!principal) {
        // 已撤销的设备 token 与「从未有效」分开报：客户端据此提示重新配对。
        const bearerValue = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim();
        if (bearerValue && pairing.revokedDevice?.(bearerValue)) {
          return fail(res, 401, "设备凭证已撤销，请重新配对", "DEVICE_REVOKED");
        }
        return fail(res, 401, "缺少有效凭证（session cookie 或 Bearer token）", "unauthorized");
      }
      // 花名册/策略/连接器等功能面只认 owner 凭证：设备 token 只放行标注为设备可用的端点
      // （server 路由的 access:"any"，以及 features 路由表里显式 device 的附件/成果端点）。
      if (principal.kind === "device" && access !== "any" && !orch.features?.allowsDevice?.(method, rawPath)) {
        pairing.authorizeAdmin();
      }
      if (principal.kind === "device" && method === "GET") pairing.authorize(principal.device, { action: "read" });
    }

    let body = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const hasBody = (req.headers["content-length"] ?? "0") !== "0" || !!req.headers["transfer-encoding"];
      if (hasBody && !isJsonContentType(req)) {
        drainBody(req); // 丢弃请求体再回 415，避免未读数据把响应顶成 RST
        res.setHeader("Connection", "close");
        return fail(res, 415, "mutation 只接受 application/json 请求体", "bad_content_type");
      }
      body = await readBody(req, res);
    }

    if (route) {
      const out = await route.run({ req, res, segs, query, body, method, principal });
      if (out === HANDLED) return;
      return json(res, route.status ?? 200, out);
    }

    // 产品特性端点（附件/成果/计划/能力…）只在这里接一次；鉴权与设备放行已在前面的边界完成。
    if (orch.features) {
      const url = new URL(rawUrl, `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`);
      const security = {
        principal,
        deviceScope: deviceScope(principal),
        authorizeDevice: (action, botId) => authorizeDevice(principal, action, botId),
      };
      if (await orch.features.handleRequest(req, res, url, body, json, security)) return;
    }

    if (methodMiss) return fail(res, 405, `不允许的方法 ${method}`, "method_not_allowed");
    return fail(res, 404, "unknown api", "not_found");
  }

  const server = createServer(async (req, res) => {
    res.on("error", () => {});
    req.on("error", () => {});
    try {
      await handle(req, res);
    } catch (e) {
      if (debug) console.error("[server]", e);
      if (res.headersSent) {
        try {
          res.end();
        } catch {}
        return;
      }
      const retryAfterMs = Number(e?.retryAfterMs);
      const hasRetry = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
      json(
        res,
        errorStatus(e),
        {
          error: e?.message ?? String(e),
          ...(typeof e?.code === "string" ? { code: e.code } : {}),
          ...(hasRetry ? { retryAfterMs } : {}),
        },
        hasRetry ? { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } : undefined,
      );
    }
  });

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.removeListener("error", rej);
      res();
    });
  });
  actualPort = server.address()?.port ?? port;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`;
  // 设备入口转发到回环：通配绑定（0.0.0.0/::）落到 127.0.0.1，Host 归一化后必过 hostOk。
  const connectHost = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  loopbackBase = `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${actualPort}`;

  // owner 发现文件：让 CLI/桌面把控制命令发给这个活着的进程，而不是再起一个引擎。
  const descriptorPath = serverDescriptorPath(resolvedHome);
  // 绑定 home 写锁身份：用 Store 实例真正的 UUID nonce（同 pid 的两个实例也不互认），startedAt 仅展示。
  const lockFile = readLockIdentity(resolvedHome);
  const lockNonce = orch.store?.lockNonce ?? lockFile?.nonce ?? null;
  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8"))?.version ?? null;
  } catch {}
  async function writeDescriptor() {
    await writeFile(
      descriptorPath,
      JSON.stringify(
        {
          v: 1,
          pid: process.pid,
          url: base,
          token,
          startedAt: Date.now(),
          lockPid: lockFile?.pid ?? process.pid,
          lockNonce,
          lockStartedAt: lockFile?.startedAt ?? null,
          ...(pkgVersion ? { version: `omp-bot ${pkgVersion}` } : {}),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  async function removeDescriptor() {
    try {
      const cur = JSON.parse(await readFile(descriptorPath, "utf8"));
      if (cur?.pid === process.pid && !!lockNonce && cur?.lockNonce === lockNonce) await unlink(descriptorPath);
    } catch {}
  }

  try {
    await writeDescriptor();
    await orch.ensureFeatures?.(); // 懒装载 WorkbenchFeatures；缺失时保留 null 门面，特性路由显式 404
    await orch.features?.start?.();
    await mobile.startFromConfig(); // 持久化 opt-in 才拉起；绑定失败只记 lastError，不阻断主服务
  } catch (e) {
    await mobile.close();
    await new Promise((res) => {
      server.close(() => res());
      server.closeAllConnections?.();
    });
    await removeDescriptor();
    await orch.shutdown();
    throw e;
  }

  return {
    server,
    orch,
    url: base,
    launchUrl: `${base}/#${token}`,
    token,
    async close() {
      await mobile.close(); // 先停设备入口，再断 SSE 与回环服务
      clearInterval(heartbeat);
      for (const c of [...sseClients]) dropClient(c);
      await new Promise((res) => {
        server.close(() => res());
        server.closeAllConnections?.();
      });
      await removeDescriptor(); // 只删自己写的那份（pid 匹配）
      await orch.shutdown(); // 落定活跃 Run、停 runtime、关 features、释放锁与账本
    },
  };
}

// mobile.mjs — 手机伴侣入口：设备专用、默认关闭、与主服务同生共死。
//
// 边界（全部在转发之前）：
// - 只发布本文件 DEVICE_ROUTES 表内的「方法 + 路径」：未知路径 404、已知路径错方法 405，
//   静态页、管理面、owner 控制面一律不接（默认拒绝）。
// - 带 Origin / Sec-Fetch-* 的浏览器请求、任何 Cookie、owner Bearer 在入口直接拒绝：
//   设备入口只认设备 token，转发时也不携带 cookie，owner 身份无法借道进入回环服务。
// - 转发只带白名单请求头，Host 归一化为回环地址；权限与作用域判定仍只发生在主服务的 PairingService。
// - 本模块还导出「设备可见投影」：server 与 features 用它剔除宿主路径等内部字段，owner 视图不受影响。

import { createServer, request as httpRequest } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSegments, secretEqual } from "./http-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, "..");

/** 健康检查协议名：手机端据此确认对面是 omp-bot 设备入口。 */
export const MOBILE_PROTOCOL = "ompbot-mobile-v1";

const CONFIG_FILE = "mobile.json";
const APK_FILENAME = "omp-bot-android.apk";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3100;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 转发到回环服务时携带的请求头白名单；其余（尤其 Cookie 与转发声明头）一律不带。 */
const FORWARD_HEADERS = ["authorization", "content-type", "content-length", "last-event-id"];

/** 设备入口能走的方法与路径，与主服务实际对设备开放的端点一一对应。local 由本模块直接应答。 */
const DEVICE_ROUTES = Object.freeze([
  { method: "GET", path: ["api", "health"], local: "health" },
  { method: "GET", path: ["download", "omp-bot.apk"], local: "apk" },
  { method: "POST", path: ["api", "pairing", "redeem"] },
  { method: "GET", path: ["api", "state"] },
  { method: "GET", path: ["api", "chat", "*"] },
  { method: "GET", path: ["api", "runs"] },
  { method: "POST", path: ["api", "runs"] },
  { method: "GET", path: ["api", "runs", "*"] },
  { method: "POST", path: ["api", "runs", "*", "cancel"] },
  { method: "POST", path: ["api", "runs", "*", "steer"] },
  { method: "GET", path: ["api", "approvals"] },
  { method: "POST", path: ["api", "approvals", "*", "respond"] },
  { method: "GET", path: ["api", "events"] },
  { method: "GET", path: ["api", "events", "history"] },
  { method: "POST", path: ["api", "attachments"] },
  { method: "GET", path: ["api", "attachments"] },
  { method: "GET", path: ["api", "attachments", "*", "preview"] },
  { method: "GET", path: ["api", "artifacts"] },
  { method: "GET", path: ["api", "artifacts", "*", "download"] },
  { method: "GET", path: ["api", "artifacts", "*", "preview"] },
]);

function mobileError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function writeJson(res, status, obj) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  const body = JSON.stringify(obj ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function errorInfo(e, fallbackCode) {
  return {
    code: typeof e?.code === "string" && e.code ? e.code : fallbackCode,
    message: e?.message ?? String(e),
    at: Date.now(),
  };
}

// ---- 配置（home/mobile.json）----

export function defaultMobileConfig() {
  return { enabled: false, host: DEFAULT_HOST, port: DEFAULT_PORT, publicUrl: null };
}

function normalizePublicUrl(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw mobileError(400, "publicUrl 必须是 http(s) URL 字符串", "mobile_config_invalid");
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    throw mobileError(400, "publicUrl 不是合法 URL", "mobile_config_invalid");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw mobileError(400, "publicUrl 只支持 http/https", "mobile_config_invalid");
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw mobileError(400, "publicUrl 必须是没有账号、路径、查询或片段的服务根地址", "mobile_config_invalid");
  }
  return u.href.replace(/\/+$/, "");
}

/** 校验并合并配置补丁：非法输入显式 400，绝不静默改成别的值。 */
export function mergeMobileConfig(patch, base = defaultMobileConfig()) {
  const next = { ...base };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw mobileError(400, "enabled 必须是布尔值", "mobile_config_invalid");
    next.enabled = patch.enabled;
  }
  if (patch.host !== undefined) {
    if (typeof patch.host !== "string" || isIP(patch.host) === 0) {
      throw mobileError(400, `host 必须是 IP 字面量（收到 ${JSON.stringify(patch.host)}）`, "mobile_config_invalid");
    }
    next.host = patch.host;
  }
  if (patch.port !== undefined) {
    if (!Number.isInteger(patch.port) || patch.port < 0 || patch.port > 65535) {
      throw mobileError(400, "port 必须是 0..65535 的整数（0 = 随机端口）", "mobile_config_invalid");
    }
    next.port = patch.port;
  }
  if (patch.publicUrl !== undefined) next.publicUrl = normalizePublicUrl(patch.publicUrl);
  return next;
}

/** 读持久化配置；文件缺失返回 null，坏文件抛 mobile_config_invalid（调用方如实上报，不当默认值）。 */
export function readMobileConfig(home) {
  const path = join(home, CONFIG_FILE);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw mobileError(500, `${path} 不是合法 JSON：${e?.message ?? e}`, "mobile_config_invalid");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw mobileError(500, `${path} 不是配置对象`, "mobile_config_invalid");
  }
  return mergeMobileConfig(raw, defaultMobileConfig());
}

/** 0600 落盘（Windows 上 mode 尽力而为），与 channels 的配置写入约定一致。 */
export function writeMobileConfig(home, config) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, CONFIG_FILE), JSON.stringify({ ...config, updatedAt: Date.now() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

// ---- 广播地址 ----

/** Tailscale IPv4 走 100.64.0.0/10（CGNAT 段）。 */
function isTailnetIp(ip) {
  const [a, b] = String(ip).split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * 手机真实可达的入口地址：只报当前机器实际存在的接口（0.0.0.0 时列全部非内部 IPv4），
 * 不猜域名、不猜公网。公开地址（publicUrl）与回环条目单列，由使用者自行选择。
 */
export function mobileAddressEntries({ host, port, publicUrl = null }) {
  const entries = [];
  if (Number.isInteger(port) && port > 0) {
    const wildcard = host === "0.0.0.0" || host === "::" || host === "";
    const loopbackOnly = host === "127.0.0.1" || host === "::1";
    if (!loopbackOnly) {
      for (const [name, infos] of Object.entries(networkInterfaces())) {
        for (const info of infos ?? []) {
          if (info.family !== "IPv4" || info.internal) continue;
          if (!wildcard && info.address !== host) continue;
          const tailnet = isTailnetIp(info.address);
          entries.push({
            url: `http://${info.address}:${port}`,
            label: tailnet ? `Tailscale ${info.address}` : `${name} ${info.address}`,
            kind: tailnet ? "tailnet" : "lan",
          });
        }
      }
    }
    // 回环条目留给模拟器与 adb reverse：绑定 0.0.0.0 / 127.0.0.1 时都真实可达。
    if (wildcard || loopbackOnly) {
      entries.push({ url: `http://127.0.0.1:${port}`, label: "本机回环（模拟器 / adb reverse）", kind: "loopback" });
    }
  }
  if (publicUrl) entries.push({ url: publicUrl, label: publicUrl, kind: "public" });
  return entries;
}

// ---- 设备可见投影：只出现在设备响应/事件里，owner 视图不变 ----

function without(obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/** 设备可见的 bot：只有手机要用的展示字段，instructions/workspace/budget 等私有配置不外传。 */
export function deviceSafeBot(bot) {
  return {
    id: bot?.id ?? null,
    name: bot?.name ?? "",
    role: bot?.role ?? "",
    isMain: bot?.isMain === true,
    model: bot?.model ? bot.model : null,
  };
}

/** 设备可见的 run：去掉宿主 session 文件路径。 */
export function deviceSafeRun(run) {
  return without(run, ["sessionFile"]);
}

/** 设备可见的附件：去掉宿主落盘路径。 */
export function deviceSafeAttachment(attachment) {
  return without(attachment, ["path"]);
}

/** 设备可见的成果：去掉宿主快照/源文件路径。 */
export function deviceSafeArtifact(artifact) {
  return without(artifact, ["path", "root", "sourcePath"]);
}

/** 设备可见的事件：事件里嵌的 run/附件/成果同样剔除宿主路径。 */
export function deviceSafeEvent(evt) {
  if (!evt || typeof evt !== "object") return evt;
  let out = evt;
  if (out.run) out = { ...out, run: deviceSafeRun(out.run) };
  if (out.attachment) out = { ...out, attachment: deviceSafeAttachment(out.attachment) };
  if (out.artifact) out = { ...out, artifact: deviceSafeArtifact(out.artifact) };
  return out;
}

// ---- 二维码 ----

/** 用 qrcode 依赖生成 data: URL；依赖缺失/失败明确报 500，不假装有二维码。 */
export async function qrDataUrlFor(text) {
  let mod;
  try {
    mod = await import("qrcode");
  } catch (e) {
    throw mobileError(500, `qrcode 依赖不可用：${e?.message ?? e}`, "qr_unavailable");
  }
  const toDataURL = (mod?.default ?? mod)?.toDataURL;
  if (typeof toDataURL !== "function") throw mobileError(500, "qrcode 模块没有 toDataURL", "qr_unavailable");
  return await toDataURL(text, { type: "image/png", errorCorrectionLevel: "M", margin: 1, width: 320 });
}

// ---- APK ----

/** 开发版在 release/omp-bot-android.apk；打包版优先 resources/mobile/。找不到返回 null。 */
export function resolveMobileApk() {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "mobile", APK_FILENAME));
  }
  candidates.push(join(APP_ROOT, "release", APK_FILENAME));
  for (const p of candidates) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function matchDeviceRoute(segs, method) {
  let methodMiss = false;
  for (const r of DEVICE_ROUTES) {
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

// ---- 入口本体 ----

/**
 * 设备入口。生命周期由 startServer 装配：启动按持久化 opt-in 拉起，close() 与主服务一起关。
 */
export class MobileGateway {
  /**
   * @param {object} opts
   * @param {string} opts.home
   * @param {() => string|null} opts.loopbackBase 回环服务基址（listen 之后才有值）
   * @param {string} opts.ownerToken 进程 owner token：入口必须拒绝它，owner 身份不能借道
   * @param {string|null} [opts.apkPath]
   * @param {boolean} [opts.debug]
   */
  constructor({ home, loopbackBase, ownerToken, apkPath = null, debug = false }) {
    if (!home) throw new Error("MobileGateway 需要 home");
    if (typeof loopbackBase !== "function") throw new Error("MobileGateway 需要 loopbackBase()");
    this.home = home;
    this.loopbackBase = loopbackBase;
    this.ownerToken = ownerToken ?? null;
    this.apkPath = apkPath ?? null;
    this.debug = debug;
    this.config = defaultMobileConfig();
    this.lastError = null;
    this.running = false;
    this.server = null;
    this.boundPort = null;
    this.startedAt = null;
    try {
      this.config = readMobileConfig(home) ?? defaultMobileConfig();
    } catch (e) {
      // 配置坏了不静默当默认：入口保持关闭，把原因挂在 status.lastError 上。
      this.lastError = errorInfo(e, "mobile_config_invalid");
    }
  }

  /** 启动时按持久化配置拉起（只有用户曾经 opt-in 才开）。绑定失败只记 lastError，不阻断主服务。 */
  async startFromConfig() {
    if (!this.config.enabled) return;
    try {
      await this.#start();
    } catch (e) {
      this.#recordError(e);
    }
  }

  /** owner POST /api/mobile：合并、落盘、按新配置真实生效（运行中先停再起，端口/主机变化立即反映）。 */
  async apply(body = {}) {
    const next = mergeMobileConfig(body, this.config);
    writeMobileConfig(this.home, next);
    this.config = next;
    if (this.running) await this.#stop();
    if (next.enabled) {
      try {
        await this.#start();
      } catch (e) {
        this.#recordError(e);
      }
    } else {
      this.lastError = null;
    }
    return this.status();
  }

  status() {
    const port = this.running ? this.boundPort : this.config.port;
    return {
      enabled: this.config.enabled,
      running: this.running,
      host: this.config.host,
      port,
      addresses: mobileAddressEntries({ host: this.config.host, port, publicUrl: this.config.publicUrl }),
      lastError: this.lastError ? { ...this.lastError } : null,
      apk: this.#apkStatus(),
    };
  }

  /**
   * owner 签发配对邀请：地址必须来自当前实际广播列表；URL 里只有一次性配对码，没有长期凭证。
   * 入口没在运行时直接拒绝——签一个连不上的二维码是假功能。
   */
  async invitation(body = {}, { pairing } = {}) {
    if (!pairing?.create) throw mobileError(500, "配对服务不可用", "pairing_unavailable");
    if (!this.running) {
      throw mobileError(409, "手机入口未运行：先启用并确认 status.running 为 true 再签发邀请", "mobile_not_running");
    }
    const addresses = this.status().addresses;
    const want = typeof body.address === "string" ? body.address.trim().replace(/\/+$/, "") : "";
    const picked = addresses.find((a) => a.url.replace(/\/+$/, "") === want);
    if (!picked) {
      throw mobileError(
        400,
        `address 必须是当前广播地址之一：${addresses.map((a) => a.url).join("、") || "（当前没有可用地址）"}`,
        "mobile_address_invalid",
      );
    }
    if (body.ttlMs !== undefined && (!Number.isInteger(body.ttlMs) || body.ttlMs < 30_000 || body.ttlMs > 86_400_000)) {
      throw mobileError(400, "ttlMs 必须是 30000..86400000 的整数毫秒（上限 24 小时）", "mobile_ttl_invalid");
    }
    const created = pairing.create({
      botIds: body.botIds,
      permissions: body.permissions,
      label: body.label,
      ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    });
    const label = created.ticket.label ?? "";
    const nameParam = label ? `&name=${encodeURIComponent(label)}` : "";
    const url = `ompbot://pair?v=1&address=${encodeURIComponent(picked.url)}&code=${encodeURIComponent(created.code)}${nameParam}`;
    try {
      return { ticket: created.ticket, code: created.code, url, qrDataUrl: await qrDataUrlFor(url) };
    } catch (e) {
      // 二维码生成失败就把刚发的码撤回，不留一张 owner 看不见的孤儿票。
      try {
        pairing.revoke(created.ticket.id);
      } catch {}
      throw e;
    }
  }

  /** owner 侧 /api/mobile/apk：真实文件才发，没有就 404，绝不发占位。 */
  serveApk(res) {
    this.#streamApk(res, "手机 APK 尚未构建（release/omp-bot-android.apk 不存在）");
  }

  async close() {
    await this.#stop();
  }

  // ---- 内部 ----

  async #start() {
    if (this.running) return;
    const server = createServer((req, res) => {
      res.on("error", () => {});
      req.on("error", () => {});
      this.#handle(req, res).catch((e) => {
        if (this.debug) console.error("[mobile]", e);
        if (res.headersSent) {
          try {
            res.end();
          } catch {}
          return;
        }
        writeJson(res, e?.status ?? 500, { error: e?.message ?? String(e), ...(e?.code ? { code: e.code } : {}) });
      });
    });
    server.on("clientError", (_err, socket) => {
      try {
        socket.destroy();
      } catch {}
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, this.config.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.running = true;
    this.boundPort = server.address()?.port ?? this.config.port;
    this.startedAt = Date.now();
    this.lastError = null;
  }

  async #stop() {
    const server = this.server;
    this.server = null;
    this.running = false;
    this.boundPort = null;
    this.startedAt = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  #recordError(e) {
    this.lastError = errorInfo(e, "mobile_start_failed");
    if (this.debug) console.error("[mobile]", e);
  }

  #apkFile() {
    if (!this.apkPath) this.apkPath = resolveMobileApk();
    if (!this.apkPath) return null;
    try {
      return statSync(this.apkPath).isFile() ? this.apkPath : null;
    } catch {
      return null;
    }
  }

  #apkStatus() {
    const available = !!this.#apkFile();
    const out = { available, url: available ? "/api/mobile/apk" : null };
    const version = this.#apkVersion();
    if (version) out.version = version;
    return out;
  }

  /** APK 版本号：优先读 APK 旁的 omp-bot-android.json / metadata.json 的 version 字段；没有就省略。 */
  #apkVersion() {
    if (!this.apkPath) return null;
    const dir = dirname(this.apkPath);
    for (const name of ["omp-bot-android.json", "metadata.json"]) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
        const v = meta?.version ?? meta?.versionName;
        if (typeof v === "string" && v.trim()) return v.trim();
        if (Number.isFinite(v)) return String(v);
      } catch {}
    }
    return null;
  }

  #streamApk(res, missingMessage) {
    const path = this.#apkFile();
    if (!path) throw mobileError(404, missingMessage, "apk_unavailable");
    const st = statSync(path);
    res.writeHead(200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": st.size,
      "Content-Disposition": `attachment; filename="${APK_FILENAME}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const stream = createReadStream(path);
    stream.on("error", () => {
      try {
        res.destroy();
      } catch {}
    });
    stream.pipe(res);
  }

  async #handle(req, res) {
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith("/")) {
      writeJson(res, 400, { error: "只接受 origin-form 请求路径", code: "bad_path" });
      return;
    }
    // 浏览器指纹直接拒：设备端是原生 HTTP，不带 Origin / Sec-Fetch-*。
    if (req.headers.origin !== undefined) {
      writeJson(res, 403, { error: "设备入口不接受浏览器请求（带 Origin）", code: "gateway_origin_denied" });
      return;
    }
    if (Object.keys(req.headers).some((k) => k.startsWith("sec-fetch-"))) {
      writeJson(res, 403, { error: "设备入口不接受浏览器请求（Sec-Fetch-*）", code: "gateway_browser_denied" });
      return;
    }
    if (req.headers.cookie !== undefined) {
      writeJson(res, 403, { error: "设备入口不接受 Cookie（设备凭证只能是 Bearer token）", code: "gateway_cookie_denied" });
      return;
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
    if (bearer && this.ownerToken && secretEqual(bearer[1].trim(), this.ownerToken)) {
      writeJson(res, 403, { error: "设备入口拒绝 owner token（设备凭证只能是配对签发的 ompd_ token）", code: "gateway_owner_credential_denied" });
      return;
    }

    const qi = rawUrl.indexOf("?");
    const rawPath = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
    const segs = decodeSegments(rawPath);
    if (!segs) {
      writeJson(res, 400, { error: "路径不合法", code: "bad_path" });
      return;
    }
    const method = req.method ?? "GET";
    const { route, methodMiss } = matchDeviceRoute(segs, method);
    if (!route) {
      if (methodMiss) writeJson(res, 405, { error: `设备入口不允许的方法 ${method}`, code: "gateway_method_denied" });
      else writeJson(res, 404, { error: "设备入口不支持该路径", code: "gateway_route_denied" });
      return;
    }
    if (route.local === "health") {
      writeJson(res, 200, { name: "omp-bot", protocol: MOBILE_PROTOCOL });
      return;
    }
    if (route.local === "apk") {
      this.#streamApk(res, "手机 APK 尚未构建");
      return;
    }
    await this.#proxy(req, res, rawUrl);
  }

  async #proxy(req, res, rawUrl) {
    const base = this.loopbackBase();
    if (!base) throw mobileError(503, "回环服务尚未就绪", "loopback_unavailable");
    const target = new URL(base);
    const connectHost = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const headers = { host: target.host };
    for (const name of FORWARD_HEADERS) {
      const v = req.headers[name];
      if (v !== undefined) headers[name] = v;
    }
    const up = httpRequest(
      {
        host: connectHost,
        port: target.port ? Number(target.port) : 80,
        path: rawUrl,
        method: req.method,
        headers,
      },
      (upRes) => {
        const outHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k) || k === "set-cookie") continue;
          outHeaders[k] = v;
        }
        if (res.headersSent) {
          upRes.resume();
          return;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        if (String(upRes.headers["content-type"] ?? "").startsWith("text/event-stream")) res.flushHeaders?.();
        upRes.pipe(res);
        upRes.on("error", () => {
          try {
            res.destroy();
          } catch {}
        });
      },
    );
    up.on("error", (e) => {
      if (res.headersSent) {
        try {
          res.destroy();
        } catch {}
        return;
      }
      writeJson(res, 502, { error: `回环服务不可达：${e?.message ?? e}`, code: "gateway_upstream_unreachable" });
    });
    res.on("close", () => {
      if (!up.destroyed) up.destroy();
    });
    req.pipe(up);
  }
}

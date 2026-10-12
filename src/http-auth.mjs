// http-auth.mjs — HTTP 边界校验：本机 Host/Origin、进程 token、会话 cookie、路径与密钥。
// 只做判断，不做路由；server.mjs 调用。零依赖。

import { randomBytes, timingSafeEqual } from "node:crypto";

/** 进程随机凭证（32 字节 hex）。token 给 CLI/测试，sessionId 给浏览器 cookie。 */
export function newSecret() {
  return randomBytes(32).toString("hex");
}

/** 恒定时间比较；长度不同或空串直接 false。 */
export function secretEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length === 0 || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function hostNameAllowed(name, host) {
  const n = String(name).toLowerCase();
  if (n === "127.0.0.1" || n === "localhost" || n === "::1" || n === "[::1]") return true;
  return typeof host === "string" && host.toLowerCase() === n;
}

/**
 * Host 头必须是本机回环（或显式绑定 host）且端口等于本服务端口。
 * 挡 DNS rebinding：evil.com 解析到 127.0.0.1 时 Host 仍是 evil.com。
 */
export function hostOk(req, { port, host }) {
  const raw = req.headers.host;
  if (typeof raw !== "string" || !raw) return false;
  let u;
  try {
    u = new URL(`http://${raw}`);
  } catch {
    return false;
  }
  if (!hostNameAllowed(u.hostname, host)) return false;
  return (u.port ? Number(u.port) : 80) === port;
}

/**
 * 缺 Origin（CLI/非浏览器）放行；存在则必须同源回环同端口。
 * `Origin: null`（sandbox iframe / file）与 Sec-Fetch-Site: cross-site 一律拒绝。
 */
export function originOk(req, { port, host }) {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string" || origin === "" || origin === "null") return false;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!hostNameAllowed(u.hostname, host)) return false;
  const p = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return p === port;
}

/** 只有经过验证的顶层同源/回环导航才允许下发 session cookie。 */
export function bootstrapContextOk(req) {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site && site !== "same-origin" && site !== "none") return false;
  const mode = req.headers["sec-fetch-mode"];
  if (typeof mode === "string" && mode && mode !== "navigate") return false;
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string" && dest && dest !== "document") return false;
  return true;
}

/** mutation 只接受 JSON：挡 text/plain / form / 空 type 的跨站简单请求。 */
export function isJsonContentType(req) {
  const ct = req.headers["content-type"];
  if (typeof ct !== "string") return false;
  return /^\s*application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/i.test(ct);
}

export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(name, value) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict`;
}

/**
 * 严格拆路径：逐段解码后不得含分隔符、`.`/`..` 或 NUL；不合法返回 null。
 * 不解码整个 pathname，避免 %2f 伪造分段。
 */
export function decodeSegments(pathname) {
  if (typeof pathname !== "string" || pathname[0] !== "/") return null;
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  const out = [];
  for (const raw of pathname.split("/")) {
    if (raw === "") continue;
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null;
    out.push(seg);
  }
  return out;
}

// 精确命中（规范化后：小写、去掉 -_ 与空格）。
const SECRET_KEYS = new Set([
  "key",
  "apikey",
  "secret",
  "credential",
  "credentials",
  "token",
  "authorization",
  "auth",
  "cookie",
  "setcookie",
  "salt",
  "pwd",
]);

// 复合名里出现这些片段就是凭据（secretKey/clientSecret/appSecret/passwordHash/apiKeyId…）。
const SECRET_CONTAINS = ["secret", "credential", "apikey"];

// 这些后缀同样算凭据（refreshToken/authToken/privateKey/encryptKey/proxyAuth/sessionCookie…），
// 但 tokenBudget、totalTokens 这类度量不会被误伤。
const SECRET_SUFFIXES = ["token", "key", "auth", "cookie", "pwd", "salt"];

const normKey = (k) => k.toLowerCase().replace(/[-_\s]/g, "");

function isSecretKey(name) {
  const n = normKey(name);
  if (SECRET_KEYS.has(n)) return true;
  if (SECRET_CONTAINS.some((s) => n.includes(s))) return true;
  return SECRET_SUFFIXES.some((s) => n.endsWith(s));
}

/** 原生返回里剔除凭据字段（login/logout 等绝不回密钥），保留 tokenBudget 这类度量。 */
export function redactSecrets(value, depth = 0) {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretKey(k) ? "[redacted]" : redactSecrets(v, depth + 1);
  }
  return out;
}

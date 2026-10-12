// 边界：模型循环、压缩、技能、连接器、浏览器仍由 OMP 原生负责，这里不建第二套引擎。
//
// 投递语义（at-most-once，明确写出）：事件在回 200 之前先落一条 inbound 记录（去重标记），
// 之后才在内存队列里处理。因此「已确认但未跑完」在重启后只会显示为 interrupted，绝不自动重放；
// 飞书重投同一 event_id 会被去重拒绝。未配置 encryptKey 时只做 token 校验（官方该模式无签名），
// status().inbound.signatureMode 会如实暴露 token-only。

import { createServer } from "node:http";
import { createHash, createDecipheriv, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_PERMISSIONS, DEFAULT_DEVICE_PERMISSIONS } from "./pairing.mjs";

/** 通道配置文件（home 下，0600），或改用 *Env 引用环境变量。不用第二套密钥库。 */
export const CHANNEL_CONFIG_FILE = "channels.feishu.json";

const MAX_SKEW_DEFAULT_MS = 5 * 60 * 1000;
const MAX_BODY_DEFAULT = 256 * 1024;
const INBOUND_KEEP = 500;
const INBOUND_PREFIX = "feishu_inbound_";

/**
 * 原生审批选项的分类词表。只做精确匹配（归一化后全等），不做包含/模糊：
 * 多义或匹配不到时宁可要求去网页端点击，也不猜用户意图。
 */
const APPROVE_WORDS = new Set([
  "approve", "allow", "yes", "ok", "accept", "confirm", "批准", "允许", "同意", "确认", "是",
]);
const DENY_WORDS = new Set(["deny", "reject", "no", "refuse", "block", "拒绝", "否", "不允许"]);

const HELP_TEXT =
  "可用指令：/run <bot> <任务内容>；/cancel <runId>；/approve <审批id> allow|deny；/help";

export class ChannelsError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = "ChannelsError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const isLoopback = (host) => ["127.0.0.1", "::1", "localhost"].includes(String(host));

function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 飞书回调签名：sha256(timestamp + nonce + encryptKey + 原始请求体)。 */
export function sha256hex({ timestamp, nonce, encryptKey, rawBody }) {
  return createHash("sha256")
    .update(String(timestamp ?? "") + String(nonce ?? "") + String(encryptKey ?? "") + String(rawBody ?? ""))
    .digest("hex");
}

/**
 * 飞书加密回调：`{encrypt: base64}`，AES-256-CBC，key = sha256(encryptKey)，
 * 密文前 16 字节为 IV，PKCS#7 填充。未配置 encryptKey 或体未加密时原样返回。
 */
export function decryptCallback(payload, encryptKey) {
  if (!encryptKey) return payload;
  const enc = payload?.encrypt;
  if (typeof enc !== "string" || !enc) return payload;
  try {
    const key = createHash("sha256").update(encryptKey).digest();
    const buf = Buffer.from(enc, "base64");
    if (buf.length < 32) throw new Error("密文过短");
    const decipher = createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
    const out = Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]);
    return JSON.parse(out.toString("utf8"));
  } catch (e) {
    throw new ChannelsError("FEISHU_DECRYPT_FAILED", `回调解密失败：${e.message}`, 400);
  }
}

function normalizeIdentities(list) {
  if (!Array.isArray(list)) {
    throw new ChannelsError("FEISHU_BAD_CONFIG", "identities 必须是数组", 400);
  }
  return list.map((entry, i) => {
    const openId = String(entry?.openId ?? "").trim();
    const chatId = String(entry?.chatId ?? "").trim();
    if (!openId || !chatId) {
      throw new ChannelsError("FEISHU_BAD_CONFIG", `identities[${i}] 需要 openId 与 chatId`, 400);
    }
    const botIds = (Array.isArray(entry.botIds) ? entry.botIds : [entry.botIds])
      .map((b) => String(b ?? "").trim())
      .filter(Boolean);
    if (!botIds.length) {
      throw new ChannelsError("FEISHU_BAD_CONFIG", `identities[${i}] 必须显式列出 botIds`, 400);
    }
    let permissions = [...DEFAULT_DEVICE_PERMISSIONS];
    if (entry.permissions !== undefined) {
      if (!Array.isArray(entry.permissions)) {
        throw new ChannelsError("FEISHU_BAD_CONFIG", `identities[${i}].permissions 必须是数组`, 400);
      }
      permissions = [...new Set(entry.permissions.map((p) => String(p).trim().toLowerCase()).filter(Boolean))];
      const bad = permissions.filter((p) => !DEVICE_PERMISSIONS.includes(p));
      if (bad.length || !permissions.length) {
        throw new ChannelsError(
          "FEISHU_BAD_CONFIG",
          `identities[${i}].permissions 非法：${bad.join(", ") || "空"}（只允许 ${DEVICE_PERMISSIONS.join("/")}）`,
          400,
        );
      }
    }
    return { key: `${openId}:${chatId}`, openId, chatId, botIds, permissions, label: String(entry.label ?? "") };
  });
}

/** 归一化 + 校验配置；缺省值安全（enabled 默认 false，host 默认回环）。 */
export function normalizeChannelConfig(config = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ChannelsError("FEISHU_BAD_CONFIG", "通道配置必须是对象", 400);
  }
  const env = (name) => (name ? process.env[name] : undefined);
  const port = Number(config.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ChannelsError("FEISHU_BAD_CONFIG", `port 非法：${config.port}`, 400);
  }
  const path = String(config.path ?? "/api/channels/feishu/events");
  if (!path.startsWith("/")) throw new ChannelsError("FEISHU_BAD_CONFIG", "path 必须以 / 开头", 400);
  const maxSkewMs = Number(config.maxSkewMs ?? MAX_SKEW_DEFAULT_MS);
  if (!Number.isFinite(maxSkewMs) || maxSkewMs < 0) {
    throw new ChannelsError("FEISHU_BAD_CONFIG", "maxSkewMs 必须是非负数", 400);
  }
  const host = String(config.host ?? "127.0.0.1");
  if (!isLoopback(host) && config.allowNonLoopback !== true) {
    throw new ChannelsError(
      "FEISHU_REMOTE_BIND_REFUSED",
      `拒绝绑定非回环地址 ${host}：远端接入需显式设置 allowNonLoopback=true 并自备 HTTPS 反向代理，本服务不会自动建隧道`,
      400,
    );
  }
  return {
    enabled: config.enabled === true,
    host,
    port,
    path,
    apiBase: String(config.apiBase ?? "https://open.feishu.cn"),
    appId: String(config.appId ?? ""),
    appSecret: config.appSecret ?? env(config.appSecretEnv),
    appSecretEnv: config.appSecretEnv ? String(config.appSecretEnv) : null,
    verificationToken: config.verificationToken ?? env(config.verificationTokenEnv),
    verificationTokenEnv: config.verificationTokenEnv ? String(config.verificationTokenEnv) : null,
    encryptKey: config.encryptKey ?? env(config.encryptKeyEnv),
    encryptKeyEnv: config.encryptKeyEnv ? String(config.encryptKeyEnv) : null,
    identities: normalizeIdentities(config.identities ?? []),
    maxSkewMs,
    maxBodyBytes: Number.isFinite(config.maxBodyBytes) ? config.maxBodyBytes : MAX_BODY_DEFAULT,
    allowNonLoopback: config.allowNonLoopback === true,
    fetchImpl: config.fetchImpl ?? globalThis.fetch,
    now: typeof config.now === "function" ? config.now : () => Date.now(),
  };
}

/** 读取 home 下的通道配置（不存在返回 null）。密钥只落在这种私有文件或环境变量里。 */
export function readChannelConfig(home, { file = CHANNEL_CONFIG_FILE } = {}) {
  const target = join(home, file);
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, "utf8"));
}

/** 写通道配置（0600；Windows 上 mode 仅尽力而为）。 */
export function writeChannelConfig(home, config, { file = CHANNEL_CONFIG_FILE } = {}) {
  mkdirSync(home, { recursive: true });
  const target = join(home, file);
  writeFileSync(target, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(target, 0o600);
  } catch {}
  return target;
}

/** 事件身份键：open_id + chat_id，必须精确命中 identities 配置。接受 v2 回调外层或 event 本体。 */
export function identityKeyOf(event) {
  const ev = event?.event ?? event;
  const openId = String(ev?.sender?.sender_id?.open_id ?? "");
  const chatId = String(ev?.message?.chat_id ?? "");
  return `${openId}:${chatId}`;
}

function resolveBotRef(ref, bots) {
  const q = String(ref ?? "").trim().toLowerCase();
  return (
    bots.find((b) => b.id === ref) ??
    bots.find((b) => String(b.name ?? "").toLowerCase() === q) ??
    null
  );
}

/**
 * 纯函数：把一条已认证的 IM 文本映射成动作。
 * 身份缺 run（发起/取消）或 approve（回答审批）权限时直接给 forbidden，不做任何推断升级。
 */
export function planCommand({ text, chatType = "p2p", identity, bots = [] } = {}) {
  if (!identity) throw new ChannelsError("FEISHU_IDENTITY_UNKNOWN", "该会话身份未授权", 403);
  const perms = identity.permissions ?? [];
  const raw = String(text ?? "").trim();
  const stripped = raw.replace(/@_user_\d+/g, "").trim();

  const m = /^\/([a-zA-Z_]+)(?:\s+([\s\S]*))?$/.exec(stripped);
  if (m) {
    const cmd = m[1].toLowerCase();
    const rest = (m[2] ?? "").trim();
    if (cmd === "help") return { kind: "help" };
    if (cmd === "run" || cmd === "ask") {
      if (!perms.includes("run")) return { kind: "error", reason: "该身份没有 run 权限", forbidden: true };
      const sp = rest.indexOf(" ");
      const ref = sp < 0 ? rest : rest.slice(0, sp);
      const task = sp < 0 ? "" : rest.slice(sp + 1).trim();
      if (!ref || !task) return { kind: "error", reason: "用法：/run <bot> <任务内容>" };
      const bot = resolveBotRef(ref, bots);
      if (!bot) return { kind: "error", reason: `找不到 bot「${ref}」` };
      if (!identity.botIds.includes(bot.id)) {
        return { kind: "error", reason: `该身份未被授权操作 bot ${bot.name ?? bot.id}`, forbidden: true };
      }
      return { kind: "run", botId: bot.id, botName: bot.name, text: task };
    }
    if (cmd === "cancel") {
      if (!perms.includes("run")) return { kind: "error", reason: "该身份没有取消权限", forbidden: true };
      if (!rest) return { kind: "error", reason: "用法：/cancel <runId>" };
      return { kind: "cancel", runId: rest };
    }
    if (cmd === "approve") {
      if (!perms.includes("approve")) {
        return { kind: "error", reason: "该身份没有审批权限（approve 必须由 owner 显式单独授予）", forbidden: true };
      }
      const [id, decision = ""] = rest.split(/\s+/);
      const allow = ["allow", "yes", "ok", "approve", "允许", "批准"].includes(decision.toLowerCase());
      const deny = ["deny", "no", "reject", "拒绝"].includes(decision.toLowerCase());
      if (!id || (!allow && !deny)) {
        return { kind: "error", reason: "用法：/approve <审批id> allow|deny" };
      }
      return { kind: "approve", approvalId: id, allow };
    }
    return { kind: "error", reason: `未知指令 /${cmd}。${HELP_TEXT}` };
  }

  if (chatType === "p2p" && stripped) {
    if (!perms.includes("run")) return { kind: "error", reason: "该身份没有 run 权限", forbidden: true };
    const botId = identity.botIds[0];
    const bot = bots.find((b) => b.id === botId) ?? { id: botId, name: botId };
    return { kind: "run", botId, botName: bot.name, text: stripped };
  }
  return { kind: "ignore", reason: chatType === "p2p" ? "空消息" : "群聊只处理 /run /cancel /approve /help 指令" };
}

/** 归一化选项文本：小写、去首尾空白与结尾标点。只用于精确词表比对。 */
function normOption(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.。!！:：]+$/, "")
    .trim();
}

/** 把选项归类为 approve / deny / other；同时命中两类一律按 other 处理（不猜）。 */
function classifyOption(label, raw) {
  let hasA = false;
  let hasD = false;
  for (const candidate of [normOption(label), normOption(typeof raw === "string" ? raw : raw?.value ?? raw?.label)]) {
    if (!candidate) continue;
    if (APPROVE_WORDS.has(candidate)) hasA = true;
    if (DENY_WORDS.has(candidate)) hasD = true;
  }
  if (hasA === hasD) return "other";
  return hasA ? "approve" : "deny";
}

/**
 * select 类审批里挑出唯一无歧义的那个选项原串。
 * @returns {string|null} null = 没有唯一命中（选项为空、多个命中、含混），调用方必须要求网页端回答
 */
function pickSelectOption(rec, allow) {
  const options = Array.isArray(rec?.options) ? rec.options : [];
  const details = Array.isArray(rec?.optionDetails) ? rec.optionDetails : [];
  if (!options.length) return null;
  const wanted = allow ? "approve" : "deny";
  const hits = options
    .map((raw, i) => {
      const value = typeof raw === "string" ? raw : raw?.value ?? raw?.label ?? "";
      const detail = details[i] ?? {};
      const label = detail.label ?? detail.text ?? value;
      return { value: String(value ?? ""), kind: classifyOption(label, raw) };
    })
    .filter((o) => o.kind === wanted && o.value);
  if (hits.length !== 1) return null;
  return hits[0].value;
}

/**
 * 按原生 method 生成 answerUi 的应答体。
 * confirm → {confirmed:boolean}；select → {value: options 里的精确原串}；
 * ask/input/secret/未知方法或多义选项 → 抛 FEISHU_MANUAL_UI_REQUIRED（要求在工作台网页端回答），
 * 绝不替用户挑 recommended 或第一项。
 */
export function approvalResponse(rec, allow) {
  const method = rec?.method ?? null;
  if (method === "confirm") return { confirmed: !!allow };
  if (method === "select") {
    const value = pickSelectOption(rec, allow);
    if (value) return { value };
    const options = (rec?.options ?? []).map((o) => String(typeof o === "string" ? o : o?.value ?? o?.label ?? ""));
    throw new ChannelsError(
      "FEISHU_MANUAL_UI_REQUIRED",
      `无法从 IM 唯一确定「${allow ? "批准" : "拒绝"}」对应的选项${options.length ? `（可选：${options.join(" | ")}）` : ""}，请在工作台网页端回答`,
      409,
    );
  }
  throw new ChannelsError(
    "FEISHU_MANUAL_UI_REQUIRED",
    `该请求不是原生授权选项（method=${method ?? "unknown"}），需在工作台网页端回答`,
    409,
  );
}

export class FeishuBridge {
  /**
   * @param {object} opts
   * @param {object} opts.orch 需要 orch.ledger、orch.startRun/waitRun/getRun/cancelRun/answerUi、listBots
   * @param {object} [opts.config] 见 normalizeChannelConfig；缺省 = 明确禁用
   */
  constructor({ orch, config = {} } = {}) {
    if (!orch) throw new Error("FeishuBridge 需要 orch");
    this.orch = orch;
    this.config = normalizeChannelConfig(config);
    this.identities = new Map(this.config.identities.map((i) => [i.key, i]));
    this.server = null;
    this.port = null;
    this.started = false;
    this.pending = new Set();
    this.inflight = new Map();
    this.tokenCache = null;
    this.lastError = null;
    this.seen = 0;
    this.recovered = 0;
  }

  #now() {
    return this.config.now();
  }

  #ledger() {
    const l = this.orch?.ledger;
    if (!l) throw new Error("FeishuBridge 需要 orch.ledger（Ledger 尚未接入 Orchestrator）");
    return l;
  }

  /** 启动前缺什么（可执行清单）。 */
  missing() {
    const c = this.config;
    const out = [];
    if (!c.verificationToken) out.push("verificationToken（或 verificationTokenEnv）");
    if (!c.identities.length) out.push("identities（open_id+chat_id → botIds）");
    return out;
  }

  /** 出站缺什么（不影响入站，但发送会返回可执行错误）。 */
  outboundMissing() {
    const c = this.config;
    const out = [];
    if (!c.appId) out.push("appId");
    if (!c.appSecret) out.push("appSecret（或 appSecretEnv）");
    return out;
  }

  /** 只读状态：显示「是否配置」，永不回显密钥。 */
  status() {
    const c = this.config;
    const running = this.started && !!this.server;
    return {
      enabled: c.enabled,
      receiver: {
        running,
        host: c.host,
        port: this.port ?? c.port,
        path: c.path,
        url: running ? `http://${c.host === "::1" ? "[::1]" : c.host}:${this.port}${c.path}` : null,
        loopbackOnly: isLoopback(c.host),
        remoteHint: isLoopback(c.host)
          ? null
          : "已显式允许非回环绑定：远端接入请自备 HTTPS 反向代理与访问控制，本服务不建隧道",
      },
      inbound: {
        verificationTokenConfigured: !!c.verificationToken,
        encryptKeyConfigured: !!c.encryptKey,
        signatureRequired: !!c.encryptKey,
        signatureMode: c.encryptKey ? "signed" : "token-only",
        signatureWarning: c.encryptKey
          ? null
          : "未配置 encryptKey：该模式下飞书不提供签名，仅用 verificationToken 认证，时间戳/重放窗口不生效；该 token 泄漏即可伪造身份，请尽快配置 encryptKey",
        identities: this.identities.size,
        maxSkewMs: c.maxSkewMs,
        seenEvents: this.seen,
        events: this.#inboundStats(),
        interruptedOnStartup: this.recovered,
        delivery: "at-most-once：先落 inbound 记录再回 200，重启后未完成的只标 interrupted，不自动重放",
      },
      outbound: {
        configured: !!(c.appId && c.appSecret),
        appId: c.appId || null,
        secretSource: c.appSecretEnv ? `env:${c.appSecretEnv}` : c.appSecret ? "config" : "none",
        apiBase: c.apiBase,
      },
      missing: c.enabled ? this.missing() : [],
      configuration: {
        host: c.host, port: c.port, path: c.path,
        appId: c.appId, appSecretEnv: c.appSecretEnv,
        verificationTokenEnv: c.verificationTokenEnv, encryptKeyEnv: c.encryptKeyEnv,
        identities: [...this.identities.values()].map(({ openId, chatId, botIds, permissions, label }) =>
          ({ openId, chatId, botIds: [...botIds], permissions: [...permissions], label })),
      },
      outboundMissing: this.outboundMissing(),
      lastError: this.lastError,
    };
  }

  /** 显式开关：关闭时真的关掉 receiver 并释放端口。 */
  async setEnabled(flag) {
    this.config.enabled = flag === true;
    if (!this.config.enabled) await this.close();
    return this.status();
  }

  /** 启动 receiver。禁用时只返回状态，不 bind、不建隧道。 */
  async start() {
    if (this.started) return this.status();
    const c = this.config;
    if (!c.enabled) return this.status();
    const missing = this.missing();
    if (missing.length) {
      throw new ChannelsError(
        "FEISHU_NOT_CONFIGURED",
        `飞书入站未启用：缺少 ${missing.join("、")}。补齐后重试（可用环境变量引用，不要把密钥写进仓库）`,
        503,
      );
    }
    if (!c.appSecret && !c.appSecretEnv) {
      // 入站可独立工作，但状态里明确标出站未配置，避免以为闭环已通。
      this.lastError = { at: this.#now(), code: "FEISHU_OUTBOUND_NOT_CONFIGURED", message: "出站未配置：结果无法回发飞书" };
    }
    const server = createServer((req, res) => this.#onRequest(req, res));
    await new Promise((resolve, reject) => {
      const onError = (e) => reject(new ChannelsError("FEISHU_LISTEN_FAILED", `receiver 启动失败：${e.message}`, 500));
      server.once("error", onError);
      server.listen(c.port, c.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    this.port = server.address()?.port ?? c.port;
    this.started = true;
    this.recovered = this.#reconcileInbound();
    return this.status();
  }

  /** 关闭 receiver：停止监听、断开存量连接；在飞处理最多等 2s，不让长 Run 卡住关闭。 */
  async close() {
    const server = this.server;
    this.server = null;
    this.started = false;
    this.tokenCache = null;
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    }
    await Promise.race([this.drain(), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    return this.status();
  }

  /** 等待所有已排队的入站处理结束（测试与优雅关闭用）。 */
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** 配置自检。live=true 才发真实请求（本地 fixture 或真实飞书）；默认只做静态检查。 */
  async test({ live = false } = {}) {
    const c = this.config;
    const checks = [
      { name: "enabled", ok: c.enabled, detail: c.enabled ? "已启用" : "config.enabled 未设为 true" },
      { name: "inbound-config", ok: this.missing().length === 0, detail: this.missing().join("、") || "ok" },
      { name: "identities", ok: this.identities.size > 0, detail: `${this.identities.size} 条映射` },
      { name: "receiver", ok: this.started, detail: this.started ? `监听 ${this.status().receiver.url}` : "未启动" },
      {
        name: "outbound-config",
        ok: this.outboundMissing().length === 0,
        detail: this.outboundMissing().join("、") || "ok",
      },
    ];
    if (live) {
      if (this.outboundMissing().length) {
        checks.push({ name: "outbound-token", ok: false, detail: `缺少 ${this.outboundMissing().join("、")}，未发起请求` });
      } else {
        try {
          await this.#tenantToken();
          checks.push({ name: "outbound-token", ok: true, detail: `${c.apiBase} 鉴权成功` });
        } catch (e) {
          checks.push({ name: "outbound-token", ok: false, detail: `${e.code}: ${e.message}` });
        }
      }
    }
    return { ok: checks.every((x) => x.ok), checks };
  }

  // ---- 入站 ----

  #onRequest(req, res) {
    const c = this.config;
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {}
    const fail = (status, code, message) => {
      if (res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ code, msg: message }));
    };
    if (req.method !== "POST" || pathname !== c.path) return fail(404, 404, "not found");
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > c.maxBodyBytes) {
        fail(413, 413, "回调体过大");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => fail(400, 400, "读取回调体失败"));
    req.on("end", () => {
      let result;
      try {
        result = this.handleCallback(Buffer.concat(chunks).toString("utf8"), req.headers);
      } catch (e) {
        // 监听器里逸出的异常会变成 uncaughtException 带走整个宿主进程：这里兜底并回 5xx 让飞书重投。
        result = this.#intakeFailure(e);
      }
      if (res.writableEnded) return;
      res.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result.body));
    });
  }

  /** 入站处理本身出错（多为 Ledger 不可写/已关闭）：记 lastError 并回 5xx，绝不假装已确认。 */
  #intakeFailure(e) {
    const message = `入站处理失败，未确认（等飞书重投）：${e?.message ?? String(e)}`;
    this.lastError = { at: this.#now(), code: e?.code ?? "FEISHU_INTAKE_FAILED", message };
    return { status: 503, body: { code: "FEISHU_DURABLE_WRITE_FAILED", msg: message } };
  }

  /**
   * 处理一份原始回调体（receiver 与测试共用）。返回 HTTP 状态与响应体；
   * 需要跑 Run 的副作用只排队，不阻塞响应。
   */
  handleCallback(rawBody, headers = {}) {
    const c = this.config;
    const raw = typeof rawBody === "string" ? rawBody : (rawBody ?? Buffer.alloc(0)).toString("utf8");
    const reject = (status, code, message) => {
      if (status >= 400) this.lastError = { at: this.#now(), code, message };
      return { status, body: { code, msg: message } };
    };
    if (!c.verificationToken) return reject(503, "FEISHU_NOT_CONFIGURED", "未配置 verificationToken，拒绝回调");

    if (c.encryptKey) {
      const timestamp = String(headers["x-lark-request-timestamp"] ?? "");
      const nonce = String(headers["x-lark-request-nonce"] ?? "");
      const signature = String(headers["x-lark-signature"] ?? "");
      const expect = sha256hex({ timestamp, nonce, encryptKey: c.encryptKey, rawBody: raw });
      if (!safeEqualStr(expect, signature)) return reject(401, "FEISHU_BAD_SIGNATURE", "回调签名校验失败");
      const ts = Number(timestamp);
      if (!Number.isFinite(ts)) return reject(400, "FEISHU_STALE_REPLAY", "缺少可校验的 X-Lark-Request-Timestamp");
      const skew = Math.abs(this.#now() - ts);
      if (c.maxSkewMs && skew > c.maxSkewMs) {
        return reject(
          400,
          "FEISHU_STALE_REPLAY",
          `回调时间戳偏差 ${Math.round(skew / 1000)}s 超过上限 ${Math.round(c.maxSkewMs / 1000)}s，按重放拒绝`,
        );
      }
    }

    let payload;
    try {
      payload = decryptCallback(JSON.parse(raw), c.encryptKey);
    } catch (e) {
      return reject(400, "FEISHU_BAD_PAYLOAD", `回调体解析失败：${e.message}`);
    }
    const header = payload?.header ?? {};
    // v2 事件把 token 放在 header，URL 校验回包放在顶层；两者都接受。
    const token = payload?.token ?? header.token ?? "";
    if (!safeEqualStr(token, c.verificationToken)) {
      return reject(401, "FEISHU_BAD_TOKEN", "回调 verification token 不匹配");
    }
    if (payload?.type === "url_verification") {
      return { status: 200, body: { challenge: String(payload.challenge ?? "") } };
    }
    const eventId = String(header.event_id ?? "");
    if (!eventId) return reject(400, "FEISHU_NO_EVENT_ID", "回调缺少 header.event_id，无法去重");
    if (header.event_type !== "im.message.receive_v1") {
      return { status: 200, body: { code: 0, msg: `ignored ${header.event_type ?? "unknown"}` } };
    }
    const event = payload.event ?? {};
    const identity = this.identities.get(identityKeyOf(event));
    if (!identity) {
      // 未映射身份：明确拒绝，不进队列、不建 Run、不回执。
      return reject(
        403,
        "FEISHU_IDENTITY_UNKNOWN",
        `未授权会话 open_id+chat_id=${identityKeyOf(event)}，拒绝处理`,
      );
    }
    // 先持久登记再回 200：写入失败就回 5xx（让飞书重投），绝不在没记住的情况下确认为已接收。
    let claim;
    try {
      claim = this.#claimInbound({ eventId, chatId: String(event?.message?.chat_id ?? ""), identity });
    } catch (e) {
      this.lastError = { at: this.#now(), code: "FEISHU_DURABLE_WRITE_FAILED", message: e?.message ?? String(e) };
      return reject(503, "FEISHU_DURABLE_WRITE_FAILED", `入站事件未能落库（${e?.message ?? e}），未确认，等飞书重投`);
    }
    if (claim.duplicate) return { status: 200, body: { code: 0, msg: "duplicate ignored" } };
    this.#queue(() => this.#handleInbound(claim.record, event, identity));
    return { status: 200, body: { code: 0 } };
  }

  /**
   * 持久登记一条入站事件（同时是 event_id 去重标记）：status='accepted' + 之后的 runId。
   * 有界：只保留最近 INBOUND_KEEP 条。`accepted` 而进程退出 = 未完成，启动时改标 interrupted，不重放。
   * @returns {{duplicate:boolean, record?:object}}
   */
  #claimInbound({ eventId, chatId, identity }) {
    const ledger = this.#ledger();
    const id = INBOUND_PREFIX + createHash("sha256").update(eventId).digest("hex").slice(0, 32);
    const prev = ledger.get("settings", id);
    if (prev) return { duplicate: true };
    const now = this.#now();
    const record = {
      id,
      type: "feishu_inbound",
      eventId,
      chatId,
      identity: identity.key,
      status: "accepted",
      action: null,
      runId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    ledger.put("settings", record);
    this.seen += 1;
    const rows = ledger.list("settings", { limit: 1000 }).filter((r) => r.type === "feishu_inbound");
    for (const old of rows.slice(INBOUND_KEEP)) ledger.remove("settings", old.id);
    return { duplicate: false, record };
  }

  /** 处理结束：把入站记录落到终态（best-effort；失败记 lastError，不掩盖）。 */
  #finishInbound(record, patch) {
    try {
      this.#ledger().put("settings", { ...record, ...patch, updatedAt: this.#now() });
    } catch (e) {
      this.lastError = {
        at: this.#now(),
        code: "FEISHU_INBOUND_PERSIST_FAILED",
        message: `入站记录 ${record.id} 终态未能落库：${e?.message ?? e}`,
      };
    }
  }

  /** 启动时把上次没跑完的 accepted 记录标成 interrupted；返回条数。绝不重放。 */
  #reconcileInbound() {
    const rows = this.#ledger()
      .list("settings", { limit: 1000 })
      .filter((r) => r.type === "feishu_inbound" && r.status === "accepted");
    for (const rec of rows) {
      this.#finishInbound(rec, {
        status: "interrupted",
        error: "进程在确认事件后、处理完成前退出；不自动重放（飞书重投会被去重拒绝）",
      });
    }
    return rows.length;
  }

  /** 入站事件状态统计（直接读账本，≤INBOUND_KEEP 条，供诊断显示，不是占位值）。 */
  #inboundStats() {
    const stats = { total: 0, accepted: 0, completed: 0, failed: 0, interrupted: 0 };
    let rows = [];
    try {
      rows = this.#ledger().list("settings", { limit: 1000 }).filter((r) => r.type === "feishu_inbound");
    } catch (e) {
      return { ...stats, error: `无法读取入站记录：${e?.message ?? e}` };
    }
    for (const r of rows) {
      stats.total += 1;
      if (r.status === "accepted") stats.accepted += 1;
      else if (r.status === "completed") stats.completed += 1;
      else if (r.status === "failed") stats.failed += 1;
      else if (r.status === "interrupted") stats.interrupted += 1;
    }
    return stats;
  }

  /** 入站队列：异常不逸出，记 lastError + 入站记录终态。 */
  async #handleInbound(record, event, identity) {
    try {
      const outcome = await this.#onMessage(record, event, identity);
      this.#finishInbound(record, { status: "completed", action: outcome.action, runId: outcome.runId ?? null });
    } catch (e) {
      this.#finishInbound(record, { status: "failed", error: e?.message ?? String(e) });
      throw e;
    }
  }

  #queue(fn) {
    const p = Promise.resolve()
      .then(fn)
      .catch((e) => {
        this.lastError = { at: this.#now(), code: e?.code ?? "FEISHU_HANDLER_ERROR", message: e?.message ?? String(e) };
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async #onMessage(record, event, identity) {
    const msg = event.message ?? {};
    const chatId = String(msg.chat_id ?? "");
    const chatType = String(msg.chat_type ?? "p2p");
    let text = "";
    if (msg.message_type === "text") {
      try {
        text = String(JSON.parse(msg.content ?? "{}").text ?? "");
      } catch {
        text = "";
      }
    }
    const bots = this.orch.listBots?.() ?? [];
    const plan = planCommand({ text, chatType, identity, bots });
    if (plan.kind === "ignore") return { action: "ignore", runId: null };
    if (plan.kind === "run") return this.#startRun(identity, chatId, plan);
    if (plan.kind === "cancel") return this.#cancel(identity, chatId, plan);
    if (plan.kind === "approve") return this.#approve(identity, chatId, plan);
    // help / error：直接回执，不建 Run。
    await this.#deliver({ chatId, key: `msg_${record.eventId}`, text: plan.kind === "help" ? HELP_TEXT : plan.reason });
    return { action: plan.kind, runId: null };
  }

  async #startRun(identity, chatId, plan) {
    const source = `feishu:${identity.key}`;
    let run;
    try {
      run = await this.orch.startRun({ botId: plan.botId, text: plan.text, kind: "chat", source });
    } catch (e) {
      await this.#deliver({ chatId, key: `err_${identity.key}_${this.#now()}`, text: `无法发起任务：${e.message}` });
      return { action: "run_rejected", runId: null };
    }
    let text;
    try {
      const done = await this.orch.waitRun(run.id);
      text =
        done?.reply ||
        (done?.state === "completed" ? "（空回复）" : `任务结束（${done?.state}）：${done?.error ?? "无详情"}`);
    } catch (e) {
      text = `任务失败：${e.message}`;
    }
    await this.#deliver({ chatId, key: `run_${run.id}`, runId: run.id, text });
    return { action: "run", runId: run.id };
  }

  async #cancel(identity, chatId, plan) {
    const run = this.orch.getRun?.(plan.runId);
    if (!run) {
      await this.#deliver({ chatId, key: `cancel_${plan.runId}_${this.#now()}`, text: `找不到 Run ${plan.runId}` });
      return { action: "cancel_missing", runId: null };
    }
    if (!identity.botIds.includes(run.botId)) {
      await this.#deliver({
        chatId,
        key: `cancel_${run.id}`,
        text: `该身份未被授权操作 bot ${run.botId}，拒绝取消`,
      });
      return { action: "cancel_forbidden", runId: run.id };
    }
    try {
      const r = await this.orch.cancelRun(run.id, `feishu:${identity.key}`);
      await this.#deliver({
        chatId,
        key: `cancel_${run.id}`,
        runId: run.id,
        text: `已请求取消 Run ${run.id}（accepted=${r?.accepted ?? false}）`,
      });
      return { action: "cancel", runId: run.id };
    } catch (e) {
      await this.#deliver({ chatId, key: `cancel_${run.id}`, text: `取消失败：${e.message}` });
      return { action: "cancel_failed", runId: run.id };
    }
  }

  async #approve(identity, chatId, plan) {
    const ledger = this.#ledger();
    const approval = ledger.get("approvals", plan.approvalId);
    const refuse = async (text, action) => {
      await this.#deliver({ chatId, key: `approve_${plan.approvalId}_${this.#now()}`, text });
      return { action, runId: null };
    };
    if (!approval) return refuse(`找不到待审批 ${plan.approvalId}`, "approve_missing");
    const run = this.orch.getRun?.(approval.runId);
    if (!run) return refuse(`审批 ${plan.approvalId} 对应的 Run 不存在或已清理`, "approve_missing_run");
    // 只有发起该 Run 的同一身份能回答，其他群成员一律拒绝。
    if (run.source !== `feishu:${identity.key}`) {
      return refuse(`拒绝：审批 ${plan.approvalId} 属于其他身份发起的 Run，不能代为回答`, "approve_foreign_run");
    }
    if (!identity.botIds.includes(run.botId)) return refuse(`该身份未被授权操作 bot ${run.botId}`, "approve_out_of_scope");
    // 应答形状必须匹配原生 method：多义/非授权方法要求去网页端回答，绝不猜。
    let response;
    try {
      response = approvalResponse(approval, plan.allow);
    } catch (e) {
      return refuse(`无法从 IM 回答审批 ${plan.approvalId}：${e.message}`, "approve_manual_ui_required");
    }
    const shape = response.confirmed === undefined ? `选项「${response.value}」` : `confirmed=${response.confirmed}`;
    try {
      await this.orch.answerUi(plan.approvalId, response);
      await this.#deliver({
        chatId,
        key: `approve_${plan.approvalId}`,
        runId: run.id,
        text: `已${plan.allow ? "批准" : "拒绝"}审批 ${plan.approvalId}（${shape}）`,
      });
      return { action: "approve", runId: run.id };
    } catch (e) {
      return refuse(`回答审批失败：${e.message}`, "approve_failed");
    }
  }

  // ---- 出站 ----

  /**
   * 回执：先写 outbox（pending），发送后更新终态。
   * outbox id 稳定 → 同一事件重放不会重复发送；已 sent/unknown 直接跳过，同时在飞的同一 id 复用。
   * ponytail: Feishu 没有对外幂等键，网络中断后的「未知」状态不自动重试，需人工核对。
   */
  async #deliver({ chatId, key, runId = null, text }) {
    const id = `out_feishu_${key}`.slice(0, 180);
    const prev = this.#ledger().get("outbox", id);
    if (prev && (prev.status === "sent" || prev.status === "unknown")) return prev;
    const running = this.inflight.get(id);
    if (running) return running;
    const task = this.#doDeliver({ id, prev, chatId, runId, text }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, task);
    return task;
  }

  async #doDeliver({ id, prev, chatId, runId, text }) {
    const ledger = this.#ledger();
    const rec = {
      id,
      type: "feishu_outbound",
      chatId,
      runId,
      status: "pending",
      attempts: (prev?.attempts ?? 0) + 1,
      text,
      createdAt: prev?.createdAt ?? this.#now(),
      updatedAt: this.#now(),
      messageId: null,
      error: null,
    };
    ledger.put("outbox", rec);
    try {
      const sent = await this.#sendText(chatId, text);
      rec.status = "sent";
      rec.messageId = sent.messageId;
    } catch (e) {
      rec.status = e?.ambiguous ? "unknown" : "failed";
      rec.error = `${e?.code ?? "FEISHU_SEND_FAILED"}: ${e.message}`;
    }
    rec.updatedAt = this.#now();
    ledger.put("outbox", rec);
    return rec;
  }

  async #sendText(chatId, text) {
    const c = this.config;
    const missing = this.outboundMissing();
    if (missing.length) {
      throw new ChannelsError(
        "FEISHU_CREDENTIALS_MISSING",
        `飞书出站凭据未配置：缺少 ${missing.join("、")}。请在通道配置里设置，或用 appSecretEnv 指向环境变量`,
        503,
      );
    }
    const token = await this.#tenantToken();
    const url = `${c.apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    let res;
    try {
      res = await c.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
        body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }),
      });
    } catch (e) {
      throw new ChannelsError(
        "FEISHU_SEND_AMBIGUOUS",
        `发送请求未收到响应，副作用未知，不自动重试：${e.message}`,
        502,
        { ambiguous: true },
      );
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.code !== 0) {
      throw new ChannelsError(
        "FEISHU_SEND_FAILED",
        `飞书发送失败：HTTP ${res.status} code=${json?.code ?? "?"} msg=${json?.msg ?? ""}`,
        502,
        { ambiguous: res.status >= 500 },
      );
    }
    return { messageId: json.data?.message_id ?? null };
  }

  async #tenantToken() {
    const c = this.config;
    const now = this.#now();
    if (this.tokenCache && this.tokenCache.expiresAt - 60_000 > now) return this.tokenCache.token;
    const url = `${c.apiBase}/open-apis/auth/v3/tenant_access_token/internal`;
    let res;
    try {
      res = await c.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
      });
    } catch (e) {
      // 错误里绝不带上 app_secret / token。
      throw new ChannelsError("FEISHU_AUTH_UNREACHABLE", `无法连接飞书鉴权端点 ${c.apiBase}：${e.message}`, 502);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.code !== 0 || !json.tenant_access_token) {
      throw new ChannelsError(
        "FEISHU_AUTH_FAILED",
        `获取 tenant_access_token 失败：HTTP ${res.status} code=${json?.code ?? "?"} msg=${json?.msg ?? ""}`,
        502,
      );
    }
    this.tokenCache = {
      token: json.tenant_access_token,
      expiresAt: now + (Number(json.expire) || 7200) * 1000,
    };
    return this.tokenCache.token;
  }
}

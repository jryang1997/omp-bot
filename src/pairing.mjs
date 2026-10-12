// - 设备 token 永远不能改花名册/策略/连接器：没有对应入口，且有 authorizeAdmin 显式拒绝。
// - 状态存 Ledger 的 devices 类别（本地 SQLite），不新建第二套凭据库。

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** 设备可用权限。没有 owner/admin 之类的越权档位。 */
export const DEVICE_PERMISSIONS = Object.freeze(["read", "run", "approve"]);

export const DEFAULT_DEVICE_PERMISSIONS = Object.freeze(["read", "run"]);

/** 设备动作 → 所需权限。取消/补充都属于「运行」类，审批必须单独授权。 */
export const ACTION_PERMISSION = Object.freeze({
  read: "read",
  status: "read",
  run: "run",
  cancel: "run",
  steer: "run",
  approve: "approve",
});

/** 必须带 botId 做作用域校验的动作（必然作用于某个具体 bot）。 */
export const BOT_SCOPED_ACTIONS = Object.freeze(["run", "cancel", "steer", "approve"]);

/** 一次性配对码默认存活 5 分钟。 */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** 兑换限流：每个来源 60 秒内最多 10 次，全局 60 秒内最多 60 次。 */
export const PAIRING_RATE = Object.freeze({ windowMs: 60_000, maxAttempts: 10, globalMaxAttempts: 60 });

const ID_PREFIX = "pair_";
const TOKEN_PREFIX = "ompd_";
const MAX_TICKETS = 50;

export class PairingError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = "PairingError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

/** 等长十六进制摘要比较；长度不等直接 false，绝不泄露差异位置。 */
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function normalizePermissions(input) {
  if (input === undefined || input === null) return [...DEFAULT_DEVICE_PERMISSIONS];
  if (!Array.isArray(input)) {
    throw new PairingError("PAIRING_BAD_PERMISSIONS", "permissions 必须是字符串数组", 400);
  }
  const perms = [...new Set(input.map((p) => String(p).trim().toLowerCase()).filter(Boolean))];
  if (!perms.length) {
    throw new PairingError("PAIRING_BAD_PERMISSIONS", "permissions 不能为空数组", 400);
  }
  const bad = perms.filter((p) => !DEVICE_PERMISSIONS.includes(p));
  if (bad.length) {
    // admin/owner/* 等一律拒绝，杜绝越权档位。
    throw new PairingError(
      "PAIRING_BAD_PERMISSIONS",
      `不允许的设备权限：${bad.join(", ")}（只允许 ${DEVICE_PERMISSIONS.join("/")}）`,
      400,
    );
  }
  return perms;
}

const publicTicket = (t) => ({
  id: t.id,
  type: "pairing",
  botIds: [...t.botIds],
  permissions: [...t.permissions],
  label: t.label ?? "",
  createdAt: t.createdAt,
  expiresAt: t.expiresAt,
  usedAt: t.usedAt ?? null,
  revokedAt: t.revokedAt ?? null,
});

const publicDevice = (d) => ({
  id: d.id,
  type: "device",
  botIds: [...d.botIds],
  permissions: [...d.permissions],
  label: d.label ?? "",
  createdAt: d.createdAt,
  revokedAt: d.revokedAt ?? null,
  lastUsedAt: d.lastUsedAt ?? null,
  ticketId: d.ticketId ?? null,
});

export class PairingService {
  /**
   * @param {object} opts
   * @param {object} opts.orch 需要 orch.ledger（put/get/list/remove）与 orch.listBots()
   * @param {number} [opts.ttlMs] 配对码存活时长，默认 5 分钟
   * @param {{windowMs:number,maxAttempts:number,globalMaxAttempts:number}} [opts.rate]
   * @param {() => number} [opts.now] 时间源（测试可注入）
   */
  constructor({ orch, ttlMs = PAIRING_CODE_TTL_MS, rate = PAIRING_RATE, now = () => Date.now() } = {}) {
    if (!orch) throw new Error("PairingService 需要 orch");
    this.orch = orch;
    this.ttlMs = ttlMs;
    this.rate = { ...PAIRING_RATE, ...(rate ?? {}) };
    this.now = now;
    this.maxTickets = MAX_TICKETS;
    // ponytail: 限流窗口在内存里，进程重启即清零；要跨重启严格限流就挪进 Ledger。
    this.attempts = new Map();
    this.globalAttempts = [];
  }

  #ledger() {
    const l = this.orch?.ledger;
    if (!l) throw new Error("PairingService 需要 orch.ledger（Ledger 尚未接入 Orchestrator）");
    return l;
  }

  #ticketId(code) {
    return ID_PREFIX + sha256hex(code).slice(0, 32);
  }

  /**
   * owner 侧签发配对码（HTTP 层必须已用 owner bearer 认证）。
   * @param {{botIds:string[]|string, permissions?:string[], label?:string, ttlMs?:number}} input
   */
  create(input = {}) {
    const rawIds = Array.isArray(input.botIds) ? input.botIds : input.botIds ? [input.botIds] : [];
    const botIds = [...new Set(rawIds.map((b) => String(b).trim()).filter(Boolean))];
    if (!botIds.length) {
      throw new PairingError(
        "PAIRING_NO_TARGET",
        "必须显式列出至少一个 bot id：设备只能作用于被列出的 bot",
        400,
      );
    }
    const known = new Set((this.orch.listBots?.() ?? []).map((b) => b.id));
    const unknown = botIds.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new PairingError("PAIRING_UNKNOWN_BOT", `未知 bot id：${unknown.join(", ")}`, 400);
    }
    const permissions = normalizePermissions(input.permissions);
    // 先腾容量：超限时明确报错，而不是静默作废最旧的有效码。
    this.#reclaimCapacity();
    const at = this.now();
    const code = `ompcode_${randomBytes(24).toString("base64url")}`;
    const ticket = {
      id: this.#ticketId(code),
      type: "pairing",
      codeHash: sha256hex(code),
      botIds,
      permissions,
      label: String(input.label ?? ""),
      createdAt: at,
      expiresAt: at + (Number.isFinite(input.ttlMs) ? input.ttlMs : this.ttlMs),
      usedAt: null,
      revokedAt: null,
      deviceId: null,
      createdBy: "owner",
    };
    this.#ledger().put("devices", ticket);
    return { ticket: publicTicket(ticket), code };
  }

  /** 未认证的兑换入口（HTTP 层限流 + 已认证事件除外，本方法是唯一凭据来源）。 */
  redeem(input = {}) {
    const req = typeof input === "string" ? { code: input } : (input ?? {});
    const client = String(req.client ?? "unknown");
    const code = String(req.code ?? "").trim();
    this.#checkRate(client);
    if (code.length < 16 || code.length > 200) {
      throw new PairingError("PAIRING_INVALID_CODE", "配对码无效、已使用或已过期", 404);
    }
    const ticket = this.#ledger().get("devices", this.#ticketId(code));
    // 恒定路径：先做摘要比较，再判状态，避免用不同错误区分「码不存在」与「状态不对」。
    if (!ticket || !safeEqualHex(ticket.codeHash, sha256hex(code))) {
      throw new PairingError("PAIRING_INVALID_CODE", "配对码无效、已使用或已过期", 404);
    }
    const at = this.now();
    if (ticket.revokedAt) throw new PairingError("PAIRING_REVOKED", "配对码已撤销", 410);
    if (ticket.usedAt) throw new PairingError("PAIRING_USED", "配对码已被使用（一次性）", 410);
    if (at >= ticket.expiresAt) throw new PairingError("PAIRING_EXPIRED", "配对码已过期，请重新签发", 410);

    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    const device = {
      id: `dev_${randomUUID()}`,
      type: "device",
      // token 是 256 位随机串，快速摘要即可；salt 防彩虹表与跨设备复用。
      tokenHash: sha256hex(salt + token),
      salt,
      botIds: [...ticket.botIds],
      permissions: [...ticket.permissions],
      label: String(req.name ?? ticket.label ?? ""),
      ticketId: ticket.id,
      createdAt: at,
      revokedAt: null,
      lastUsedAt: null,
      client,
    };
    this.#ledger().put("devices", { ...ticket, usedAt: at, deviceId: device.id });
    this.#ledger().put("devices", device);
    return { token, device: publicDevice(device) };
  }

  /**
   * 校验设备 token。成功返回设备视图（含权限与作用域），失败返回 null。
   * 不做任何 owner/admin 推断：设备只有 devices 记录里的权限。
   *
   * 已知边界（本机单用户部署够用，不做通用注册表改造）：devices 类别同时放配对码与设备，
   * token 是随机串不可索引，因此这里按 Ledger 的 list 上限（1000 条，ITEM_LIMIT_MAX）线性扫描；
   * 超过上限后最旧的设备会扫不到（表现为认证失败）——需要时改按 token 摘要分桶建索引。
   */
  authenticate(token) {
    const raw = typeof token === "string" ? token : "";
    if (!raw.startsWith(TOKEN_PREFIX) || raw.length < 32) return null;
    const rows = this.#ledger().list("devices", { limit: 1000 });
    for (const d of rows) {
      if (d.type !== "device" || d.revokedAt || typeof d.salt !== "string") continue;
      if (!safeEqualHex(d.tokenHash, sha256hex(d.salt + raw))) continue;
      const at = this.now();
      if (!d.lastUsedAt || at - d.lastUsedAt > 60_000) {
        // 只用于展示「最近使用」；写失败（readonly 副本）不影响认证结果。
        try {
          this.#ledger().put("devices", { ...d, lastUsedAt: at });
        } catch {}
      }
      return publicDevice({ ...d, lastUsedAt: at });
    }
    return null;
  }

  /** 作用域与权限检查：越界直接抛 403，不返回真假。 */
  authorize(device, { action, botId } = {}) {
    if (!device || typeof device !== "object" || device.type !== "device") {
      throw new PairingError("DEVICE_UNAUTHORIZED", "需要有效的设备 token", 401);
    }
    if (device.revokedAt) throw new PairingError("DEVICE_REVOKED", "设备凭证已撤销", 401);
    const need = ACTION_PERMISSION[action];
    if (!need) throw new PairingError("DEVICE_UNKNOWN_ACTION", `未知设备动作 ${JSON.stringify(action)}`, 400);
    if (!Array.isArray(device.permissions) || !device.permissions.includes(need)) {
      throw new PairingError("DEVICE_FORBIDDEN", `设备缺少 ${need} 权限`, 403);
    }
    if (BOT_SCOPED_ACTIONS.includes(action)) {
      // run/cancel/steer/approve 必然作用于某个 bot：调用方忘传 botId 必须显式失败，不能静默放行。
      if (typeof botId !== "string" || !botId) {
        throw new PairingError("DEVICE_BOT_REQUIRED", `动作 ${action} 必须显式提供 botId 做作用域校验`, 400);
      }
      if (!(device.botIds ?? []).includes(botId)) {
        throw new PairingError("DEVICE_OUT_OF_SCOPE", `设备未被授权操作 bot ${botId}`, 403);
      }
    } else if (botId !== undefined && !(device.botIds ?? []).includes(botId)) {
      // read/status 可以不带 botId（列表类由调用方自行过滤），带了就必须在作用域内。
      throw new PairingError("DEVICE_OUT_OF_SCOPE", `设备未被授权操作 bot ${botId}`, 403);
    }
    return true;
  }

  /** 花名册/策略/连接器只能走 owner 凭证；设备 token 走到这里一律拒绝。 */
  authorizeAdmin() {
    throw new PairingError(
      "DEVICE_NO_ADMIN",
      "设备 token 不能修改花名册、策略或连接器，请使用 owner 凭证",
      403,
    );
  }

  /** 撤销配对码或设备（owner 侧）。 */
  revoke(id) {
    const key = String(id ?? "");
    const rec = key ? this.#ledger().get("devices", key) : null;
    if (!rec) throw new PairingError("PAIRING_NOT_FOUND", `没有这条配对记录：${key}`, 404);
    if (!rec.revokedAt) {
      const next = { ...rec, revokedAt: this.now() };
      this.#ledger().put("devices", next);
      return next.type === "device" ? publicDevice(next) : publicTicket(next);
    }
    return rec.type === "device" ? publicDevice(rec) : publicTicket(rec);
  }

  /** owner 侧列表，永远不含 codeHash/tokenHash/salt。 */
  list() {
    const rows = this.#ledger().list("devices", { limit: 1000 });
    return {
      tickets: rows.filter((r) => r.type === "pairing").map(publicTicket),
      devices: rows.filter((r) => r.type === "device").map(publicDevice),
    };
  }

  // ---- 内部 ----

  #checkRate(client) {
    const { windowMs, maxAttempts, globalMaxAttempts } = this.rate;
    const now = this.now();
    const within = (arr) => arr.filter((t) => now - t < windowMs);
    const mine = within(this.attempts.get(client) ?? []);
    mine.push(now);
    this.attempts.set(client, mine);
    this.globalAttempts = within(this.globalAttempts);
    this.globalAttempts.push(now);
    if (this.attempts.size > 500) {
      for (const [k, v] of this.attempts) if (!within(v).length) this.attempts.delete(k);
    }
    const over = mine.length > maxAttempts || this.globalAttempts.length > globalMaxAttempts;
    if (over) {
      const oldest = mine.length > maxAttempts ? mine[0] : this.globalAttempts[0];
      const retryAfterMs = Math.max(0, windowMs - (now - oldest));
      throw new PairingError("PAIRING_RATE_LIMITED", "配对尝试过于频繁，请稍后重试", 429, {
        retryAfterMs,
      });
    }
  }

  #reclaimCapacity() {
    const ledger = this.#ledger();
    const now = this.now();
    const tickets = ledger.list("devices", { limit: 1000 }).filter((r) => r.type === "pairing");
    // 只回收终态票（已用/已撤销/已过期）——绝不删除未使用且仍在有效期内的码。
    const dead = tickets.filter((t) => t.usedAt || t.revokedAt || t.expiresAt <= now);
    for (const t of dead) ledger.remove("devices", t.id);
    const alive = tickets.length - dead.length;
    if (alive >= this.maxTickets) {
      throw new PairingError(
        "PAIRING_CAPACITY",
        `有效期内的配对码已达上限 ${this.maxTickets}：先撤销或等其过期，再签发新码`,
        409,
      );
    }
  }
}

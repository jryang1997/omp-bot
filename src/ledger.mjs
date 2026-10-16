// 只存引用（sessionFile/sessionId）与有限重放投影；模型循环、transcript、压缩、审批、
// 凭据仍归 OMP 原生，这里不复制第二份。库文件 <home>/workbench.sqlite，单写者：
// 与 Store 的 state.json 共用同一 home 租约，拿不到锁的一方 readonly。
// 错误都带 code（LEDGER_INVALID|LEDGER_NOT_FOUND|LEDGER_CONFLICT|LEDGER_IMMUTABLE|
// LEDGER_READONLY|LEDGER_UNKNOWN_KIND|LEDGER_DB_MISSING|LEDGER_SCHEMA_MISSING|
// LEDGER_SCHEMA_NEWER|LEDGER_CLOSED）与建议 status。
// 副作用约定：调用方用 updateRun 记 sideEffects:[{id,kind,status:'in_flight'|'done'}]；
// reconcile 遇到 in_flight 的 Run 落 reconciliation_required + recovery.status=side_effect_unknown，
// 表示外部效果未知，禁止自动重放。

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { normalizeStats } from "./usage.mjs";

export const SCHEMA_VERSION = 1;

export const RUN_KINDS = Object.freeze(["chat", "room", "delegation"]);

/** Run 状态。reconciliation_required = 外部副作用未知，禁止自动重放。 */
export const RUN_STATES = Object.freeze([
  "queued",
  "starting",
  "running",
  "waiting_input",
  "waiting_approval",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "reconciliation_required",
]);

/** 终态：不可重开，只能新建 Run。 */
export const TERMINAL_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "reconciliation_required",
]);

/** 非终态 = reconcile 的清理范围（含 waiting_input、waiting_approval、cancelling）。 */
export const ACTIVE_STATES = Object.freeze(RUN_STATES.filter((s) => !TERMINAL_STATES.includes(s)));

/** 产品独有条目类别；roster/room/chat 仍在 Store，不在这里双写。 */
export const ITEM_KINDS = Object.freeze([
  "attachments",
  "artifacts",
  "routines",
  "approvals",
  "devices",
  "settings",
  "outbox",
  "workspaces",
  "delegations",
]);

/** reconcile 时外部副作用未知的标记值（run.recovery.status）。 */
export const RECOVERY_UNKNOWN = "side_effect_unknown";

const EVENT_KEEP = 5000; // 事件表有界：只留最近 N 条可重放投影
const EVENT_LIMIT_DEFAULT = 1000;
const EVENT_LIMIT_MAX = 5000;
const RUN_LIMIT_DEFAULT = 200;
const RUN_LIMIT_MAX = 1000;
const ITEM_LIMIT_DEFAULT = 200;
const ITEM_LIMIT_MAX = 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  kind TEXT NOT NULL,
  bot_id TEXT,
  room_id TEXT,
  scope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS runs_bot ON runs(bot_id, created_at);
CREATE INDEX IF NOT EXISTS runs_room ON runs(room_id, created_at);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  bot_id TEXT,
  room_id TEXT,
  scope TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TABLE IF NOT EXISTS items (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  model TEXT,
  session_file TEXT,
  session_id TEXT,
  cum TEXT NOT NULL,
  delta TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  requests INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id, id);
CREATE INDEX IF NOT EXISTS usage_session ON usage(session_file, id);
`;

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function limitArg(value, dflt, max) {
  if (value === undefined || value === null) return dflt;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw fail("LEDGER_INVALID", `limit 必须是正整数，收到 ${JSON.stringify(value)}`);
  }
  return Math.min(Math.trunc(value), max);
}

function jsonText(value, what) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    throw fail("LEDGER_INVALID", `${what} 不可 JSON 序列化: ${e.message}`);
  }
}

/** 客户端统计 → 累计快照；无价格时 cost 记 null（不假装 0）。 */
function snapshotOf(stats) {
  const n = normalizeStats(stats);
  return {
    tokensIn: n.tokensIn,
    tokensOut: n.tokensOut,
    reasoning: n.reasoning,
    totalTokens: n.totalTokens,
    cost: typeof stats?.cost === "number" ? stats.cost : null,
    requests: n.requests,
    toolCalls: n.toolCalls,
  };
}

/** 本 Run 差值 = 本次快照 − 本 Run 上次快照；会话切换导致回退时按 0 计，不出现负数。 */
function deltaOf(cur, prev) {
  const d = (a, b) => Math.max(0, (a ?? 0) - (b ?? 0));
  return {
    tokensIn: d(cur.tokensIn, prev?.tokensIn),
    tokensOut: d(cur.tokensOut, prev?.tokensOut),
    reasoning: d(cur.reasoning, prev?.reasoning),
    totalTokens: d(cur.totalTokens, prev?.totalTokens),
    cost: cur.cost === null ? null : Math.max(0, cur.cost - (prev?.cost ?? 0)),
    requests: d(cur.requests, prev?.requests),
    toolCalls: d(cur.toolCalls, prev?.toolCalls),
  };
}

/** 首次记录 = 基线：增量全 0，但保留「价格已知/未知」的信号。 */
function zeroDelta(cum) {
  return {
    tokensIn: 0,
    tokensOut: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: cum.cost === null ? null : 0,
    requests: 0,
    toolCalls: 0,
  };
}

function zeroUsageTotals() {
  return {
    tokensIn: 0,
    tokensOut: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
    costKnown: false,
    requests: 0,
    toolCalls: 0,
  };
}

export class Ledger {
  /**
   * @param {object} opts
   * @param {string} opts.home 数据根目录（与 Store 同一个 home）
   * @param {boolean} [opts.readonly] 只读：读得到、写一律拒绝；库不存在时显式报错
   */
  constructor({ home, readonly = false } = {}) {
    if (typeof home !== "string" || !home) throw fail("LEDGER_INVALID", "Ledger 需要 home");
    this.home = home;
    this.path = join(home, "workbench.sqlite");
    this.readonly = readonly;
    this.#closed = false;

    const exists = existsSync(this.path);
    if (readonly && !exists) {
      throw fail("LEDGER_DB_MISSING", `只读打开失败：台账库不存在 ${this.path}`, 503);
    }
    if (!readonly) mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(this.path, readonly ? { readOnly: true } : {});
    try {
      if (readonly) this.#checkVersion();
      else this.#migrate();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  // ---- 内部：连接与语句 ----

  #stmts = new Map();

  #stmt(sql) {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  #assertOpen() {
    if (this.#closed) throw fail("LEDGER_CLOSED", "Ledger 已关闭", 500);
  }

  #assertWritable() {
    this.#assertOpen();
    if (this.readonly) throw fail("LEDGER_READONLY", "台账处于只读模式，拒绝写入", 409);
  }

  /** BEGIN IMMEDIATE + 统一回滚：异常不留下半截状态。不做嵌套（无 savepoint）。 */
  #tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  #checkVersion() {
    const v = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (v > SCHEMA_VERSION) {
      throw fail("LEDGER_SCHEMA_NEWER", `台账库 schema v${v} 比本代码 v${SCHEMA_VERSION} 新，拒绝打开`, 500);
    }
    if (v < SCHEMA_VERSION) {
      // 只读连接不迁移：明确报错，不静默当空库用。
      throw fail("LEDGER_SCHEMA_MISSING", `台账库 schema v${v} 需要迁移，只读连接不迁移`, 503);
    }
  }

  #migrate() {
    // WAL + synchronous=NORMAL：进程崩溃不丢已提交数据（重启可对账），只有断电可能丢最后几次提交。
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    const current = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (current > SCHEMA_VERSION) {
      throw fail("LEDGER_SCHEMA_NEWER", `台账库 schema v${current} 比本代码 v${SCHEMA_VERSION} 新，拒绝打开`, 500);
    }
    if (current === SCHEMA_VERSION) return;
    // 迁移前先备份旧 state.json（保留最早那份原件，不覆盖已有备份）。
    const statePath = join(this.home, "state.json");
    const backupPath = `${statePath}.bak`;
    if (existsSync(statePath) && !existsSync(backupPath)) copyFileSync(statePath, backupPath);
    this.db.exec(SCHEMA_SQL);
    this.db.exec("INSERT OR IGNORE INTO meta(key, value) VALUES ('last_seq', '0')");
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // ---- 内部：run 行 ----

  #readRun(id) {
    const row = this.#stmt("SELECT data FROM runs WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  /** 写整条记录；过滤列与 JSON 一起更新，created_at 不可变。 */
  #writeRun(rec) {
    this.#stmt(
      `INSERT INTO runs (id, state, kind, bot_id, room_id, scope, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state, kind = excluded.kind, bot_id = excluded.bot_id,
         room_id = excluded.room_id, scope = excluded.scope,
         updated_at = excluded.updated_at, data = excluded.data`,
    ).run(
      rec.id,
      rec.state,
      rec.kind ?? null,
      rec.botId ?? null,
      rec.roomId ?? null,
      rec.scope ?? null,
      rec.createdAt,
      rec.updatedAt,
      jsonText(rec, "run 记录"),
    );
  }

  #nextSeq() {
    const cur = Number(this.#stmt("SELECT value FROM meta WHERE key = 'last_seq'").get()?.value ?? "0");
    const seq = cur + 1;
    this.#stmt(
      "INSERT INTO meta(key, value) VALUES ('last_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(seq));
    return seq;
  }

  // ---- Run ----

  /**
   * 建 Run 记录（先落盘再启动副作用，由调用方保证顺序）。
   * @param {object} input {id?,kind,scope,text,botId?,roomId?,attachmentIds?,parentRunId?,depth?,budget?,source?,taskId?}
   */
  createRun(input = {}) {
    this.#assertWritable();
    const kind = input.kind;
    if (!RUN_KINDS.includes(kind)) {
      throw fail("LEDGER_INVALID", `kind 必须是 ${RUN_KINDS.join("|")}，收到 ${JSON.stringify(kind)}`);
    }
    if (typeof input.text !== "string") throw fail("LEDGER_INVALID", "text 必须是字符串");
    if (typeof input.scope !== "string" || !input.scope) {
      throw fail("LEDGER_INVALID", "scope 必须是非空字符串（admission 键）");
    }
    const id = input.id ?? `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    if (typeof id !== "string" || !id) throw fail("LEDGER_INVALID", "id 必须是非空字符串");
    const depth = input.depth ?? 0;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) {
      throw fail("LEDGER_INVALID", `depth 必须是非负整数，收到 ${JSON.stringify(input.depth)}`);
    }
    if (input.attachmentIds !== undefined && !Array.isArray(input.attachmentIds)) {
      throw fail("LEDGER_INVALID", "attachmentIds 必须是数组");
    }

    const now = Date.now();
    const rec = {
      id,
      taskId: input.taskId ?? null,
      kind,
      botId: input.botId ?? null,
      roomId: input.roomId ?? null,
      scope: input.scope,
      text: input.text,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      parentRunId: input.parentRunId ?? null,
      depth,
      budget: input.budget ?? null,
      source: input.source ?? "user",
      attachmentIds: Array.isArray(input.attachmentIds) ? [...input.attachmentIds] : [],
      sessionId: null,
      sessionFile: null,
      reply: null,
      error: null,
      stats: null,
      approvalIds: [],
      artifactIds: [],
    };

    return this.#tx(() => {
      if (this.#readRun(id)) throw fail("LEDGER_CONFLICT", `run ${id} 已存在`, 409);
      this.#writeRun(rec);
      return rec;
    });
  }

  getRun(id) {
    this.#assertOpen();
    if (typeof id !== "string" || !id) throw fail("LEDGER_INVALID", "id 必须是非空字符串");
    return this.#readRun(id);
  }

  /**
   * 打补丁更新 Run。未知字段并入记录（contract 说「至少」这些字段）；id/createdAt 不可改；
   * state 同值 = 幂等空操作，终态不能被改回非终态。
   */
  updateRun(id, patch = {}) {
    this.#assertWritable();
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw fail("LEDGER_INVALID", "patch 必须是对象");
    }
    return this.#tx(() => {
      const rec = this.#readRun(id);
      if (!rec) throw fail("LEDGER_NOT_FOUND", `run ${id} 不存在`, 404);
      if (patch.id !== undefined && patch.id !== rec.id) {
        throw fail("LEDGER_INVALID", "run.id 不可修改");
      }
      if (patch.createdAt !== undefined && patch.createdAt !== rec.createdAt) {
        throw fail("LEDGER_INVALID", "run.createdAt 不可修改");
      }
      if (patch.state !== undefined) {
        if (!RUN_STATES.includes(patch.state)) {
          throw fail("LEDGER_INVALID", `未知 run state ${JSON.stringify(patch.state)}`);
        }
        if (patch.state !== rec.state && TERMINAL_STATES.includes(rec.state)) {
          throw fail("LEDGER_IMMUTABLE", `终态 ${rec.state} 不能重开为 ${patch.state}`, 409);
        }
      }
      const next = { ...rec };
      // undefined = 「不改这个字段」，避免 JSON 序列化时把 key 抹掉。
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
      if (!TERMINAL_STATES.includes(next.state) && !ACTIVE_STATES.includes(next.state)) {
        throw fail("LEDGER_INVALID", `未知 run state ${JSON.stringify(next.state)}`);
      }
      next.id = rec.id;
      next.createdAt = rec.createdAt;
      next.updatedAt = Date.now();
      jsonText(next, "run 记录");
      this.#writeRun(next);
      return next;
    });
  }

  /** 作用域列表：按 botId/roomId/state 过滤，limit 有上限校验。 */
  listRuns(filters = {}) {
    this.#assertOpen();
    const { botId, roomId, state } = filters ?? {};
    const limit = limitArg(filters?.limit, RUN_LIMIT_DEFAULT, RUN_LIMIT_MAX);
    const where = [];
    const args = [];
    if (botId !== undefined) {
      if (typeof botId !== "string" || !botId) throw fail("LEDGER_INVALID", "botId 必须是非空字符串");
      where.push("bot_id = ?");
      args.push(botId);
    }
    if (roomId !== undefined) {
      if (typeof roomId !== "string" || !roomId) throw fail("LEDGER_INVALID", "roomId 必须是非空字符串");
      where.push("room_id = ?");
      args.push(roomId);
    }
    if (state !== undefined) {
      const list = Array.isArray(state) ? state : [state];
      if (!list.length) throw fail("LEDGER_INVALID", "state 过滤不能是空数组");
      for (const s of list) {
        if (!RUN_STATES.includes(s)) throw fail("LEDGER_INVALID", `未知 run state ${JSON.stringify(s)}`);
      }
      where.push(`state IN (${list.map(() => "?").join(", ")})`);
      args.push(...list);
    }
    args.push(limit);
    const sql = `SELECT data FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return this.#stmt(sql)
      .all(...args)
      .map((r) => JSON.parse(r.data));
  }

  /** 启动对账：非终态 Run 一律落定，不自动重跑，不丢历史。 */
  reconcile() {
    this.#assertWritable();
    return this.#tx(() => {
      const sql = `SELECT data FROM runs WHERE state IN (${ACTIVE_STATES.map(() => "?").join(", ")})`;
      const rows = this.#stmt(sql).all(...ACTIVE_STATES);
      const interrupted = [];
      const reconciliationRequired = [];
      const now = Date.now();
      for (const row of rows) {
        const rec = JSON.parse(row.data);
        const inFlight = Array.isArray(rec.sideEffects)
          ? rec.sideEffects.some((s) => s?.status === "in_flight")
          : false;
        if (inFlight) {
          rec.state = "reconciliation_required";
          rec.recovery = { status: RECOVERY_UNKNOWN, reason: "in_flight_at_reconcile", at: now };
          reconciliationRequired.push(rec.id);
        } else {
          rec.state = "interrupted";
          interrupted.push(rec.id);
        }
        rec.updatedAt = now;
        this.#writeRun(rec);
      }
      return { interrupted, reconciliationRequired };
    });
  }

  // ---- 事件 ----

  /**
   * 追加事件，分配全局单调 seq；返回信封 {v:1,seq,at,...input}。
   * input 里的 v/seq/at 一律被覆盖（seq 只能由这里分配）。
   */
  appendEvent(input = {}) {
    this.#assertWritable();
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw fail("LEDGER_INVALID", "event 必须是对象");
    }
    if (typeof input.type !== "string" || !input.type) {
      throw fail("LEDGER_INVALID", "event.type 必须是非空字符串");
    }
    const { v: _v, seq: _seq, at: _at, type, runId, botId, roomId, scope, ...payload } = input;
    return this.#tx(() => {
      const seq = this.#nextSeq();
      const at = Date.now();
      const data = jsonText(payload, "event payload");
      this.#stmt(
        `INSERT INTO events (seq, at, type, run_id, bot_id, room_id, scope, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(seq, at, type, runId ?? null, botId ?? null, roomId ?? null, scope ?? null, data);
      if (seq > EVENT_KEEP) {
        this.#stmt("DELETE FROM events WHERE seq <= ?").run(seq - EVENT_KEEP);
      }
      return { ...input, v: 1, seq, at };
    });
  }

  /** 重放投影：seq 之后的有限事件（含边界校验）。 */
  eventsSince(seq = 0, { runId, limit = EVENT_LIMIT_DEFAULT } = {}) {
    this.#assertOpen();
    if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) {
      throw fail("LEDGER_INVALID", `since seq 必须是非负数字，收到 ${JSON.stringify(seq)}`);
    }
    const lim = limitArg(limit, EVENT_LIMIT_DEFAULT, EVENT_LIMIT_MAX);
    const where = ["seq > ?"];
    const args = [Math.trunc(seq)];
    if (runId !== undefined) {
      if (typeof runId !== "string" || !runId) throw fail("LEDGER_INVALID", "runId 必须是非空字符串");
      where.push("run_id = ?");
      args.push(runId);
    }
    args.push(lim);
    const rows = this.#stmt(
      `SELECT seq, at, type, run_id, bot_id, room_id, scope, data FROM events WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
    ).all(...args);
    return rows.map((r) => ({
      v: 1,
      seq: r.seq,
      at: r.at,
      type: r.type,
      ...(r.run_id === null ? {} : { runId: r.run_id }),
      ...(r.bot_id === null ? {} : { botId: r.bot_id }),
      ...(r.room_id === null ? {} : { roomId: r.room_id }),
      ...(r.scope === null ? {} : { scope: r.scope }),
      ...JSON.parse(r.data),
    }));
  }

  /** 已分配的最大 seq（事件被裁剪也不回退）。 */
  lastSeq() {
    this.#assertOpen();
    return Number(this.#stmt("SELECT value FROM meta WHERE key = 'last_seq'").get()?.value ?? "0");
  }

  // ---- 产品条目 ----

  #assertKind(kind) {
    if (!ITEM_KINDS.includes(kind)) {
      throw fail("LEDGER_UNKNOWN_KIND", `未知条目类别 ${JSON.stringify(kind)}（允许：${ITEM_KINDS.join(", ")}）`);
    }
  }

  /** 覆盖写一条产品记录（需要 record.id）。 */
  put(kind, record) {
    this.#assertWritable();
    this.#assertKind(kind);
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw fail("LEDGER_INVALID", `${kind} 记录必须是对象`);
    }
    const id = record.id;
    if (typeof id !== "string" || !id) throw fail("LEDGER_INVALID", `${kind} 记录需要非空字符串 id`);
    const data = jsonText(record, `${kind} 记录`);
    return this.#tx(() => {
      const now = Date.now();
      const prev = this.#stmt("SELECT created_at FROM items WHERE kind = ? AND id = ?").get(kind, id);
      this.#stmt(
        `INSERT INTO items (kind, id, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ).run(kind, id, prev?.created_at ?? now, now, data);
      return record;
    });
  }

  get(kind, id) {
    this.#assertOpen();
    this.#assertKind(kind);
    if (typeof id !== "string" || !id) throw fail("LEDGER_INVALID", "id 必须是非空字符串");
    const row = this.#stmt("SELECT data FROM items WHERE kind = ? AND id = ?").get(kind, id);
    return row ? JSON.parse(row.data) : null;
  }

  list(kind, { limit = ITEM_LIMIT_DEFAULT } = {}) {
    this.#assertOpen();
    this.#assertKind(kind);
    const lim = limitArg(limit, ITEM_LIMIT_DEFAULT, ITEM_LIMIT_MAX);
    return this.#stmt("SELECT data FROM items WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(kind, lim)
      .map((r) => JSON.parse(r.data));
  }

  /** 删除条目；返回是否真的删到了。 */
  remove(kind, id) {
    this.#assertWritable();
    this.#assertKind(kind);
    if (typeof id !== "string" || !id) throw fail("LEDGER_INVALID", "id 必须是非空字符串");
    return this.#tx(() => this.#stmt("DELETE FROM items WHERE kind = ? AND id = ?").run(kind, id).changes > 0);
  }

  // ---- 用量 ----

  /**
   * 记一次某 Run 的会话统计快照（omp get_session_stats 形状），只落「本 Run 增量」：
   * - 已有基线（本 Run 或同一 sessionFile 的上一条快照）→ 差值 = 本次 − 基线；
   * - 第一次看到该 Run/会话且 Run 还活着 → 当作基线，增量记 0，不做整段累计的搬运；
   * - 第一次看到且 Run 已终态（只调一次收尾的调用方）→ 按整笔落，交回 sessionId/sessionFile 引用。
   * 于是调用方在 Run 开始与结束各调一次，即可得到该 Run 的真实增量，不会把整段会话累计
   * 当单个 Run 重复计数。
   */
  addUsage(runId, stats) {
    this.#assertWritable();
    if (typeof runId !== "string" || !runId) throw fail("LEDGER_INVALID", "runId 必须是非空字符串");
    return this.#tx(() => {
      const rec = this.#readRun(runId);
      if (!rec) throw fail("LEDGER_NOT_FOUND", `run ${runId} 不存在`, 404);
      const cum = snapshotOf(stats);
      const cumText = jsonText(cum, "cum"); // 先验证可序列化，再算差值
      const prevRow = this.#stmt(
        `SELECT cum FROM usage WHERE run_id = ? OR (session_file IS NOT NULL AND session_file = ?)
          ORDER BY id DESC LIMIT 1`,
      ).get(runId, rec.sessionFile ?? null);
      const prev = prevRow ? JSON.parse(prevRow.cum) : null;
      const baseline = !prev && !TERMINAL_STATES.includes(rec.state);
      const deltaFields = baseline ? zeroDelta(cum) : deltaOf(cum, prev);
      const at = Date.now();
      const model = stats?.model ?? stats?.modelId ?? null;
      this.#stmt(
        `INSERT INTO usage (run_id, at, model, session_file, session_id, cum, delta,
           tokens_in, tokens_out, reasoning, total_tokens, cost, requests, tool_calls, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        at,
        model,
        rec.sessionFile ?? null,
        rec.sessionId ?? null,
        cumText,
        jsonText(deltaFields, "usage delta"),
        deltaFields.tokensIn,
        deltaFields.tokensOut,
        deltaFields.reasoning,
        deltaFields.totalTokens,
        deltaFields.cost,
        deltaFields.requests,
        deltaFields.toolCalls,
        stats === undefined ? null : jsonText(stats, "usage 原始统计"),
      );
      return { runId, at, model, baseline, delta: deltaFields, cum };
    });
  }

  /** 每 Run（按模型分行）差值 + 全局合计；没记到价格时 costKnown=false，不假装 0。 */
  usage() {
    this.#assertOpen();
    const rows = this.#stmt(
      `SELECT run_id, model,
              SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
              SUM(reasoning) AS reasoning, SUM(total_tokens) AS total_tokens,
              SUM(cost) AS cost, COUNT(cost) AS priced_rows, COUNT(*) AS rows,
              SUM(requests) AS requests, SUM(tool_calls) AS tool_calls,
              MAX(at) AS at
         FROM usage GROUP BY run_id, model ORDER BY run_id ASC, model ASC`,
    ).all();
    const perRun = rows.map((r) => ({
      runId: r.run_id,
      model: r.model,
      tokensIn: r.tokens_in ?? 0,
      tokensOut: r.tokens_out ?? 0,
      reasoning: r.reasoning ?? 0,
      totalTokens: r.total_tokens ?? 0,
      cost: r.cost ?? 0,
      costKnown: r.priced_rows === r.rows && r.rows > 0,
      requests: r.requests ?? 0,
      toolCalls: r.tool_calls ?? 0,
      updatedAt: r.at,
    }));
    const totals = zeroUsageTotals();
    let priced = 0;
    for (const r of perRun) {
      totals.tokensIn += r.tokensIn;
      totals.tokensOut += r.tokensOut;
      totals.reasoning += r.reasoning;
      totals.totalTokens += r.totalTokens;
      totals.cost += r.cost;
      totals.requests += r.requests;
      totals.toolCalls += r.toolCalls;
      if (r.costKnown) priced++;
    }
    totals.costKnown = perRun.length > 0 && priced === perRun.length;
    return { perRun, totals };
  }

  /** 关闭一次；重复调用无副作用。 */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#stmts.clear();
    this.db.close();
  }

  #closed;
}

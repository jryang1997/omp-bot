// store.mjs — 团队状态持久层。
// state.json 存花名册（bots）、群（rooms）、投递日志（exchanges，有界）。
// 原子写（临时文件 + rename）防损坏；单写者靠 O_EXCL 锁文件（state.lock），
// 陈旧锁回收用 SQLite 独占租约（state.lease.db）串行化，避免两个 orchestrator 同写同一 home。
// 设计参考 DS-Bot 的 store.js + home-lock.js。

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  rmSync,
  openSync,
  closeSync,
  writeSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { STATE_VERSION } from "./constants.mjs";

/** 单写者锁：O_EXCL 锁文件是唯一认领路径，SQLite 独占租约只用于串行化陈旧锁回收。 */
const RECLAIM_ATTEMPTS = 5;
const LEASE_BUSY_TIMEOUT_MS = 250;
const LOCK_GRACE_MS = 5000;
const SQLITE_BUSY = 5;

/** SQLITE_BUSY = 别人占着租约（正常竞争）；其它错误要抛出去，不静默降级。 */
function isBusy(error) {
  return error?.errcode === SQLITE_BUSY || /database is locked/i.test(error?.message ?? "");
}

export function defaultHome() {
  return process.env.OMPBOT_HOME || join(homedir(), ".ompbot");
}

export function emptyState() {
  return { version: STATE_VERSION, bots: {}, rooms: {}, exchanges: [], chats: {} };
}

/** 原子写：先写 .tmp 再 rename，避免半截文件。 */
function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

export class Store {
  /**
   * @param {object} opts
   * @param {string} [opts.home] 数据根目录，默认 ~/.ompbot
   * @param {boolean} [opts.readonly] 只读（拿不到锁时）
   */
  constructor(opts = {}) {
    this.home = opts.home ?? defaultHome();
    this.statePath = join(this.home, "state.json");
    this.lockPath = join(this.home, "state.lock");
    this.leasePath = join(this.home, "state.lease.db");
    this.readonly = opts.readonly ?? false;
    this.state = emptyState();
    // 本实例的锁身份。同进程另开一个 Store 也是「不同的持有者」，不能凭 pid 相同就白拿锁。
    this.lockNonce = randomUUID();
  }

  /**
   * 加载状态；不存在则用空状态。做最小版本迁移（纯读，不写盘）。
   * 版本不一致时只记下「下次真正落盘前要先备份原件」——只读进程因此完全不动磁盘。
   */
  load() {
    if (existsSync(this.statePath)) {
      let raw;
      try {
        raw = JSON.parse(readFileSync(this.statePath, "utf8"));
      } catch (e) {
        throw new Error(`state.json 损坏，无法解析: ${e.message}`);
      }
      this.#pendingBackup = raw?.version !== STATE_VERSION;
      this.state = migrate(raw);
    } else {
      this.#pendingBackup = false;
      this.state = emptyState();
    }
    return this.state;
  }

  /**
   * 获取单写者锁。
   * 认领只有一条路径：O_EXCL 独占创建 state.lock（绝不做「先读旧锁再覆盖」）。
   * 回收陈旧锁前先拿 SQLite BEGIN EXCLUSIVE 短暂租约把判定串行化，并在租约内重新读一次锁文件——
   * 基于旧快照夺取会把别人刚建好的活锁挪走（A 建新锁、延迟的 B 按旧快照 rename）。
   * 活着的持有者一律只读，包括同进程另一个 Store 实例（pid 相同、nonce 不同）。
   */
  acquireLock() {
    mkdirSync(this.home, { recursive: true });
    for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt++) {
      if (this.#createLockFile()) {
        this.readonly = false;
        return true;
      }
      const holder = this.#readHolder();
      if (holder?.nonce === this.lockNonce) {
        this.readonly = false; // 自己已持有：重入，不重写文件
        return true;
      }
      if (holder && isAlive(holder.pid)) {
        this.readonly = true;
        return false;
      }
      if (!holder && this.#lockFileIsYoung()) {
        this.readonly = true; // 刚出现还没写完内容的锁：不抢，避免两个写者
        return false;
      }
      const outcome = this.#reclaimLock();
      if (outcome === "won" || outcome === "mine") {
        this.readonly = false;
        return true;
      }
      if (outcome === "held") {
        this.readonly = true;
        return false;
      }
      // contended：别的进程正在回收，下一轮重来
    }
    this.readonly = true;
    return false;
  }

  /**
   * 陈旧锁回收，全程由租约（SQLite 独占事务）串行化：
   * 租约内重读——活着就让位、拿不到租约就退避；只有确认没人在用才挪走并独占创建。
   * 租约只在这几微秒里持有（崩溃由 OS 释放锁，无需陈旧判断，也不会占住 home 目录）。
   */
  #reclaimLock() {
    let lease;
    try {
      lease = new DatabaseSync(this.leasePath);
      lease.exec(`PRAGMA busy_timeout = ${LEASE_BUSY_TIMEOUT_MS}`);
      lease.exec("BEGIN EXCLUSIVE");
    } catch (e) {
      try {
        lease?.close();
      } catch {}
      if (!isBusy(e)) throw e; // 真错误（权限/IO）不吞
      return "contended";
    }
    try {
      const fresh = this.#readHolder();
      if (fresh?.nonce === this.lockNonce) return "mine";
      if (fresh && isAlive(fresh.pid)) return "held";
      if (!fresh && this.#lockFileIsYoung()) return "held";
      this.#dropLockFile();
      return this.#createLockFile() ? "won" : "contended";
    } finally {
      try {
        lease.exec("ROLLBACK");
      } catch {}
      try {
        lease.close();
      } catch {}
    }
  }

  /** O_EXCL 创建锁文件并写下持有者；已被占用返回 false。 */
  #createLockFile() {
    try {
      const fd = openSync(this.lockPath, "wx");
      try {
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, nonce: this.lockNonce, startedAt: Date.now() }, null, 2),
        );
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  }

  /** 读取锁文件内容；不存在或坏 JSON 都当没读到（由调用方决定是否算陈旧）。 */
  #readHolder() {
    try {
      return JSON.parse(readFileSync(this.lockPath, "utf8"));
    } catch {
      return null;
    }
  }

  #lockFileIsYoung() {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs < LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }

  /** 挪到唯一名字再删：原路径的空档由后面的 O_EXCL 独占创建负责唯一性。 */
  #dropLockFile() {
    const stale = `${this.lockPath}.stale-${this.lockNonce}.${Date.now()}`;
    try {
      renameSync(this.lockPath, stale);
      rmSync(stale, { force: true });
    } catch {}
  }

  /** 释放锁：只删自己 nonce 写下的那一把，只读方不得动别人的锁。 */
  releaseLock() {
    const holder = this.#readHolder();
    if (holder?.pid === process.pid && holder.nonce === this.lockNonce) {
      rmSync(this.lockPath, { force: true });
    }
  }

  /** 持久化当前状态。只读模式抛错；迁移落盘前先把旧版本原件备份出来。 */
  save() {
    this.#assertWritable();
    if (this.#pendingBackup) {
      this.#pendingBackup = false;
      const backupPath = `${this.statePath}.bak`;
      // 已有备份不覆盖：留住最早那份原件。
      if (existsSync(this.statePath) && !existsSync(backupPath)) copyFileSync(this.statePath, backupPath);
    }
    atomicWrite(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /** 只读守卫：写操作先过这一关，绝不先改内存再抛。 */
  #assertWritable() {
    if (this.readonly) throw new Error("store 处于只读模式，无法写入（另一个 orchestrator 持有锁）");
  }

  /** 待迁移备份标记：load 时版本不一致置位，首次落盘前消费。 */
  #pendingBackup = false;

  // ---- 花名册 ----

  putBot(bot) {
    this.#assertWritable();
    this.state.bots[bot.id] = bot;
    this.save();
  }

  getBot(id) {
    return this.state.bots[id] ?? null;
  }

  listBots() {
    return Object.values(this.state.bots);
  }

  removeBot(id) {
    this.#assertWritable();
    delete this.state.bots[id];
    this.save();
  }

  // ---- 群 ----

  putRoom(room) {
    this.#assertWritable();
    this.state.rooms[room.id] = room;
    this.save();
  }

  getRoom(id) {
    return this.state.rooms[id] ?? null;
  }

  listRooms() {
    return Object.values(this.state.rooms);
  }

  removeRoom(id) {
    this.#assertWritable();
    delete this.state.rooms[id];
    this.save();
  }

  // ---- 投递日志（有界）----

  recordExchange(ex, cap = 500) {
    this.#assertWritable();
    this.state.exchanges.push(ex);
    if (this.state.exchanges.length > cap) {
      this.state.exchanges = this.state.exchanges.slice(-cap);
    }
    // 投递日志高频，不每次都落盘；调用方按需 save()。
  }

  flushExchanges() {
    this.save();
  }

  // ---- 私聊日志（每 bot 一条，有界）----
  // 只存展示用的 user/assistant 文本；真实 transcript 在 bot 各自的 omp session 里。

  getChat(botId) {
    return this.state.chats[botId] ?? [];
  }

  appendChat(botId, message, cap = 400) {
    this.#assertWritable();
    const arr = this.state.chats[botId] ?? (this.state.chats[botId] = []);
    arr.push(message);
    if (arr.length > cap) this.state.chats[botId] = arr.slice(-cap);
    this.save();
  }

  clearChat(botId) {
    this.#assertWritable();
    this.state.chats[botId] = [];
    this.save();
  }
}

function migrate(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  return {
    version: STATE_VERSION,
    bots: raw.bots && typeof raw.bots === "object" ? raw.bots : {},
    rooms: raw.rooms && typeof raw.rooms === "object" ? raw.rooms : {},
    exchanges: Array.isArray(raw.exchanges) ? raw.exchanges : [],
    chats: raw.chats && typeof raw.chats === "object" ? raw.chats : {},
  };
}

function isAlive(pid) {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = 不存在；EPERM = 存在但无权限（也算活着）。
    return e.code === "EPERM";
  }
}

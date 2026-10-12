// store.mjs — 团队状态持久层。
// state.json 存花名册（bots）、群（rooms）、投递日志（exchanges，有界）。
// 原子写（临时文件 + rename）防损坏；pid 锁文件防止两个 orchestrator 同时写同一 home。
// 设计参考 DS-Bot 的 store.js + home-lock.js。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { STATE_VERSION } from "./constants.mjs";

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
    this.readonly = opts.readonly ?? false;
    this.state = emptyState();
  }

  /** 加载状态；不存在则用空状态。做最小版本迁移。 */
  load() {
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, "utf8"));
        this.state = migrate(raw);
      } catch (e) {
        throw new Error(`state.json 损坏，无法解析: ${e.message}`);
      }
    } else {
      this.state = emptyState();
    }
    return this.state;
  }

  /** 尝试获取单写者锁。成功返回 true；被别的活进程占着返回 false。 */
  acquireLock() {
    mkdirSync(this.home, { recursive: true });
    if (existsSync(this.lockPath)) {
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(this.lockPath, "utf8"));
      } catch {}
      if (holder && isAlive(holder.pid) && holder.pid !== process.pid) {
        this.readonly = true;
        return false;
      }
      // 陈旧锁（进程已死或就是自己），覆盖它。
    }
    atomicWrite(
      this.lockPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2),
    );
    this.readonly = false;
    return true;
  }

  releaseLock() {
    try {
      if (existsSync(this.lockPath)) {
        const holder = JSON.parse(readFileSync(this.lockPath, "utf8"));
        if (holder?.pid === process.pid) rmSync(this.lockPath, { force: true });
      }
    } catch {}
  }

  /** 持久化当前状态。只读模式抛错。 */
  save() {
    if (this.readonly) throw new Error("store 处于只读模式，无法保存（另一个 orchestrator 持有锁）");
    atomicWrite(this.statePath, JSON.stringify(this.state, null, 2));
  }

  // ---- 花名册 ----

  putBot(bot) {
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
    delete this.state.bots[id];
    this.save();
  }

  // ---- 群 ----

  putRoom(room) {
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
    delete this.state.rooms[id];
    this.save();
  }

  // ---- 投递日志（有界）----

  recordExchange(ex, cap = 500) {
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
    const arr = this.state.chats[botId] ?? (this.state.chats[botId] = []);
    arr.push(message);
    if (arr.length > cap) this.state.chats[botId] = arr.slice(-cap);
    this.save();
  }

  clearChat(botId) {
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

// orchestrator.mjs — 团队编排器。
//
// 职责：花名册 CRUD、BotRuntime 池（按 botId:scope 懒启动）、
// 团队工具注入（message_bot / list_bots）、bot→bot 投递协议。
// 群聊 relay 引擎在 relay.mjs，由本编排器提供 runtimeFor/send 原语。
//
// 死锁防护：message_bot 的 hop 深度记在 BotRuntime.deliveryDepth（busy 守卫保证
// 一个 runtime 同时只跑一个回合，实例态在回合内稳定）；目标 busy 即拒绝，不阻塞等待。
import { Store, defaultHome } from "./store.mjs";
import { BotRuntime } from "./bot.mjs";
import { genId, makeBot, makeExchange, makeRoom } from "./domain.mjs";
import { MAX_HOPS, DELIVER_TIMEOUT_MS } from "./constants.mjs";
import { Relay } from "./relay.mjs";

/** message_bot 工具的 JSON schema。 */
const MESSAGE_BOT_SCHEMA = {
  type: "object",
  properties: {
    to: {
      type: "string",
      description: "目标 bot 的名字或 id（来自 list_bots）",
    },
    message: {
      type: "string",
      description: "要发给对方 bot 的消息内容",
    },
  },
  required: ["to", "message"],
  additionalProperties: false,
};

const LIST_BOTS_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export class Orchestrator {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] 数据根目录，默认 ~/.ompbot
   * @param {string} [opts.bin] omp 可执行文件
   * @param {boolean} [opts.debug]
   * @param {string} [opts.defaultThinking] 未显式指定时的默认思考档（默认 "low"，
   *        避免免费/慢端点在高思考档下拖垮整个 bot 团队）
   * @param {(evt:object)=>void} [opts.onEvent] 观察回调 {type,...}
   */
  constructor(opts = {}) {
    this.home = opts.home ?? defaultHome();
    this.bin = opts.bin ?? "omp";
    this.debug = opts.debug ?? false;
    this.defaultThinking = opts.defaultThinking ?? "low";
    this.onEvent = opts.onEvent ?? (() => {});

    this.store = new Store({ home: this.home });
    this.store.load();
    this.store.acquireLock();

    /** @type {Map<string, BotRuntime>} key = `${botId}::${scope}` */
    this.runtimes = new Map();
    /** 名字/id → botId 的解析缓存每次实时算，避免过期。 */
  }

  emit(type, data = {}) {
    this.onEvent({ type, at: Date.now(), ...data });
  }

  // ---- 花名册 ----

  /** 新建 bot 记录。 */
  addBot({ name, role, instructions, model, thinking, isMain }) {
    const id = genId("bot");
    const resolvedThinking = thinking ?? this.defaultThinking ?? "";
    const bot = makeBot({ id, name, role, instructions, model, thinking: resolvedThinking, isMain });
    this.store.putBot(bot);
    this.emit("bot_added", { bot });
    return bot;
  }

  getBot(id) {
    return this.store.getBot(id);
  }

  listBots() {
    return this.store.listBots();
  }

  removeBot(id) {
    this.store.removeBot(id);
    // 停掉它所有 runtime
    for (const [key, rt] of this.runtimes) {
      if (key.startsWith(`${id}::`)) {
        rt.stop();
        this.runtimes.delete(key);
      }
    }
    this.emit("bot_removed", { id });
  }

  /** 按名字或 id 解析 bot；名字大小写不敏感，最长名优先。 */
  resolveBot(nameOrId) {
    if (!nameOrId) return null;
    const bots = this.listBots();
    const byId = bots.find((b) => b.id === nameOrId);
    if (byId) return byId;
    const q = String(nameOrId).trim().toLowerCase();
    const exact = bots.find((b) => b.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = bots
      .filter((b) => b.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.length - b.name.length)[0];
    return partial ?? null;
  }

  // ---- runtime 池 ----

  /**
   * 取（或懒建）某 bot 在某 scope 的 runtime，并确保已启动。
   * @param {string} botId
   * @param {string} scope "private" | "room:<roomId>"
   */
  async runtimeFor(botId, scope = "private") {
    const key = `${botId}::${scope}`;
    let rt = this.runtimes.get(key);
    if (!rt) {
      const bot = this.getBot(botId);
      if (!bot) throw new Error(`未知 bot: ${botId}`);
      rt = new BotRuntime({
        bot,
        scope,
        home: this.home,
        bin: this.bin,
        debug: this.debug,
        teamToolsFactory: (runtime) => this._buildTeamTools(bot, runtime),
      });
      this.runtimes.set(key, rt);
    }
    if (!rt.alive) await rt.start();
    return rt;
  }

  /** 团队工具集：注入到每个 runtime。factory 收到真实 runtime，handler 可闭包读它的状态。 */
  _buildTeamTools(bot, runtime) {
    return [
      {
        name: "message_bot",
        label: "Message Bot",
        description:
          "给团队里的另一个 bot 发消息，并同步拿到它的回复。用于把一个子任务委派给更合适的队友，或向队友询问信息。",
        parameters: MESSAGE_BOT_SCHEMA,
        handler: (args) => this._handleMessageBot(bot, args, runtime),
      },
      {
        name: "list_bots",
        label: "List Bots",
        description: "列出团队里所有 bot 的名字、id 和角色，供你决定 message_bot 的收件人。",
        parameters: LIST_BOTS_SCHEMA,
        handler: () => this._handleListBots(bot),
      },
    ];
  }

  async _handleListBots(self) {
    const rows = this.listBots()
      .filter((b) => b.id !== self.id)
      .map((b) => `- ${b.name} (@${b.id})${b.role ? ` — ${b.role}` : ""}`);
    return { text: rows.length ? rows.join("\n") : "（团队里没有其他 bot）" };
  }

  /**
   * message_bot 投递：解析目标 → 检查 hop/busy → 跑目标回合 → 回复作为 tool result。
   * hop 深度记在 fromRuntime.deliveryDepth，向下传递时 +1。
   */
  async _handleMessageBot(fromBot, args, fromRuntime) {
    const hop = fromRuntime?.deliveryDepth ?? 0;
    const to = (args?.to ?? "").trim();
    const message = args?.message ?? "";

    if (hop >= MAX_HOPS) {
      return {
        text: `投递被拒绝：bot 间消息链已达上限 ${MAX_HOPS} 跳，请自己直接回答用户。`,
        isError: true,
      };
    }
    const target = this.resolveBot(to);
    if (!target) {
      return {
        text: `找不到名为「${to}」的 bot。用 list_bots 看看有谁。`,
        isError: true,
      };
    }
    if (target.id === fromBot.id) {
      return { text: "不能给自己发消息。", isError: true };
    }

    const ex = makeExchange({
      id: genId("ex"),
      from: fromBot.id,
      to: target.id,
      requestText: message,
      scope: "private",
    });
    ex.hop = hop;
    this.store.recordExchange(ex);
    this.emit("exchange_request", { from: fromBot.name, to: target.name, message, hop });

    let targetRt;
    try {
      targetRt = await this.runtimeFor(target.id, "private");
    } catch (e) {
      ex.status = "failed";
      ex.error = e?.message ?? String(e);
      this.store.flushExchanges();
      return { text: `无法启动 ${target.name}: ${ex.error}`, isError: true };
    }

    if (targetRt.busy) {
      ex.status = "failed";
      ex.error = "target busy";
      this.store.flushExchanges();
      // 不阻塞等待，直接回错误，避免死锁。
      return {
        text: `${target.name} 当前正忙（在处理别的消息），稍后再试或自己直接回答。`,
        isError: true,
      };
    }

    // 署名投递（抄 Hermes/DS-Bot 的带署名格式）。
    const delivered = `Message from 🤖 ${fromBot.name} (@${fromBot.id}):\n${message}`;

    try {
      const reply = await targetRt.send(delivered, {
        timeoutMs: DELIVER_TIMEOUT_MS,
        depth: hop + 1,
      });
      ex.status = "replied";
      ex.replyText = reply.text;
      this.store.flushExchanges();
      this.emit("exchange_reply", { from: fromBot.name, to: target.name, reply: reply.text });
      return { text: `${target.name} 回复：\n${reply.text || "（空回复）"}` };
    } catch (e) {
      ex.status = "timeout";
      ex.error = e?.message ?? String(e);
      this.store.flushExchanges();
      this.emit("exchange_failed", { from: fromBot.name, to: target.name, error: ex.error });
      return { text: `${target.name} 未能回复：${ex.error}`, isError: true };
    }
  }

  // ---- 私聊入口（IM 层/测试用）----

  /** 用户向某 bot 私聊发一条，返回 bot 回复。 */
  async chatWithBot(botId, text, opts = {}) {
    const rt = await this.runtimeFor(botId, "private");
    this.emit("user_to_bot", { botId, text });
    const res = await rt.send(text, opts);
    this.emit("bot_to_user", { botId, text: res.text });
    return res.text;
  }

  // ---- 群聊入口 ----

  /** 建群。members 是 bot id 数组；adminId 默认取第一个成员。 */
  createRoom({ name, members = [], adminId = null, mode = "admin" }) {
    const ids = members.map((m) => (typeof m === "string" ? m : m.id));
    const resolvedAdmin = adminId ?? ids[0] ?? null;
    const room = makeRoom({ id: genId("room"), name, members: ids, adminId: resolvedAdmin, mode });
    this.store.putRoom(room);
    this.emit("room_created", { roomId: room.id, name: room.name, members: ids });
    return room;
  }

  getRoom(id) {
    return this.store.getRoom(id);
  }

  listRooms() {
    return this.store.listRooms();
  }

  /**
   * 用户在群里发一条，跑完 relay，返回本次发言数组。
   * @param {string} roomId
   * @param {string} text
   * @param {object} [o] {userName, notice}
   */
  async postToRoom(roomId, text, o = {}) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`未知群: ${roomId}`);
    const relay = new Relay(this, room);
    return relay.post(text, o);
  }

  /** 停掉所有 runtime，释放锁。 */
  async shutdown() {
    for (const rt of this.runtimes.values()) {
      await rt.stop();
    }
    this.runtimes.clear();
    this.store.flushExchanges();
    this.store.releaseLock();
  }
}

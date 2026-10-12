// relay.mjs — 群聊回合引擎（纯 Node 编排）。
//
// 与 DS-Bot 的结构性差异：DS-Bot 需要一个隐藏的 relay session 承载群回合，
// 并在 llm/stream 上劫持、合成 group_relay tool-call。本编排器本身就是 relay，
// 所以群回合是纯 Node 代码，无 relay session、无 stream 劫持。
//
// 回合模型（一次用户发言触发一次 relay 运行）：
//   - speakers 是一个 FIFO 队列，初始为 openingSpeakers（按 mode + @mention 选出）。
//   - 逐个串行：给成员构建 roomPrompt → 投递到该成员的 room-scoped runtime → 收回复。
//   - 回复为 [PASS]/空 → 记 passed，跳过。
//   - 回复里的 @点名 → 把被叫者 unshift 回队首（= 插到当前说话者之后），
//     受每人每次 relay 的点名上限约束（成员 2 次、admin 4 次）。
//   - 队列空 或 总回合数达 ROOM_MAX_ROUNDS → 收敛。
// 抄自 DS-Bot 的调参：ROOM_LOG_KEEP、PASS_TOKEN、mention 上限、ROOM_MAX_ROUNDS。

import {
  appendRoomLog,
  isPass,
  makeMessage,
  parseMentions,
  hasMentionAll,
  roomPrompt,
} from "./domain.mjs";
import {
  ROOM_TURN_TIMEOUT_MS,
  ROOM_MAX_ROUNDS,
  MENTION_LIMIT_PER_ROUND,
  ADMIN_MENTION_LIMIT_PER_ROUND,
} from "./constants.mjs";

export class Relay {
  /**
   * @param {object} orch Orchestrator 实例（提供 runtimeFor / nativeTurn / getBot / store / emit）
   * @param {object} room 群记录（含 members / adminId / mode / log）
   * @param {object} [run] 承载本次群回合的 room Run {id, signal}
   */
  constructor(orch, room, run = null) {
    this.orch = orch;
    this.room = room;
    this.run = run;
  }

  /** 群成员的花名册记录数组（保序）。 */
  members() {
    return this.room.members
      .map((id) => this.orch.getBot(id))
      .filter(Boolean);
  }

  isAdmin(botId) {
    return botId === this.room.adminId;
  }

  /**
   * 用户在群里发一条消息，跑完整个 relay，返回本次 relay 产生的所有发言
   * （[{botId, name, text, passed}]）。
   * @param {string} userText
   * @param {object} [o]
   * @param {string} [o.userName] 展示名，默认 "用户"
   * @param {string} [o.notice] 传给成员的额外提示
   */
  async post(userText, { userName = "用户", notice = "" } = {}) {
    const room = this.room;
    const members = this.members();
    if (!members.length) {
      this.orch.emit("room_empty", { roomId: room.id });
      return [];
    }

    // 1) 用户消息进 log
    appendRoomLog(room, makeMessage({ kind: "user", from: "user", fromName: userName, text: userText }));
    this.orch.store.putRoom(room);
    this.orch.emit("room_user_post", { roomId: room.id, text: userText });

    // 2) 选出开场说话者
    const opening = this._openingSpeakers(userText, members);
    this.orch.emit("room_round_start", {
      roomId: room.id,
      speakers: opening.map((b) => b.name),
      mode: room.mode,
    });

    // 3) 串行跑队列
    const queue = [...opening];
    const spoken = [];
    const mentionBudget = new Map(); // botId → 剩余点名次数
    for (const m of members) {
      mentionBudget.set(
        m.id,
        this.isAdmin(m.id) ? ADMIN_MENTION_LIMIT_PER_ROUND : MENTION_LIMIT_PER_ROUND,
      );
    }

    let turns = 0;
    while (queue.length && turns < ROOM_MAX_ROUNDS) {
      // 取消传播：room Run 被取消后不再开启新的成员回合。
      if (this.run?.signal?.aborted) break;
      // 预算耗尽：不再开新回合（额度由真实原生用量核对）。
      if (this.run?.shouldStop?.()) {
        this.orch.emit("room_turn_budget_stop", { roomId: room.id, turns });
        break;
      }
      const speaker = queue.shift();
      turns += 1;
      const after = [...queue];
      const prompt = roomPrompt({
        room,
        members,
        self: speaker,
        turnNumber: turns,
        after,
        notice,
      });

      let replyText = "";
      try {
        const scope = `room:${room.id}`;
        const rt = await this.orch.runtimeFor(speaker.id, scope, { runId: this.run?.id });
        const res = await this.orch.nativeTurn({
          runtime: rt,
          runId: this.run?.id ?? null,
          signal: this.run?.signal,
          botId: speaker.id,
          scope,
          text: prompt,
          timeoutMs: ROOM_TURN_TIMEOUT_MS,
        });
        replyText = res.text ?? "";
      } catch (e) {
        replyText = "";
        this.orch.emit("room_turn_error", {
          roomId: room.id,
          bot: speaker.name,
          error: e?.message ?? String(e),
        });
      }

      const passed = isPass(replyText);
      spoken.push({ botId: speaker.id, name: speaker.name, text: replyText, passed });

      if (!passed) {
        appendRoomLog(
          room,
          makeMessage({ kind: "bot", from: speaker.id, fromName: speaker.name, text: replyText }),
        );
        this.orch.store.putRoom(room);
        this.orch.emit("room_bot_post", { roomId: room.id, bot: speaker.name, text: replyText });

        // 处理 @点名，插入队首（= 当前说话者之后）
        const inserted = this._enqueueMentions(queue, speaker, replyText, members, mentionBudget);
        if (inserted.length) {
          this.orch.emit("room_mentions", {
            roomId: room.id,
            by: speaker.name,
            called: inserted.map((b) => b.name),
          });
        }
      } else {
        this.orch.emit("room_bot_pass", { roomId: room.id, bot: speaker.name });
      }
    }

    this.orch.emit("room_round_end", { roomId: room.id, turns, capped: turns >= ROOM_MAX_ROUNDS });
    return spoken;
  }

  /**
   * 选开场说话者。
   * admin 模式：普通消息只给 admin；若用户 @ 了具体成员，则被 @ 者先说。
   * everyone 模式：全员轮流，admin 先。
   */
  _openingSpeakers(userText, members) {
    const mentioned = parseMentions(userText, members);
    if (this.room.mode === "everyone") {
      const admin = members.find((m) => this.isAdmin(m.id));
      const rest = members.filter((m) => !this.isAdmin(m.id));
      return admin ? [admin, ...rest] : members;
    }
    // admin 模式
    if (mentioned.length) {
      // 用户点名了谁，谁先说；admin 兜底跟着（若未被点名）
      const admin = members.find((m) => this.isAdmin(m.id));
      const list = [...mentioned];
      if (admin && !list.some((b) => b.id === admin.id)) list.push(admin);
      return list;
    }
    const admin = members.find((m) => this.isAdmin(m.id)) ?? members[0];
    return [admin];
  }

  /**
   * 把 speaker 回复里的 @点名插到队首，返回实际插入的 bot 数组。
   * @all 仅 admin 有效，展开为其余全体成员。
   */
  _enqueueMentions(queue, speaker, text, members, mentionBudget) {
    const budget = mentionBudget.get(speaker.id) ?? 0;
    if (budget <= 0) return [];

    let called;
    if (this.isAdmin(speaker.id) && hasMentionAll(text)) {
      called = members.filter((m) => m.id !== speaker.id);
    } else {
      called = parseMentions(text, members).filter((m) => m.id !== speaker.id);
    }
    if (!called.length) return [];

    const take = called.slice(0, budget);
    mentionBudget.set(speaker.id, budget - take.length);

    // 插到队首，保持 called 的相对顺序：逆序 unshift。
    for (let i = take.length - 1; i >= 0; i--) {
      const bot = take[i];
      if (!queue.some((q) => q.id === bot.id)) queue.unshift(bot);
    }
    return take;
  }
}

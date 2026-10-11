// domain.mjs — 核心数据形状与归一化。
// 领域建模：花名册/群用 registry（id→记录），bot 运行态用显式状态机，
// 消息用带 kind 的统一形状，避免散落的布尔判断。

import { ROOM_MODES, PASS_TOKEN, ROOM_LOG_KEEP } from "./constants.mjs";

let idSeq = 0;
export function genId(prefix) {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

/** bot 的花名册记录（持久化）。 */
export function makeBot({ id, name, role = "", instructions = "", model = "", isMain = false }) {
  if (!id) throw new Error("bot 需要 id");
  if (!name) throw new Error("bot 需要 name");
  return {
    id,
    name,
    role,
    instructions,
    model,
    isMain,
    createdAt: Date.now(),
  };
}

/** 群记录（持久化）。members 是 bot id 数组，adminId 是主答者。 */
export function makeRoom({ id, name, members = [], adminId = null, mode = "admin" }) {
  if (!id) throw new Error("room 需要 id");
  if (!ROOM_MODES.includes(mode)) throw new Error(`未知群模式: ${mode}`);
  return {
    id,
    name: name || id,
    members: [...members],
    adminId: adminId ?? members[0] ?? null,
    mode,
    log: [], // Message[]，有界 ROOM_LOG_KEEP
    createdAt: Date.now(),
  };
}

/**
 * 统一消息形状。
 * kind: 'user' | 'bot' | 'system'
 * from: 发送者标识（bot id / 'user' / 显示名）
 * fromName: 展示名（@ 解析和署名用）
 */
export function makeMessage({ kind, from, fromName = "", text, at = Date.now(), meta = null }) {
  return { kind, from, fromName, text, at, meta };
}

/** bot→bot 投递记录（持久化，有界）。 */
export function makeExchange({ id, from, to, requestText, scope = "private" }) {
  return {
    id,
    from,
    to,
    scope,
    requestText,
    replyText: null,
    status: "pending", // pending | replied | failed | timeout
    error: null,
    hop: 0,
    at: Date.now(),
  };
}

// ---- 归一化 / 查询 ----

/** 把 room.log 追加一条并裁剪到上限。就地修改 room。 */
export function appendRoomLog(room, message) {
  room.log.push(message);
  if (room.log.length > ROOM_LOG_KEEP) {
    room.log = room.log.slice(-ROOM_LOG_KEEP);
  }
  return room;
}

/** 判断一条成员发言是否算「本轮不发言」。 */
export function isPass(text) {
  const t = (text ?? "").trim();
  return t === "" || t === PASS_TOKEN || t.toUpperCase() === PASS_TOKEN;
}

/**
 * 从文本里解析 @点名，按文本出现顺序返回 bot 记录数组（去重、保序）。
 * 每个 @ 位置只取最长名匹配，避免 "Bob" 命中 "Bobby" 的前缀；
 * 名字后紧跟字母/数字/连字符时不算点名（如 @Bobbyx 不命中 Bobby）。
 * 顺序按 @ 在文本里的位置，供群聊 relay 决定发言次序。
 * @param {string} text
 * @param {Array<{id,name}>} bots 候选名册
 */
export function parseMentions(text, bots) {
  if (!text) return [];
  const byNameDesc = [...bots].sort((a, b) => b.name.length - a.name.length);
  const hit = [];
  const seen = new Set();
  let i = text.indexOf("@");
  while (i !== -1) {
    const rest = text.slice(i + 1);
    for (const b of byNameDesc) {
      if (rest.length < b.name.length) continue;
      if (rest.slice(0, b.name.length).toLowerCase() !== b.name.toLowerCase()) continue;
      const after = rest[b.name.length];
      if (after !== undefined && /[\w-]/.test(after)) continue;
      if (!seen.has(b.id)) {
        seen.add(b.id);
        hit.push(b);
      }
      break; // 该 @ 位置只取最长匹配
    }
    i = text.indexOf("@", i + 1);
  }
  return hit;
}

/** 是否包含 @all（仅 admin 生效由调用方判断）。 */
export function hasMentionAll(text) {
  return /@all(?![\w-])/i.test(text ?? "");
}

/**
 * 给成员看的群聊 prompt（串行队列语义）。
 * @param {object} o
 * @param {object} o.room 群记录
 * @param {Array} o.members 成员花名册记录
 * @param {object} o.self 当前说话者
 * @param {number} o.turnNumber 本次 relay 已进行到的发言序号（从 1 起）
 * @param {Array} o.after 排在当前说话者之后的成员（可能为空）
 * @param {string} [o.notice] 额外提示
 */
export function roomPrompt({ room, members, self, turnNumber, after = [], notice }) {
  const roster = members.map((m) => (m.id === self.id ? `${m.name}（你）` : m.name)).join("、");
  const recent = room.log
    .slice(-ROOM_LOG_KEEP)
    .map((m) => `[${m.fromName || m.from}] ${m.text}`)
    .join("\n");
  const afterLine = after.length ? after.map((m) => m.name).join("、") : "（没有了，你是这一串的最后）";
  const otherName = members.find((m) => m.id !== self.id)?.name ?? "某人";
  return [
    `你在群聊「${room.name}」里。成员：${roster}。`,
    notice ? `提示：${notice}` : "",
    `这是本次讨论的第 ${turnNumber} 次发言，轮到你了。你之后还排着：${afterLine}。`,
    `群里到目前为止的消息：\n${recent || "（暂无）"}`,
    ``,
    `请就上面的对话作出你的回应。如果这次你没什么可补充的，只回复 ${PASS_TOKEN}。`,
    `如果你想让某个成员接着说，在回复里用 @名字 点名（例如 @${otherName}）。`,
  ]
    .filter(Boolean)
    .join("\n");
}

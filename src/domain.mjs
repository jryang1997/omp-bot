// domain.mjs — 核心数据形状与归一化。
// 领域建模：花名册/群用 registry（id→记录），bot 运行态用显式状态机，
// 消息用带 kind 的统一形状，避免散落的布尔判断。

import { createHash } from "node:crypto";
import {
  ROOM_MODES,
  PASS_TOKEN,
  ROOM_LOG_KEEP,
  EXECUTION_MODES,
  APPROVAL_MODES,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_MEMORY_ENABLED,
  EXECUTION_MODE_RANK,
  PERMISSION_LEVELS,
  RUN_STATES,
  TERMINAL_RUN_STATES,
} from "./constants.mjs";

let idSeq = 0;
export function genId(prefix) {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

// ---- 电脑（共享电脑上每个 Bot 一个座席）----
// 绑定只由服务端持有：bot.computer 是 null 或 {runtime,kind,image}，
// 不接受客户端指定电脑 id、地址、token 或宿主文件。电脑 id 由 botId 派生，稳定且不可伪造。

/** 支持的电脑运行时与形态（当前只有应用自管的 QEMU 客机）。 */
export const COMPUTER_RUNTIMES = ["qemu"];
export const COMPUTER_KINDS = ["vm"];

/** 归一化电脑绑定；非法形状显式报错，绝不静默当成未绑定。 */
export function normalizeComputer(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("bot.computer 必须是对象或 null");
  if (!COMPUTER_RUNTIMES.includes(raw.runtime)) throw new Error(`未知电脑运行时: ${raw.runtime}`);
  if (!COMPUTER_KINDS.includes(raw.kind)) throw new Error(`未知电脑类型: ${raw.kind}`);
  const image = typeof raw.image === "string" ? raw.image.trim() : "";
  if (!image) throw new Error("bot.computer.image 必填（镜像标识）");
  return { runtime: raw.runtime, kind: raw.kind, image };
}

/** 服务端电脑 id 规则：pc_ + sha256(botId) 前 24 位十六进制。 */
export function computerIdFor(botId) {
  const id = String(botId ?? "");
  if (!id) throw new Error("computerIdFor 需要 botId");
  return `pc_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

// ---- 头像 ----
// 吉祥物的取值和 web/vendor/mascot/omp-mascot.js 导出的常量一致（test/unit.mjs 对照检查）。
// 浏览器文件里定义了自定义元素，服务端不能直接导入，所以这里列一份。

export const MASCOT_BODY_IDS = ["cursor", "blob", "circle", "squircle", "capsule", "drop", "shield", "hexagon", "diamond", "star"];
/** 新建 bot 和没有头像字段的老 bot 都用这个身体。 */
export const DEFAULT_MASCOT_BODY = "cursor";
export const MASCOT_COLOR_IDS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];
export const MASCOT_EXPRESSIONS = ["idle", "happy", "curious", "drowsy", "working", "thinking", "listening", "sleeping", "suspicious", "proud"];
export const AVATAR_CROPS = ["mascot", "circle", "rounded", "square"];
export const AVATAR_ZOOM_MIN = 1;
export const AVATAR_ZOOM_MAX = 3;
/** Main Bot 的形象固定：star 身体加专用蓝色，这个颜色不在 10 色里，别的 bot 用不了。 */
export const MAIN_MASCOT_BODY = "star";
export const MAIN_MASCOT_COLOR = "#4D6BFE";
/** 上传的头像只能是附件接口的预览地址。附件本身是不是图片、属于谁，由 orchestrator 查附件登记。 */
export const AVATAR_URL_PATTERN = /^\/api\/attachments\/(att_[a-z0-9_]{1,64})\/preview$/;
const AVATAR_KEYS = ["body", "color", "expression", "crop", "url", "zoom", "focusX", "focusY"];

/** 按 id 确定性挑颜色：FNV-1a 取模，同一个 id 永远同一个颜色。 */
export function mascotColorFor(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id ?? "")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return MASCOT_COLOR_IDS[h % MASCOT_COLOR_IDS.length];
}

function blankAvatar(color, body) {
  return { body, color, expression: null, crop: "mascot", url: null, zoom: 1, focusX: 0.5, focusY: 0.5 };
}

/** 一个 bot 的默认形象。Main Bot 永远是固定形象。 */
export function defaultAvatar({ id, isMain = false } = {}) {
  return isMain ? blankAvatar(MAIN_MASCOT_COLOR, MAIN_MASCOT_BODY) : blankAvatar(mascotColorFor(id), DEFAULT_MASCOT_BODY);
}

const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * 把存下来的头像补齐成当前形状。宽松：不认识的取值换成默认值，不抛错。
 * 校验用户输入走 validateAvatarPatch。
 */
export function normalizeAvatar(raw, { id, isMain = false } = {}) {
  const base = defaultAvatar({ id, isMain });
  if (isMain || !raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const url = typeof raw.url === "string" && AVATAR_URL_PATTERN.test(raw.url) ? raw.url : null;
  const crop = AVATAR_CROPS.includes(raw.crop) && (raw.crop === "mascot" || url) ? raw.crop : "mascot";
  return {
    body: MASCOT_BODY_IDS.includes(raw.body) ? raw.body : base.body,
    color: MASCOT_COLOR_IDS.includes(raw.color) ? raw.color : base.color,
    expression: MASCOT_EXPRESSIONS.includes(raw.expression) ? raw.expression : null,
    crop,
    url,
    zoom: inRange(raw.zoom, AVATAR_ZOOM_MIN, AVATAR_ZOOM_MAX) ? round(raw.zoom, 2) : 1,
    focusX: inRange(raw.focusX, 0, 1) ? round(raw.focusX, 3) : 0.5,
    focusY: inRange(raw.focusY, 0, 1) ? round(raw.focusY, 3) : 0.5,
  };
}

function avatarError(message, code = "avatar_invalid") {
  const e = new Error(message);
  e.status = 400;
  e.code = code;
  return e;
}

/**
 * 严格校验接口传来的头像改动，返回合并后的完整头像。
 * 拒绝改 Main Bot 的形象、拒绝别的 bot 用 Main Bot 的颜色、拒绝非附件地址的图片。
 * @param {unknown} patch 只含要改的字段
 * @param {{id?:string, isMain?:boolean, current?:object}} bot
 */
export function validateAvatarPatch(patch, { id, isMain = false, current = null } = {}) {
  if (isMain) throw avatarError("主助手的形象是固定的，不能改", "avatar_main_fixed");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw avatarError("avatar 必须是对象");
  for (const key of Object.keys(patch)) {
    if (!AVATAR_KEYS.includes(key)) throw avatarError(`avatar 不认识的字段：${key}`);
  }
  const next = { ...normalizeAvatar(current, { id }), ...patch };
  if (!MASCOT_BODY_IDS.includes(next.body)) throw avatarError(`未知身体：${next.body}`);
  if (typeof next.color === "string" && next.color.toLowerCase() === MAIN_MASCOT_COLOR.toLowerCase()) {
    throw avatarError("这个颜色是主助手专用的，换一个", "avatar_color_reserved");
  }
  if (!MASCOT_COLOR_IDS.includes(next.color)) throw avatarError(`未知颜色：${next.color}，可选 ${MASCOT_COLOR_IDS.join("、")}`);
  if (next.expression !== null && !MASCOT_EXPRESSIONS.includes(next.expression)) throw avatarError(`未知表情：${next.expression}`);
  if (!AVATAR_CROPS.includes(next.crop)) throw avatarError(`未知裁切方式：${next.crop}`);
  if (next.url !== null && (typeof next.url !== "string" || !AVATAR_URL_PATTERN.test(next.url))) {
    throw avatarError("头像图片只能用上传到本应用的附件", "avatar_url_invalid");
  }
  if (next.crop !== "mascot" && !next.url) throw avatarError("先上传一张图片，再选裁切方式");
  if (!inRange(next.zoom, AVATAR_ZOOM_MIN, AVATAR_ZOOM_MAX)) throw avatarError(`缩放要在 ${AVATAR_ZOOM_MIN} 到 ${AVATAR_ZOOM_MAX} 倍之间`);
  if (!inRange(next.focusX, 0, 1) || !inRange(next.focusY, 0, 1)) throw avatarError("焦点要在 0 到 1 之间");
  return normalizeAvatar(next, { id });
}

/** 头像地址指向的附件 id；不是附件地址时返回 null。 */
export function avatarAttachmentId(url) {
  return typeof url === "string" ? (AVATAR_URL_PATTERN.exec(url)?.[1] ?? null) : null;
}

/**
 * 旧的执行档乘审批档归到三档。chat 归只聊天，审批档 yolo 归全部放手，其余归先问我。
 * @param {{executionMode?:string, approvalMode?:string}} modes
 * @returns {"chat"|"ask"|"full"}
 */
export function permissionOf({ executionMode, approvalMode } = {}) {
  if ((executionMode ?? DEFAULT_EXECUTION_MODE) === "chat") return "chat";
  if ((approvalMode ?? DEFAULT_APPROVAL_MODE) === "yolo") return "full";
  return "ask";
}

/** 一档对应的内部组合；未知档位抛 permission_invalid。 */
export function permissionModes(level) {
  const modes = Object.hasOwn(PERMISSION_LEVELS, level) ? PERMISSION_LEVELS[level] : null;
  if (!modes) {
    const e = new Error(`未知权限档: ${level}`);
    e.status = 400;
    e.code = "permission_invalid";
    throw e;
  }
  return { ...modes };
}

/**
 * bot 的花名册记录（持久化）。
 * executionMode / approvalMode / workspace / memoryEnabled / skills / budget 共同决定
 * 这个 bot 的 runtime 能复用什么进程：policySignature 一变就必须重建进程。
 * supervised 是「走原生审批」的诚实描述，不是 OS 沙箱。
 */
export function makeBot({
  id,
  name,
  role = "",
  instructions = "",
  model = "",
  thinking = "",
  isMain = false,
  executionMode = DEFAULT_EXECUTION_MODE,
  approvalMode = DEFAULT_APPROVAL_MODE,
  workspace = "",
  memoryEnabled = DEFAULT_MEMORY_ENABLED,
  skills = null,
  budget = null,
  computer = null,
  avatar = null,
} = {}) {
  if (!id) throw new Error("bot 需要 id");
  if (!name) throw new Error("bot 需要 name");
  if (!EXECUTION_MODES.includes(executionMode)) throw new Error(`未知执行模式: ${executionMode}`);
  if (!APPROVAL_MODES.includes(approvalMode)) throw new Error(`未知审批档: ${approvalMode}`);
  ({ executionMode, approvalMode } = permissionModes(permissionOf({ executionMode, approvalMode })));
  if (skills !== null && !Array.isArray(skills)) throw new Error("skills 必须是数组或 null");
  const normalizedBudget = normalizeBudget(budget, "bot.budget");
  return {
    id,
    name,
    role,
    instructions,
    model,
    thinking,
    isMain,
    executionMode,
    approvalMode,
    workspace: workspace || "",
    memoryEnabled: memoryEnabled === true,
    skills: skills === null ? null : [...skills],
    budget: normalizedBudget,
    computer: normalizeComputer(computer),
    avatar: normalizeAvatar(avatar, { id, isMain }),
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
/**
 * omp-bot 发给 bot 的消息第一行：场景和发送者，例如「[私聊，用户]」「[群聊，产品群]」。
 * mnemopi 存原文时这一行跟着进库，bot 以后回想得起是谁、在哪说的。
 */
export function sceneTag({ room = null, sender = "用户" } = {}) {
  const clean = (v) => String(v ?? "").replace(/[\r\n\[\]]+/g, " ").trim();
  return room ? `[群聊，${clean(room) || "未命名群"}]` : `[私聊，${clean(sender) || "用户"}]`;
}

/** 运行来源对应的发送者称呼（没有显式 sender 时用）。 */
export function senderOf(source) {
  const s = String(source ?? "");
  if (!s || s === "user") return "用户";
  if (s.startsWith("device:")) return "用户（手机）";
  if (s.startsWith("feishu:")) return "飞书";
  if (s === "routine") return "定时任务";
  if (s === "bot") return "其他 bot";
  return s;
}

export function roomPrompt({ room, members, self, turnNumber, after = [], notice }) {
  const roster = members.map((m) => (m.id === self.id ? `${m.name}（你）` : m.name)).join("、");
  const recent = room.log
    .slice(-ROOM_LOG_KEEP)
    .map((m) => `[${m.fromName || m.from}] ${m.text}`)
    .join("\n");
  const afterLine = after.length ? after.map((m) => m.name).join("、") : "（没有了，你是这一串的最后）";
  const otherName = members.find((m) => m.id !== self.id)?.name ?? "某人";
  return [
    sceneTag({ room: room.name }),
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

// ---- 运行策略：进程复用签名 / 预算与能力收窄 ----

/** 策略版本：语义变化时必须改，避免旧版本的宽松进程被新版本复用。 */
export const POLICY_VERSION = 3;

/**
 * 把旧记录补齐成当前形状（升级时用，不改用户已有取值）。
 * @returns {object|null} 归一化后的 bot；输入非法时返回 null
 */
export function normalizeBot(raw) {
  if (!raw || !raw.id || !raw.name) return null;
  // 预算单独归一：旧记录里可能出现标量/负数等非法形状，这时不能假装「无限制」，
  // 也不能让整条花名册记录消失 —— 记下 budgetInvalid，运行入口会显式拒绝该 bot。
  let budget = null;
  let budgetInvalid = null;
  try {
    budget = normalizeBudget(raw.budget, "bot.budget");
  } catch (e) {
    budgetInvalid = e?.message ?? String(e);
  }
  try {
    const bot = makeBot({
      id: raw.id,
      name: raw.name,
      role: raw.role ?? "",
      instructions: raw.instructions ?? "",
      model: raw.model ?? "",
      thinking: raw.thinking ?? "",
      isMain: raw.isMain === true,
      executionMode: raw.executionMode ?? DEFAULT_EXECUTION_MODE,
      approvalMode: raw.approvalMode ?? DEFAULT_APPROVAL_MODE,
      workspace: raw.workspace ?? "",
      memoryEnabled: raw.memoryEnabled ?? DEFAULT_MEMORY_ENABLED,
      skills: raw.skills ?? null,
      budget,
      computer: raw.computer ?? null,
      avatar: raw.avatar ?? null,
    });
    return budgetInvalid ? { ...bot, budgetInvalid } : bot;
  } catch {
    return null;
  }
}

/**
 * runtime 复用签名。执行模式、审批档、工作区、模型、思考档、技能过滤、
 * 记忆开关、电脑绑定任何一个变了都必须重建进程：宽权限进程不得承接收窄后的 Run，
 * 绑定电脑后进程要带上客机工具和对应的 overlay 审批段重新起。
 * @param {object} bot
 * 两层 AGENTS.md 的内容摘要（ctx.contextDigest）也在里面：文件变了就重启进程续上会话。
 * @param {{cwd:string, scope:string, contextDigest?:string}} ctx
 */
export function policySignature(bot, ctx) {
  const c = bot.computer ?? null;
  const parts = [
    `v${POLICY_VERSION}`,
    `mode=${bot.executionMode ?? DEFAULT_EXECUTION_MODE}`,
    `approval=${bot.approvalMode ?? DEFAULT_APPROVAL_MODE}`,
    `ws=${bot.workspace ?? ""}`,
    `model=${bot.model ?? ""}`,
    `thinking=${bot.thinking ?? ""}`,
    `skills=${(bot.skills ?? []).join(",")}`,
    `memory=${bot.memoryEnabled === true ? 1 : 0}`,
    `computer=${c ? `${c.runtime}:${c.kind}:${c.image}` : "-"}`,
    `cwd=${ctx?.cwd ?? ""}`,
    `scope=${ctx?.scope ?? ""}`,
    `context=${ctx?.contextDigest ?? ""}`,
  ];
  return parts.join("|");
}

const BUDGET_KEYS = ["maxTokens", "maxCostUsd", "maxTimeMs", "maxConcurrency"];

/** 预算非法：显式错误，绝不静默当成「无限制」。 */
function badBudget(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = "budget_invalid";
  return e;
}

/**
 * 预算归一化（唯一入口）。只接受 null/undefined，或只含受支持限制项的对象；
 * 每项必须是有限非负数字。标量、数组、NaN、负数、Infinity、未知键一律显式报错。
 * @param {unknown} budget
 * @param {string} [where] 出错信息里的定位
 * @returns {object|null}
 */
export function normalizeBudget(budget, where = "budget") {
  if (budget === null || budget === undefined) return null;
  if (typeof budget !== "object" || Array.isArray(budget)) {
    throw badBudget(
      `${where} 必须是对象或 null，收到 ${Array.isArray(budget) ? "array" : typeof budget}`,
    );
  }
  const out = {};
  for (const [k, v] of Object.entries(budget)) {
    if (!BUDGET_KEYS.includes(k)) {
      throw badBudget(`${where}.${k} 不是受支持的预算项（允许：${BUDGET_KEYS.join(", ")}）`);
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw badBudget(`${where}.${k} 必须是非负有限数字，收到 ${JSON.stringify(v)}`);
    }
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 父子预算取交集（每项取更小者）。任一方未定义的项取另一方；都未定义返回 null。
 * 子 Run 永远拿不到比父 Run 更大的额度。非有限数字一律按未定义处理（上游已归一化，这里兜底）。
 */
export function intersectBudget(parent, child) {
  const out = {};
  let any = false;
  for (const k of BUDGET_KEYS) {
    const p = Number.isFinite(parent?.[k]) ? parent[k] : null;
    const c = Number.isFinite(child?.[k]) ? child[k] : null;
    if (p === null && c === null) continue;
    out[k] = p === null ? c : c === null ? p : Math.min(p, c);
    any = true;
  }
  return any ? out : null;
}

/** 子 Run 的执行模式不得强于父 Run（chat < supervised < full）。 */
export function intersectExecutionMode(parentMode, childMode) {
  const p = EXECUTION_MODE_RANK[parentMode] ?? EXECUTION_MODE_RANK[DEFAULT_EXECUTION_MODE];
  const c = EXECUTION_MODE_RANK[childMode] ?? p;
  return c <= p ? childMode : parentMode;
}

export function isTerminalRunState(state) {
  return TERMINAL_RUN_STATES.has(state);
}

/** 运行是否还占着 scope 租约（非终态就算占用，cancelling 也算）。 */
export function isActiveRunState(state) {
  return !isTerminalRunState(state);
}

export { RUN_STATES, TERMINAL_RUN_STATES };

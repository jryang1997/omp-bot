/*
 * omp_bot browser UI.
 * Sidebar tile/row markup, transcript markup, cluster geometry,
 * and the copy icon are adapted from Fei2411/DeepSeek-Bot, Apache-2.0.
 * Source SHA bdc5fda64e2ea1e83a4d146440072a2413025df4.
 * Modified for native DOM, omp_bot HTTP/SSE endpoints, and accessible local forms.
 * See vendor/ds-bot/LICENSE and vendor/ds-bot/NOTICE.
 * Bot avatars come from workbench-avatar.js; see vendor/notion-avatar/NOTICE.
 */
import { inkText } from "./vendor/ds-bot/inks.js";
import { avatarNode, updateAvatar, colorOf, avatarEditor, randomParts, AVATAR_COLOR_IDS } from "./workbench-avatar.js";
import {
  $, el, button, toast, announce, api, bootstrapAuth, markdownFragment, runStateLabel, trapTab, svgIcon, BOT_PERMISSION_LABELS, permissionOf, fmtDay,
} from "./workbench-core.js";
import { createRunClient, createApprovalDock } from "./workbench-runs.js";
import { createPanels } from "./workbench-panels.js";
import { createAttachmentTray } from "./workbench-attach.js";

const state = {
  view: "team",
  bots: [],
  rooms: [],
  models: [],
  sel: null,
  chats: Object.create(null),
  drafts: Object.create(null),
  pending: new Map(),
  history: new Map(),
  saving: new Set(),
  roomActivity: new Set(),
  roomEvents: Object.create(null),
  unread: new Set(),
  avatarTimer: 0,
  search: "",
  revision: 0,
  refreshRequested: 0,
  refresh: null,
  usageRequest: 0,
  serial: 0,
  modalReturn: null,
  modalCleanup: null,
  drawerReturn: null,
  drawerPanel: null,
  panelTab: "detail",
  panelRequest: 0,
  advancedOpen: false,
  upkeepOpen: false,
  avatarOpen: false,
  announcedAttention: 0,
  activity: null,
  runs: null,
  dock: null,
  panels: null,
  tray: null,
};

const keyOf = (target) => `${target.kind}:${target.id}`;
const botById = (id) => state.bots.find((bot) => bot.id === id);
const roomById = (id) => state.rooms.find((room) => room.id === id);
const itemOf = (target) => target && (target.kind === "bot" ? botById(target.id) : roomById(target.id));
const isSelected = (target) => state.view === "team" && state.sel && keyOf(state.sel) === keyOf(target);
const hidden = (id, value) => $(id).classList.toggle("hidden", value);
const liveRuns = (target) => state.runs ? state.runs.activeFor(target) : [];
const conversationBusy = (target) => liveRuns(target).length > 0
  || state.pending.has(keyOf(target))
  || (target.kind === "room" && state.roomActivity.has(target.id));

/**
 * 头像的运行状态。工作中、有未读、刚发生事件的头像才动，其余静止。
 * 没有运行客户端时（启动早期）一律静止的 idle。
 */
function avatarActivity(botId) {
  const live = state.runs?.avatarState(botId) ?? { face: "idle", moving: false, until: 0 };
  return { ...live, moving: live.moving || state.unread.has(keyOf({ kind: "bot", id: botId })) };
}

/** live 的头像登记 data-avatar-bot，之后由 syncAvatars 原地换表情、动或停。 */
function botMark(bot, size = 36, working = false, live = true) {
  if (!bot) return avatarNode(null, { size });
  if (!live) return avatarNode(bot, { size, face: working ? "working" : "idle" });
  const { face, moving } = avatarActivity(bot.id);
  const node = avatarNode(bot, { size, face, animate: moving });
  node.dataset.avatarBot = bot.id;
  return node;
}

/** 按当前运行状态更新页面上所有 live 头像；开心和「刚发生」的窗口到点后再来一次，让头像停下。 */
function syncAvatars() {
  clearTimeout(state.avatarTimer);
  const now = Date.now();
  let next = Infinity;
  const seen = new Map();
  for (const node of document.querySelectorAll("[data-avatar-bot]")) {
    const id = node.dataset.avatarBot;
    const bot = botById(id);
    if (!bot) continue;
    if (!seen.has(id)) seen.set(id, avatarActivity(id));
    const activity = seen.get(id);
    if (activity.until > now) next = Math.min(next, activity.until);
    // 群头像里的座位：群在开会或有未读时一起动。
    const room = node.closest("[data-avatar-room]")?.dataset.avatarRoom;
    const roomMoving = !!room && (state.roomActivity.has(room) || state.unread.has(keyOf({ kind: "room", id: room })));
    updateAvatar(node, bot, { face: activity.face, animate: activity.moving || roomMoving });
  }
  if (next !== Infinity) state.avatarTimer = setTimeout(syncAvatars, next - now + 50);
}

// Adapted from mark.js clusterSeats and RoomAvatar.
function roomAvatar(room, size = 36) {
  const members = room.members.map(botById).filter(Boolean);
  const people = members.length === 1 ? [members[0], null] : members;
  if (!people.length) return botMark(null, size);
  let seats;
  if (people.length === 1) seats = [[0, 0, size]];
  else if (people.length === 2) seats = [[0, 0, size * 2 / 3], [size / 3, size / 3, size * 2 / 3]];
  else if (people.length === 3) {
    const seatSize = size * 5 / 9;
    const rest = size - seatSize;
    seats = [[rest / 2, 0, seatSize], [0, rest, seatSize], [rest, rest, seatSize]];
  } else {
    const half = size / 2;
    seats = [[0, 0, half], [half, 0, half], [0, half, half], [half, half, half]];
  }
  const cluster = el("span", "bt-cluster");
  cluster.dataset.avatarRoom = room.id;
  cluster.setAttribute("aria-hidden", "true");
  cluster.style.width = `${size}px`;
  cluster.style.height = `${size}px`;
  const rings = seats.map(([x, y, s]) => ({ cx: x + s / 2, cy: y + s / 2, r: s * .48 + size / 14 }));
  seats.forEach(([x, y, s], index) => {
    const overflow = people.length > 4 && index === 3;
    const seat = el("span", overflow ? "bt-cluster-more" : null, overflow ? `+${people.length - 3}` : null);
    Object.assign(seat.style, { left: `${x}px`, top: `${y}px`, width: `${s}px`, height: `${s}px` });
    const holes = rings.slice(index + 1)
      .filter((ring) => Math.hypot(ring.cx - x - s / 2, ring.cy - y - s / 2) < ring.r + s * .46)
      .map((ring) => `radial-gradient(circle at ${ring.cx - x}px ${ring.cy - y}px,transparent ${ring.r}px,#000 ${ring.r + .5}px)`);
    if (holes.length) Object.assign(seat.style, { webkitMaskImage: holes.join(","), maskImage: holes.join(","), webkitMaskComposite: "source-in", maskComposite: "intersect" });
    if (overflow) {
      Object.assign(seat.style, { width: `${s * .92}px`, height: `${s * .92}px`, margin: `${s * .04}px`, fontSize: `${Math.max(8, Math.round(s * .36))}px` });
    } else if (people[index]) seat.append(botMark(people[index], s));
    else {
      const you = el("span", "bt-cluster-you");
      Object.assign(you.style, { width: `${s * .92}px`, height: `${s * .92}px`, margin: `${s * .04}px` });
      seat.append(you);
    }
    cluster.append(seat);
  });
  return cluster;
}

function avatar(target, size) {
  const item = itemOf(target);
  return target.kind === "bot" ? botMark(item, size) : roomAvatar(item, size);
}

async function loadAll() {
  state.refreshRequested += 1;
  if (state.refresh) return state.refresh;
  state.refresh = (async () => {
    while (true) {
      const request = state.refreshRequested;
      const revision = state.revision;
      const snapshot = await api("/api/state");
      // SSE may have appended a persisted group message after this snapshot was read.
      if (request !== state.refreshRequested || revision !== state.revision) continue;
      state.bots = snapshot.bots || [];
      state.rooms = snapshot.rooms || [];
      for (const id of Object.keys(state.chats)) {
        if (!botById(id)) {
          delete state.chats[id];
          state.history.delete(id);
        }
      }
      if (state.sel && !itemOf(state.sel)) {
        state.sel = null;
        closeDrawer(false);
      }
      state.runs?.restore(snapshot);
      noteTeamGit(snapshot.team);
      renderSidebar();
      renderSelected();
      renderDock();
      updateApprovalBadge();
      return snapshot;
    }
  })();
  try { return await state.refresh; }
  finally { state.refresh = null; }
}

function noteTeamGit(team) {
  if (!team || team.git !== false || state.teamGitNoted) return;
  state.teamGitNoted = true;
  try {
    if (localStorage.getItem("omp-bot-team-git-noted")) return;
    localStorage.setItem("omp-bot-team-git-noted", "1");
  } catch { }
  toast("这台电脑没有 Git。团队设定照常保存，装上 Git 后才有改动历史。");
}

function renderSidebar() {
  const list = $("side-list");
  list.replaceChildren();
  const query = state.search.trim().toLocaleLowerCase();
  const matches = (item) => `${item.name} ${item.role || ""}`.toLocaleLowerCase().includes(query);
  const main = state.bots.find((bot) => bot.isMain);
  const botRow = (bot) => {
    const target = { kind: "bot", id: bot.id };
    const row = button("bt-row", null, () => select("bot", bot.id));
    row.dataset.botId = bot.id;
    const unread = state.unread.has(keyOf(target));
    row.setAttribute("aria-label", `${bot.name}${bot.isMain ? "，主助手" : ""}${conversationBusy(target) ? "，处理中" : ""}${unread ? "，有新消息" : ""}`);
    if (isSelected(target)) row.setAttribute("aria-current", "page");
    row.append(avatar(target, 36));
    const body = el("span", "bt-row-body");
    const name = el("span", "bt-row-name");
    name.append(el("span", "bt-row-title", bot.name));
    if (unread) name.append(el("span", "wb-unread"));
    body.append(name);
    const messages = state.chats[bot.id];
    const status = state.runs?.statusText(target);
    const preview = status || messages?.at(-1)?.text || bot.role || "还没有消息";
    body.append(el("span", "bt-row-preview", String(preview).replace(/\s+/g, " ")));
    if (status) body.append(el("span", "bt-tag wb-tag-live", status));
    row.append(body);
    return row;
  };
  const roomRow = (room) => {
    const target = { kind: "room", id: room.id };
    const row = button("bt-row", null, () => select("room", room.id));
    row.dataset.roomId = room.id;
    const unread = state.unread.has(keyOf(target));
    row.setAttribute("aria-label", `${room.name}${unread ? "，有新消息" : ""}`);
    if (isSelected(target)) row.setAttribute("aria-current", "page");
    row.append(avatar(target, 36));
    const body = el("span", "bt-row-body");
    const name = el("span", "bt-row-name");
    name.append(el("span", "bt-row-title", room.name));
    if (unread) name.append(el("span", "wb-unread"));
    body.append(name);
    const preview = state.runs?.statusText(target)
      || (conversationBusy(target) ? "群聊回合进行中…" : room.log?.at(-1)?.text || `${room.members.length} 位助手 · ${room.mode === "everyone" ? "轮流发言" : "协调助手代答"}`);
    body.append(el("span", "bt-row-preview", String(preview).replace(/\s+/g, " ")));
    row.append(body);
    return row;
  };
  const section = (label, rows) => {
    if (!rows.length) return;
    list.append(el("div", "ui-side-label", label));
    list.append(...rows);
  };
  const assistants = state.bots.filter((bot) => bot !== main);
  section("主助手", main && matches(main) ? [botRow(main)] : []);
  section("群聊", state.rooms.filter(matches).map(roomRow));
  section(main ? "其他助手" : "助手", assistants.filter(matches).map(botRow));
  if (!list.children.length) list.append(el("div", "empty-hint", query ? "没有匹配的名称或角色" : "创建一个助手，开始组建团队"));
  $("btn-usage").toggleAttribute("aria-current", state.view === "usage");
  if (state.view === "usage") $("btn-usage").setAttribute("aria-current", "page");
  $("btn-activity").toggleAttribute("aria-current", state.view === "activity");
  if (state.view === "activity") $("btn-activity").setAttribute("aria-current", "page");
  syncAvatars();
}

// 每个会话已经画过几条消息，用来只给新来的消息加进场动效。
const chatSeen = new Map();

function select(kind, id) {
  const target = { kind, id };
  if (!itemOf(target)) return;
  if (state.sel) state.drafts[keyOf(state.sel)] = $("input").value;
  state.sel = target;
  state.view = "team";
  state.unread.delete(keyOf(target));
  const fromSidebar = document.body.classList.contains("sidebar-open");
  closeDrawer(false);
  closeSidebar();
  closeNewMenu();
  $("input").value = state.drafts[keyOf(target)] || "";
  resizeInput();
  state.tray?.setBot(kind === "bot" ? id : null);
  renderSidebar();
  chatSeen.delete(keyOf(target));
  renderSelected(true);
  // 单聊马上会重新拉历史：先清掉这次的记数，等历史到了那次再算首次。
  if (kind === "bot") chatSeen.delete(keyOf(target));
  if (fromSidebar) $("head-title").focus();
  if (kind === "bot") void loadChat(id).catch((error) => toast(`历史加载失败：${error.message}`, true));
}

async function loadChat(botId) {
  const target = { kind: "bot", id: botId };
  if (state.pending.has(keyOf(target))) return;
  const request = { serial: ++state.serial, loading: true };
  state.history.set(botId, request);
  if (isSelected(target)) renderSelected();
  try {
    const { messages } = await api(`/api/chat/${encodeURIComponent(botId)}`);
    if (state.history.get(botId) !== request || !botById(botId) || state.pending.has(keyOf(target))) return;
    state.chats[botId] = messages || [];
  } finally {
    if (state.history.get(botId) === request) {
      request.loading = false;
      renderSidebar();
      if (isSelected(target)) renderSelected();
    }
  }
}

function renderSelected(scroll = false) {
  const usage = state.view === "usage";
  const activity = state.view === "activity";
  const target = state.sel;
  const item = itemOf(target);
  const chat = !usage && !activity && !!item;
  hidden("empty-state", usage || activity || chat);
  hidden("usage-view", !usage);
  hidden("activity-view", !activity);
  hidden("main-head", !chat);
  hidden("chat-log", !chat);
  hidden("composer-wrap", !chat);
  hidden("approval-dock", !chat);
  if (!chat) {
    if (activity) state.activity?.refresh?.();
    hideApprovalDock();
    return;
  }
  $("head-name").textContent = item.name;
  $("head-avatar").replaceChildren(avatar(target, 32));
  if (target.kind === "bot") {
    const status = state.runs?.statusText(target);
    $("head-sub").textContent = [item.isMain ? "主助手" : "", item.role, status].filter(Boolean).join(" · ") || "助手";
    $("btn-permissions").textContent = BOT_PERMISSION_LABELS[permissionOf(item)];
    $("btn-permissions").dataset.level = permissionOf(item);
  } else {
    const admin = botById(item.adminId)?.name || "未设置";
    $("head-sub").textContent = `${item.members.length} 位助手 · ${item.mode === "everyone" ? "轮流发言" : "协调助手代答"} · 协调助手 ${admin}`;
  }
  hidden("btn-permissions", target.kind !== "bot");
  hidden("btn-computer", target.kind !== "bot");
  $("head-title").setAttribute("aria-label", `打开 ${item.name} 的设置`);
  renderChat(scroll);
  syncBusy();
  renderDock();
}
function messageBubble(className, text) {
  const bubble = el("div", className);
  bubble.append(markdownFragment(text));
  return bubble;
}


function messageNode(message, bot, room) {
  if (message.role === "user" || message.kind === "user") {
    const row = el("div", "bt-urow");
    if (Array.isArray(message.attachments) && message.attachments.length) {
      const strip = el("div", "bt-uimages");
      for (const item of message.attachments) {
        if (String(item.mime || "").startsWith("image/")) {
          const img = el("img", "bt-uattach");
          img.src = `/api/attachments/${encodeURIComponent(item.id)}/preview`;
          img.alt = item.filename || "附件图片";
          img.loading = "lazy";
          strip.append(img);
        } else {
          strip.append(el("span", "bt-chip", item.filename || item.id));
        }
      }
      row.append(strip);
    }
    const bubble = messageBubble("bt-ububble", message.text);
    row.append(bubble);
    return row;
  }
  if (message.kind === "pass") return el("div", "bt-event", `${message.fromName} 跳过（PASS）`);
  const error = message.role === "error" || message.kind === "error";
  const row = el("div", "bt-group-msg" + (error ? " error" : ""));
  const name = el("span", "bt-group-name", error ? `${message.fromName ? `${message.fromName} · ` : ""}错误` : message.fromName || bot?.name || "助手");
  if (!error) name.style.color = inkText(colorOf(bot));
  if (room?.adminId && room.adminId === bot?.id) name.append(el("span", "bt-group-role", " 协调助手"));
  row.append(name);
  const stack = el("div", "bt-astack");
  stack.dataset.lead = "";
  const msg = el("div", "bt-msg");
  const line = el("div", "bt-msg-line");
  const lead = bot ? button("bt-lead", null, () => select("bot", bot.id)) : el("span", "bt-lead");
  if (bot) lead.setAttribute("aria-label", `打开 ${bot.name} 的私聊`);
  lead.append(botMark(bot, 22, false, false));
  const bubble = messageBubble("bt-bubble", message.text);
  if (error) bubble.setAttribute("role", "alert");
  line.append(lead, bubble);
  if (navigator.clipboard?.writeText && !error) {
    const tools = el("div", "bt-tools");
    const copy = button("bt-tool", null, async () => {
      try { await navigator.clipboard.writeText(String(message.text || "")); toast("已复制"); }
      catch (error) { toast(`复制失败：${error.message}`, true); }
    });
    copy.setAttribute("aria-label", "复制消息");
    copy.title = "复制消息";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of ["M8.5 7h6A1.5 1.5 0 0 1 16 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 7 14.5v-6A1.5 1.5 0 0 1 8.5 7z", "M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4H13"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    copy.append(svg);
    tools.append(copy);
    line.append(tools);
  }
  msg.append(line);
  stack.append(msg);
  row.append(stack);
  return row;
}

/** 空聊天：一句自我介绍加三个能直接用的开场白。点了只填输入框，不自动发送。 */
const CHAT_STARTERS = ["帮我整理一份资料", "一起想个好点子", "制定一个行动计划"];

function chatWelcome(target, item) {
  const box = el("div", "ui-chat-welcome");
  box.append(avatar(target, 48));
  box.append(el("h2", null, `你好，我是${item.name}`));
  box.append(el("p", null, item.role || "我随时可以帮你做事，先说说你想做什么。"));
  const prompts = el("div", "ui-prompts");
  for (const text of CHAT_STARTERS) {
    prompts.append(button("ui-prompt", text, () => {
      const input = $("input");
      input.value = text;
      state.drafts[keyOf(target)] = text;
      resizeInput();
      input.focus();
    }));
  }
  box.append(prompts);
  return box;
}

/** 每个会话上次画到第几条消息，用来认出新消息。 */
function renderChat(scroll = false) {
  const target = state.sel;
  const item = itemOf(target);
  if (state.view !== "team" || !item) return;
  const log = $("chat-log");
  const follow = scroll || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const previousTop = log.scrollTop;
  log.replaceChildren();
  const messages = target.kind === "bot" ? state.chats[target.id] || [] : [...(item.log || []), ...(state.roomEvents[target.id] || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
  let previousDay = "";
  // 只给这次新来的消息加进场动效：整段日志每次都会重画，全加会一起闪。切换会话后第一次画不加。
  const seenKey = keyOf(target);
  const loading = target.kind === "bot" && state.history.get(target.id)?.loading;
  const seen = chatSeen.get(seenKey);
  const freshFrom = !loading && seen != null && messages.length > seen ? seen : messages.length;
  // 切换会话时清掉记数；历史加载中不记，加载完那次画算首次，旧消息不闪。
  if (!loading) chatSeen.set(seenKey, messages.length);
  for (const [index, message] of messages.entries()) {
    const date = new Date(message.at);
    if (Number.isFinite(date.getTime())) {
      const day = fmtDay(date);
      if (day !== previousDay) {
        log.append(el("div", "bt-time-sep", day));
        previousDay = day;
      }
    }
    const speaker = target.kind === "bot" ? item : botById(message.from) || state.bots.find((bot) => bot.name === message.fromName || bot.name === message.from);
    const node = messageNode(message, speaker, target.kind === "room" ? item : null);
    if (index >= freshFrom) node.classList.add("is-new");
    log.append(node);
  }
  state.runs?.appendLive(log, target);
  if (!messages.length && !loading && !liveRuns(target).length) {
    log.append(target.kind === "bot" ? chatWelcome(target, item) : el("div", "empty-hint", "发一条消息，开始群聊回合"));
  }
  const pending = conversationBusy(target);
  const showTyping = loading || (pending && !liveRuns(target).length);
  log.setAttribute("aria-busy", String(!!loading || pending));
  if (showTyping) {
    const typing = el("div", "bt-typing");
    typing.setAttribute("role", "status");
    typing.append(avatar(target, 28));
    const text = el("span", "bt-typing-text");
    const label = el("span", "bt-typing-label");
    label.append(el("span", "bt-shimmer", loading ? "正在加载历史…" : target.kind === "bot" ? `${item.name} 正在回复…` : "群聊回合进行中…"));
    text.append(label);
    typing.append(text);
    log.append(typing);
  }
  log.scrollTop = follow ? log.scrollHeight : previousTop;
}

/**
 * Image guard: only reports a problem when the model record we actually received
 * exposes a negative image capability. Unknown capability is left to the backend error.
 */
function imageCapabilityProblem() {
  const bot = state.sel?.kind === "bot" ? botById(state.sel.id) : null;
  const selector = bot?.model;
  if (!selector) return null;
  const record = (state.models || []).find((item) => (item.selector || `${item.provider}/${item.id}`) === selector);
  if (!record) return null;
  const label = record.name || selector;
  if (record.supportsImages === false || record.supportsImageInput === false) {
    return `${label} 不支持图片输入，请换用支持视觉的模型或改用文字描述。`;
  }
  if (Array.isArray(record.capabilities) && record.capabilities.length
    && !record.capabilities.some((item) => /image|vision|multimodal/i.test(String(item)))) {
    return `${label} 的能力列表里没有图片/视觉能力，请换用支持视觉的模型。`;
  }
  return null;
}

function syncBusy() {
  const target = state.sel;
  const item = itemOf(target);
  const ready = !!target && !!item && state.view === "team";
  const loading = ready && target.kind === "bot" && !!state.history.get(target.id)?.loading;
  const busy = ready && conversationBusy(target);
  const saving = ready && state.saving.has(keyOf(target));
  const cancelling = busy && liveRuns(target).some((run) => run.state === "cancelling");
  $("btn-send").disabled = !ready || loading || saving || (target && state.pending.has(keyOf(target)));
  $("input").disabled = !ready || loading || saving;
  $("composer").setAttribute("aria-busy", String(busy));
  $("btn-stop").hidden = !busy;
  $("btn-stop").disabled = !busy || cancelling;
  $("btn-stop").textContent = cancelling ? "停止中…" : "停止";
  $("steer-mode").hidden = !busy;
  $("btn-attach").disabled = !ready || target.kind !== "bot" || saving || loading;
  if (ready) {
    $("input").placeholder = busy
      ? "还想补充什么？直接告诉助手…"
      : target.kind === "bot" ? `交给 ${item.name} 做点什么…` : `在「${item.name}」发言，可以 @助手点名`;
  }
  for (const control of document.querySelectorAll("[data-conversation-key]")) {
    const key = control.dataset.conversationKey;
    const kind = control.dataset.conversationKind;
    const id = control.dataset.conversationId;
    control.disabled = state.saving.has(key) || conversationBusy({ kind, id }) || (kind === "bot" && state.history.get(id)?.loading);
  }
}

async function send() {
  const target = state.sel && { ...state.sel };
  if (!target || !itemOf(target) || state.view !== "team" || $("btn-send").disabled) return;
  const text = $("input").value.trim();
  const attachmentIds = target.kind === "bot" ? (state.tray?.ids() || []) : [];
  if (!text && !attachmentIds.length) return;
  const key = keyOf(target);
  if (state.pending.has(key)) return;
  const active = liveRuns(target)[0];

  // Busy target: the only path is an explicit steer / follow-up on the running chain.
  if (active) {
    const behavior = $("steer-mode").value === "follow_up" ? "follow_up" : "steer";
    state.drafts[key] = "";
    $("input").value = "";
    resizeInput();
    try {
      await state.runs.steer(active.id, text, behavior);
      state.runs.note(active.id, text);
      toast(behavior === "follow_up" ? "已排队追发" : "已补充当前回合");
      announce(behavior === "follow_up" ? "已排队追发" : "已补充当前回合");
    } catch (error) {
      if (!state.drafts[key]) state.drafts[key] = text;
      if (isSelected(target) && !$("input").value) {
        $("input").value = state.drafts[key];
        resizeInput();
      }
      toast(`补充失败：${error.message}`, true);
    }
    return;
  }

  const pending = { target, text };
  state.pending.set(key, pending);
  state.drafts[key] = "";
  $("input").value = "";
  resizeInput();
  if (target.kind === "bot") {
    state.history.delete(target.id);
    (state.chats[target.id] ||= []).push({ role: "user", text, at: Date.now(), attachments: state.tray?.items() || [] });
  } else {
    state.roomEvents[target.id] = [];
    (roomById(target.id).log ||= []).push({ kind: "user", from: "user", fromName: "你", text, at: Date.now() });
    state.revision += 1;
  }
  renderSidebar();
  renderSelected(true);
  let startedRun = null;
  try {
    if (target.kind === "bot") {
      startedRun = await state.runs.start({ botId: target.id, text, attachmentIds, source: "user" });
      state.tray?.clear(target.id, attachmentIds);
    } else {
      const { spoken } = await api(`/api/rooms/${encodeURIComponent(target.id)}/say`, { method: "POST", body: { text, userName: "你" } });
      if (!spoken.length) {
        state.drafts[key] = text;
        if (isSelected(target)) {
          $("input").value = text;
          resizeInput();
        }
        toast("群里没有可用的助手，请在群设置里添加成员。消息已保留。", true);
      }
    }
  } catch (error) {
    if (target.kind === "bot" && text && botById(target.id)) (state.chats[target.id] ||= []).push({ role: "error", text: error.message, at: Date.now() });
    if (!state.drafts[key]) state.drafts[key] = text;
    if (isSelected(target) && !$("input").value) {
      $("input").value = state.drafts[key];
      resizeInput();
    }
    toast(`${itemOf(target)?.name || "会话"}：${error.message}`, true);
    announce(`发送失败：${error.message}`);
  } finally {
    if (state.pending.get(key) === pending) state.pending.delete(key);
    // 回合在提交返回前就跑完了：结束时发送还没收尾、没法拉历史，这里补拉一次。
    const settled = startedRun && state.runs.get(startedRun.id);
    if (target.kind === "bot" && settled && ["completed", "failed", "cancelled", "interrupted", "reconciliation_required"].includes(settled.state) && isSelected(target)) {
      void loadChat(target.id).catch((error) => toast(`历史加载失败：${error.message}`, true));
    }
    if (target.kind === "room") {
      state.roomActivity.delete(target.id);
      state.revision += 1;
      void loadAll().catch((error) => toast(`群聊历史刷新失败：${error.message}`, true));
    }
    renderSidebar();
    if (isSelected(target)) renderSelected(true);
    syncBusy();
  }
}

function connectSSE() {
  state.runs.connect({
    synchronize: loadAll,
    refreshConversation: async () => {
      if (state.sel?.kind === "bot") await loadChat(state.sel.id);
    },
    onConnected: () => {
      $("conn").classList.add("live");
      $("conn-label").textContent = "已连接";
      state.roomActivity.clear();
    },
    onDisconnected: () => {
      $("conn").classList.remove("live");
      $("conn-label").textContent = "连接中…";
      announce("事件流已断开，正在重连");
    },
    onInitialReplay: () => {
      if (state.view === "team") renderSelected(true);
    },
    onSynchronized: () => announce("已连接事件流"),
    onSyncError: error => {
      toast(`重新同步失败：${error.message}`, true);
      announce("事件流重新同步失败");
    },
    onConversationEvent: handleEvent,
  });
}

function handleEvent(event) {
  if (!event || typeof event.type !== "string") return;
  const target = { kind: "room", id: event.roomId };
  if (event.type === "room_bot_post" || event.type === "room_bot_pass") {
    state.revision += 1;
    const room = roomById(event.roomId);
    if (!room) {
      void loadAll().catch((error) => toast(error.message, true));
      return;
    }
    if (event.type === "room_bot_post") {
      if (!isSelected(target)) state.unread.add(keyOf(target));
      const bot = room.members.map(botById).find((bot) => bot?.name === event.bot);
      (room.log ||= []).push({ kind: "bot", from: bot?.id || event.bot, fromName: event.bot, text: event.text, at: Date.now() });
    } else {
      const notes = state.roomEvents[event.roomId] ||= [];
      const failure = notes.at(-1);
      if (failure?.kind === "error" && failure.fromName === event.bot && failure.awaitingPass) failure.awaitingPass = false;
      else notes.push({ kind: "pass", fromName: event.bot, at: Date.now() });
    }
    renderSidebar();
    if (isSelected(target)) renderSelected();
  } else if (event.type === "room_turn_error") {
    (state.roomEvents[event.roomId] ||= []).push({ kind: "error", fromName: event.bot, text: event.error, at: Date.now(), awaitingPass: true });
    toast(`${roomById(event.roomId)?.name || "群聊"} · ${event.bot}：${event.error}`, true);
    if (isSelected(target)) renderSelected();
  } else if (event.type === "room_round_start") {
    state.roomEvents[event.roomId] = [];
    state.roomActivity.add(event.roomId);
    renderSidebar();
    if (isSelected(target)) renderSelected();
  } else if (event.type === "room_round_end") {
    state.roomActivity.delete(event.roomId);
    state.revision += 1;
    void loadAll().catch((error) => toast(error.message, true));
    if (isSelected(target)) renderSelected();
  } else if (event.type === "room_user_post") {
    state.revision += 1;
    if (!state.pending.has(keyOf(target))) void loadAll().catch((error) => toast(error.message, true));
  } else if (["bot_added", "bot_updated", "bot_removed", "room_created", "room_updated", "room_removed"].includes(event.type)) {
    state.revision += 1;
    void loadAll().catch((error) => toast(`团队刷新失败：${error.message}`, true));
  } else if (event.type === "exchange_request") {
    toast(`${event.from} → ${event.to}（委派中）`);
  } else if (event.type === "bot_to_user" && !state.pending.has(keyOf({ kind: "bot", id: event.botId }))) {
    if (!isSelected({ kind: "bot", id: event.botId })) state.unread.add(keyOf({ kind: "bot", id: event.botId }));
    void loadChat(event.botId).catch((error) => toast(error.message, true));
  }
  syncBusy();
}

function field(form, labelText, node, hint) {
  node.id = `omp-field-${++state.serial}`;
  const wrap = el("div", "field");
  const label = el("label", null, labelText);
  label.htmlFor = node.id;
  wrap.append(label, node);
  if (hint) {
    const help = el("div", "hint", hint);
    help.id = `${node.id}-hint`;
    node.setAttribute("aria-describedby", help.id);
    wrap.append(help);
  }
  form.append(wrap);
  return node;
}

function option(select, value, text) {
  const node = el("option", null, text);
  node.value = value;
  select.append(node);
}

/** 高级选项统一折叠：details.ui-disclosure > summary + div.ui-disclosure-body。 */
function disclosure(summaryText, hint, stateKey) {
  const node = el("details", "ui-disclosure");
  node.append(el("summary", null, summaryText));
  const body = el("div", "ui-disclosure-body");
  if (hint) body.append(el("p", "hint", hint));
  node.append(body);
  if (stateKey) {
    node.open = !!state[stateKey];
    node.addEventListener("toggle", () => { state[stateKey] = node.open; });
  }
  return { node, body };
}

function targetControl(control, target) {
  control.dataset.conversationKey = keyOf(target);
  control.dataset.conversationKind = target.kind;
  control.dataset.conversationId = target.id;
  return control;
}

function saveForm(form, target, label, read, onSave) {
  const submit = el("button", "btn primary wide", label);
  submit.type = "submit";
  if (target) targetControl(submit, target);
  form.append(submit);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const key = target ? keyOf(target) : form.id;
    if (state.saving.has(key) || (target && conversationBusy(target))) return;
    const data = read();
    if (!data) return;
    state.saving.add(key);
    const controls = [...form.elements];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    submit.textContent = "保存中…";
    form.setAttribute("aria-busy", "true");
    syncBusy();
    try { await onSave(data); }
    catch (error) { toast(error.message, true); }
    finally {
      state.saving.delete(key);
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      submit.textContent = label;
      form.setAttribute("aria-busy", "false");
      syncBusy();
    }
  };
}

function botForm(bot, onSave) {
  const form = el("form");
  form.id = `omp-form-${++state.serial}`;
  if (!bot) form.append(el("p", "ui-intro", "给助手起个名字，再告诉它擅长什么。"));
  const name = field(form, "助手名称", Object.assign(el("input"), { value: bot?.name || "", placeholder: "如 Ada", required: true }));
  const role = field(form, "擅长什么", Object.assign(el("input"), { value: bot?.role || "", placeholder: "如 查资料、写周报" }), "一句话概括，会显示在名单和聊天标题上。");
  const instructions = field(form, "工作偏好与专属指令", Object.assign(el("textarea"), { value: bot?.instructions || "", rows: 5 }));
  // 新建时就能捏脸；建好以后在详情页的「形象」里改，或者换成图片。
  let look = null;
  if (!bot) {
    look = { parts: randomParts(), color: AVATAR_COLOR_IDS[Math.floor(Math.random() * AVATAR_COLOR_IDS.length)] };
    const face = disclosure("形象", "随手捏一张脸，建好以后还能改。");
    face.body.append(avatarEditor({ avatar: look }, { onChange: (draft) => { look = { parts: draft.parts, color: draft.color }; } }));
    form.append(face.node);
  }
  const advanced = disclosure("高级设置", "换模型、调思考程度，或者把它设为主助手。");
  const model = el("select");
  option(model, "", "（默认模型）");
  for (const item of state.models) option(model, item.selector || `${item.provider}/${item.id}`, item.name || item.id);
  if (bot?.model && ![...model.options].some((item) => item.value === bot.model)) option(model, bot.model, bot.model);
  model.value = bot?.model || "";
  field(advanced.body, "模型", model, "使用已连接的模型，留空沿用默认配置。");
  const thinking = el("select");
  for (const [value, label] of [["", "默认"], ["off", "关闭"], ["low", "轻量"], ["medium", "均衡"], ["high", "深入"], ["xhigh", "更深入"], ["max", "最深入"]]) option(thinking, value, label);
  thinking.value = bot?.thinking || "";
  field(advanced.body, "思考程度", thinking, "想得越久通常越准，也更慢。");
  const main = Object.assign(el("input"), { type: "checkbox", checked: bot ? !!bot.isMain : state.bots.length === 0 });
  main.id = `omp-field-${++state.serial}`;
  const label = el("label", "checkline");
  label.htmlFor = main.id;
  label.append(main, document.createTextNode("设为主助手（群聊里默认主持发言）"));
  advanced.body.append(label);
  form.append(advanced.node);
  saveForm(form, bot ? { kind: "bot", id: bot.id } : null, bot ? "保存" : "创建", () => {
    if (!name.value.trim()) { name.focus(); toast("助手名称必填", true); return null; }
    return { name: name.value.trim(), role: role.value.trim(), model: model.value, thinking: thinking.value, instructions: instructions.value, isMain: main.checked, ...(look ? { avatar: look } : {}) };
  }, onSave);
  return form;
}

function roomForm(room, onSave) {
  const form = el("form");
  form.id = `omp-form-${++state.serial}`;
  if (!room) form.append(el("p", "ui-intro", "给群聊起个名字，再勾上要参加的助手。"));
  const name = field(form, "群聊名称", Object.assign(el("input"), { value: room?.name || "", placeholder: "如 工作组", required: true }));
  const group = el("fieldset", "field");
  group.append(el("legend", null, "参加的助手（至少选一个）"));
  const members = new Set(room?.members || []);
  const picks = state.bots.map((bot) => {
    const pick = Object.assign(el("input"), { type: "checkbox", checked: members.has(bot.id) });
    pick.id = `omp-field-${++state.serial}`;
    pick.value = bot.id;
    const line = el("label", "member-pick");
    line.htmlFor = pick.id;
    line.append(pick, botMark(bot, 24), document.createTextNode(`${bot.name}${bot.role ? ` · ${bot.role}` : ""}`));
    group.append(line);
    return pick;
  });
  form.append(group);
  const advanced = disclosure("高级设置", "改发言方式，或指定由哪位助手代表群聊回答。");
  const mode = el("select");
  option(mode, "admin", "协调助手代答 + @点名");
  option(mode, "everyone", "所有助手轮流发言");
  mode.value = room?.mode || "admin";
  field(advanced.body, "发言方式", mode);
  const admin = el("select");
  function refreshAdmins(value = admin.value) {
    admin.replaceChildren();
    option(admin, "", "（默认第一个成员）");
    for (const pick of picks) if (pick.checked) option(admin, pick.value, botById(pick.value).name);
    admin.value = [...admin.options].some((item) => item.value === value) ? value : "";
  }
  picks.forEach((pick) => { pick.onchange = () => refreshAdmins(); });
  refreshAdmins(room?.adminId || "");
  field(advanced.body, "协调助手", admin, "群聊里由它代表大家回答，默认是第一个成员。");
  form.append(advanced.node);
  saveForm(form, room ? { kind: "room", id: room.id } : null, room ? "保存" : "创建", () => {
    if (!name.value.trim()) { name.focus(); toast("群聊名称必填", true); return null; }
    const ids = picks.filter((pick) => pick.checked).map((pick) => pick.value);
    if (!ids.length) { picks[0]?.focus(); toast("至少选一个参加者", true); return null; }
    return { name: name.value.trim(), members: ids, adminId: admin.value || null, mode: mode.value };
  }, onSave);
  return form;
}

function openNewBot() {
  closeNewMenu();
  const form = botForm(null, async (data) => {
    const { bot } = await api("/api/bots", { method: "POST", body: data });
    if ($("modal-body").contains(form)) closeModal();
    state.revision += 1;
    await loadAll();
    select("bot", bot.id);
    toast(`已创建 ${bot.name}`);
  });
  openModal("新建助手", form);
}

function openNewRoom() {
  closeNewMenu();
  if (!state.bots.length) { toast("先建至少一个助手", true); return; }
  const form = roomForm(null, async (data) => {
    const { room } = await api("/api/rooms", { method: "POST", body: data });
    if ($("modal-body").contains(form)) closeModal();
    state.revision += 1;
    await loadAll();
    select("room", room.id);
    toast(`已创建群聊 ${room.name}`);
  });
  openModal("新建群聊", form);
}

function detailProfile(target) {
  const item = itemOf(target);
  const profile = el("div", "detail-profile bt-drawer-id");
  profile.append(avatar(target, 80), el("div", "detail-name bt-drawer-name", item.name));
  profile.append(el("div", "detail-role", target.kind === "bot" ? item.role || "助手" : `${item.members.length} 位助手 · ${item.mode === "everyone" ? "轮流发言" : "协调助手代答"}`));
  return profile;
}

/** 形象：折叠区里捏脸、换底色或换成图片，主助手也一样。 */
function avatarSection(target) {
  const bot = itemOf(target);
  const section = disclosure("形象", "捏一张脸、换底色，也可以换成一张图片。", "avatarOpen");
  section.body.append(avatarEditor(bot, {
    onSave: async (data) => {
      await api(`/api/bots/${encodeURIComponent(target.id)}`, { method: "PATCH", body: data });
      state.revision += 1;
      await loadAll();
      void renderSettingsTab(target, "detail");
      toast("形象已保存");
    },
  }));
  return section.node;
}

/** 电脑入口：页签容易看漏，详情页给一个明确的跳转。 */
function computerShortcut(target) {
  const card = el("div", "bt-set-card wb-shortcut");
  const row = button("bt-set-row", null, () => { state.panelTab = "computer"; void renderSettingsTab(target, "computer"); });
  const title = el("div", "wb-shortcut-title", "电脑");
  title.append(svgIcon(["m9 5 7 7-7 7"], "0 0 24 24", { width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  const copy = el("div", "bt-set-copy");
  copy.append(title, el("div", "bt-set-hint", "看它的桌面，需要时接管"));
  row.append(copy);
  card.append(row);
  return card;
}

async function runAction(control, target, action) {
  const key = keyOf(target);
  if (control.disabled || state.saving.has(key) || conversationBusy(target)) return;
  state.saving.add(key);
  syncBusy();
  try { await action(); }
  catch (error) { toast(error.message, true); }
  finally { state.saving.delete(key); syncBusy(); }
}

/** 抽屉里的面板可能持有定时器、监听或对象 URL（例如电脑面板）：替换内容前必须释放。 */
let panelCleanup = null;
function releasePanelCleanup() {
  const cleanup = panelCleanup;
  panelCleanup = null;
  if (cleanup) {
    try { cleanup(); } catch { /* 释放失败不能挡住新面板渲染 */ }
  }
}
function setPanelCleanup(cleanup) {
  releasePanelCleanup();
  panelCleanup = typeof cleanup === "function" ? cleanup : null;
}

function openSettings() {
  const target = state.sel && { ...state.sel };
  const item = itemOf(target);
  if (state.view !== "team" || !item) return;
  state.drawerReturn = document.activeElement;
  state.drawerPanel = null;
  hidden("drawer", false);
  $("head-title").setAttribute("aria-expanded", "true");
  $("btn-settings").setAttribute("aria-expanded", "true");
  $("drawer-title").textContent = target.kind === "bot" ? "助手设置" : "群聊设置";
  void renderSettingsTab(target, state.panelTab);
  syncBusy();
  $("drawer-close").focus();
}

const BOT_TABS = [["detail", "设置"], ["capabilities", "使用权限"], ["computer", "电脑"], ["routines", "计划"]];
/** 技能、MCP、记忆是设置的子页：从「更多设置」里进，不占顶层页签。 */
const BOT_ADVANCED_TABS = [["skills", "技能"], ["mcp", "MCP"], ["memory", "记忆"]];
const ADVANCED_HINTS = {
  skills: "装专门的技能包，用的时候自己带上",
  mcp: "接上外部工具服务，让它能用别的软件",
  memory: "看它记住了什么",
};
const PANEL_LOADERS = { capabilities: "capabilitiesPanel", skills: "skillsPanel", mcp: "mcpPanel", memory: "memoryPanel" };

async function renderSettingsTab(target, tab) {
  const item = itemOf(target);
  if (!item || !isSelected(target)) return;
  releasePanelCleanup();
  const top = target.kind === "bot" ? BOT_TABS : [["detail", "设置"]];
  const advanced = target.kind === "bot" ? BOT_ADVANCED_TABS : [];
  const sub = advanced.some(([id]) => id === tab);
  if (!sub && !top.some(([id]) => id === tab)) tab = "detail";
  state.panelTab = tab;
  // 每次渲染领一个序号：晚到的旧请求不许覆盖新面板。
  const request = ++state.panelRequest;
  $("btn-computer").setAttribute("aria-expanded", String(tab === "computer"));
  const active = document.activeElement;
  const refocusTab = !!(active instanceof Element && (active.classList.contains("bt-tab") || active.dataset.panelBack !== undefined));
  const fromDisclosure = !!(active instanceof Element && active.closest("details.ui-disclosure"));
  const content = el("div", "wb-panel-body");
  let tabBar = null;
  if (top.length > 1) {
    tabBar = el("div", "bt-tabs wb-tabs");
    tabBar.setAttribute("role", "tablist");
    tabBar.setAttribute("aria-label", "助手设置页签");
    for (const [id, label] of top) {
      const node = button("bt-tab", label, () => { state.panelTab = id; void renderSettingsTab(target, id); });
      node.setAttribute("role", "tab");
      // 子页没有自己的页签：选中它所属的顶层页，返回路径才清楚。
      node.setAttribute("aria-selected", String(id === (sub ? "detail" : tab)));
      tabBar.append(node);
    }
    tabBar.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const nodes = [...tabBar.children];
      const next = nodes[(nodes.indexOf(document.activeElement) + step + nodes.length) % nodes.length];
      if (!next) return;
      next.focus();
      next.click();
    });
  }
  // 技能、MCP、记忆放不下四个常用页签，收进「更多设置」，默认关闭。
  const more = target.kind === "bot" ? disclosure("更多设置", null, "advancedOpen") : null;
  if (more) {
    for (const [id, label] of advanced) {
      const row = button("bt-set-row", null, () => { state.panelTab = id; void renderSettingsTab(target, id); });
      if (id === tab) row.setAttribute("aria-current", "page");
      const copy = el("div", "bt-set-copy");
      copy.append(el("div", null, label), el("div", "bt-set-hint", ADVANCED_HINTS[id]));
      row.append(copy);
      more.body.append(row);
    }
  }
  const back = sub
    ? button("btn ghost", null, () => { state.panelTab = "detail"; void renderSettingsTab(target, "detail"); })
    : null;
  if (back) {
    back.dataset.panelBack = "";
    back.append(
      svgIcon(["m15 18-6-6 6-6"], "0 0 24 24", { width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round" }),
      document.createTextNode("返回设置"),
    );
  }
  const body = $("drawer-body");
  // 「更多设置」放在设置页底部（删除按钮之前），子页里放在最后方便切换；别的页签不出现。
  body.replaceChildren(...[tabBar, content, sub ? more?.node : null].filter(Boolean));
  if (back) content.append(back);
  if (refocusTab) tabBar?.querySelector('[aria-selected="true"]')?.focus();
  if (fromDisclosure && back) back.focus();
  if (tab === "detail") {
    content.append(detailProfile(target));
    if (target.kind === "bot") content.append(avatarSection(target), computerShortcut(target));
    const save = async (data) => {
      await api(`/api/${target.kind === "bot" ? "bots" : "rooms"}/${encodeURIComponent(target.id)}`, { method: "PATCH", body: data });
      state.revision += 1;
      await loadAll();
      if (target.kind === "bot") state.tray?.setBot(target.id);
      void renderSettingsTab(target, "detail");
      toast(target.kind === "bot" ? "已保存，人格和模型改动会在下一条消息生效" : "已保存群设置");
    };
    content.append(target.kind === "bot" ? botForm(item, save) : roomForm(item, save));
    // 记录维护：低频，改错代价高，默认折叠。
    const upkeep = disclosure("记录维护", target.kind === "bot"
      ? "重新读取聊天显示，或者清空显示、另起一个新会话。"
      : "重新从服务读取群聊记录。", "upkeepOpen");
    if (target.kind === "bot") {
      const reload = targetControl(button("btn ghost wide", "重新加载聊天记录", () => runAction(reload, target, async () => {
        await loadChat(target.id);
        toast("已重新加载聊天记录");
      })), target);
      const newSession = targetControl(button("btn ghost wide", "开始新会话", () => {
        if (!confirm("开启一个新会话？旧会话和聊天记录都保留，下一条消息进入新会话。")) return;
        return runAction(newSession, target, async () => {
          await api(`/api/bots/${encodeURIComponent(target.id)}/session/new`, { method: "POST", body: {} });
          toast("已开启新会话");
          announce("已开启新的原生会话");
        });
      }), target);
      const clear = targetControl(button("btn ghost wide", "清空聊天显示", () => {
        if (!confirm(`清空 ${item.name} 的聊天显示？不会删除原生 omp 会话，想开新会话请用「开始新会话」。`)) return;
        return runAction(clear, target, async () => {
          await api(`/api/chat/${encodeURIComponent(target.id)}`, { method: "DELETE" });
          state.history.delete(target.id);
          state.chats[target.id] = [];
          renderSidebar();
          if (isSelected(target)) renderSelected();
          toast("已清空显示");
        });
      }), target);
      upkeep.body.append(reload, newSession, clear);
    } else {
      const reload = targetControl(button("btn ghost wide", "重新加载群聊记录", () => runAction(reload, target, async () => {
        await loadAll();
        toast("已重新加载群聊记录");
      })), target);
      upkeep.body.append(reload);
    }
    if (more) content.append(more.node);
    content.append(upkeep.node);
    const actions = el("div", "field");
    const remove = targetControl(button("btn danger wide", target.kind === "bot" ? "删除此助手" : "删除此群聊", () => {
      const prompt = target.kind === "bot"
        ? `删除「${item.name}」？它会从名单和所有群聊里消失，原生会话文件保留在磁盘。`
        : `删除群聊「${item.name}」？群里的助手不会被删除。`;
      if (!confirm(prompt)) return;
      return runAction(remove, target, async () => {
        await api(`/api/${target.kind === "bot" ? "bots" : "rooms"}/${encodeURIComponent(target.id)}`, { method: "DELETE" });
        if (state.sel && keyOf(state.sel) === keyOf(target)) {
          state.sel = null;
          closeDrawer(false);
        }
        delete state.drafts[keyOf(target)];
        state.revision += 1;
        await loadAll();
        toast("已删除");
      });
    }), target);
    actions.append(remove);
    content.append(actions);
    syncBusy();
    return;
  }

  if (tab === "computer") {
    const view = state.panels.computerPanel(item);
    if (isSelected(target) && state.panelTab === tab && request === state.panelRequest) {
      content.replaceChildren(view.node);
      setPanelCleanup(view.dispose);
    } else view.dispose();
    return;
  }

  const loading = el("div", "bt-empty", "加载中…");
  content.append(loading);
  try {
    const view = tab === "routines" ? await state.panels.routinesPanel(item.id) : await state.panels[PANEL_LOADERS[tab]](item);
    if (isSelected(target) && state.panelTab === tab && request === state.panelRequest) {
      setPanelCleanup(view?.dispose);
      loading.replaceWith(view?.node ?? view);
    } else view?.dispose?.();
  } catch (error) {
    if (isSelected(target) && state.panelTab === tab && request === state.panelRequest) {
      loading.replaceWith(el("div", "bt-empty", `加载失败：${error.message}`));
    }
  }
}

function closeDrawer(restore = true) {
  state.panelRequest += 1;
  releasePanelCleanup();
  hidden("drawer", true);
  state.drawerPanel = null;
  $("head-title").setAttribute("aria-expanded", "false");
  $("btn-settings").setAttribute("aria-expanded", "false");
  $("btn-computer").setAttribute("aria-expanded", "false");
  if (restore && state.drawerReturn?.isConnected) state.drawerReturn.focus();
  state.drawerReturn = null;
}

const fmtCount = (value) => Number(value || 0).toLocaleString("zh-CN");

function usageMetric(label, value) {
  const node = el("div", "ui-metric");
  node.append(el("strong", "ui-metric-value", value), el("span", "ui-metric-label", label));
  return node;
}

/** 明细表在窄屏里自己横滚，不把整页撑宽。 */
function tableScroll(table) {
  const box = el("div", "ui-table-scroll");
  box.style.overflowX = "auto";
  box.append(table);
  return box;
}

function usageTable(caption, columns, rows, foot) {
  const table = el("table", "usage");
  table.append(el("caption", null, caption));
  const head = el("thead");
  const heading = el("tr");
  columns.forEach((label, index) => {
    const cell = el("th", index >= 3 ? "num" : null, label);
    cell.scope = "col";
    heading.append(cell);
  });
  head.append(heading);
  table.append(head);
  const body = el("tbody");
  for (const cells of rows) {
    const row = el("tr");
    cells.forEach((text, index) => row.append(el("td", index >= 3 ? "num" : null, text)));
    body.append(row);
  }
  table.append(body);
  if (foot) {
    const tfoot = el("tfoot");
    const total = el("tr", "total");
    foot.forEach((text, index) => total.append(el("td", index >= 3 ? "num" : null, text)));
    tfoot.append(total);
    table.append(tfoot);
  }
  return table;
}

/** 本进程 runtime 累计；账本不可用时用它兜底，口径写明是当前进程。 */
function runtimeTotals(perRuntime) {
  const totals = { requests: 0, tokensIn: 0, tokensOut: 0, totalTokens: 0, cost: 0 };
  for (const entry of perRuntime) for (const key of Object.keys(totals)) totals[key] += Number(entry[key] || 0);
  return totals;
}

async function showUsage() {
  if (state.sel) state.drafts[keyOf(state.sel)] = $("input").value;
  state.view = "usage";
  closeDrawer(false);
  closeSidebar();
  closeNewMenu();
  renderSidebar();
  renderSelected();
  const request = ++state.usageRequest;
  const view = $("usage-view");
  const title = el("h1", null, "使用情况");
  const refresh = button("btn ghost", "刷新", () => { void showUsage(); });
  refresh.disabled = true;
  view.replaceChildren(
    title,
    el("p", "ui-intro", "查看累计使用量与费用。token 是模型处理文字时使用的计量单位。"),
    refresh,
    el("div", "empty-hint", "加载中…"),
  );
  try {
    const { perRuntime = [], perRun = [], totals = {}, ledgerAvailable = false } = await api("/api/usage");
    if (request !== state.usageRequest || state.view !== "usage") return;
    const loading = view.lastChild;
    const counts = ledgerAvailable ? totals : runtimeTotals(perRuntime);
    const metrics = el("div", "ui-metrics");
    metrics.append(
      usageMetric("请求次数", fmtCount(counts.requests)),
      usageMetric("输入 token", fmtCount(counts.tokensIn)),
      usageMetric("输出 token", fmtCount(counts.tokensOut)),
      usageMetric("总 token", fmtCount(counts.totalTokens)),
    );
    const costShown = counts.costKnown !== false && typeof counts.cost === "number";
    if (costShown) metrics.append(usageMetric("费用", Number(counts.cost).toFixed(4)));
    const nodes = [metrics];
    if (!ledgerAvailable) nodes.push(el("p", "hint", "暂时读不到历史账本：上面的数字只统计当前运行中的助手。"));
    if (costShown) nodes.push(el("p", "hint", "费用由模型提供的计价信息估算，实际账单请以服务商为准。"));
    const detail = disclosure("明细表", "两张表统计口径不同，不要相加。");
    if (ledgerAvailable && perRun.length) {
      const rows = perRun.map((entry) => {
        const runBotId = entry.botId || state.runs?.get(entry.runId)?.botId;
        const cost = entry.costKnown === false || entry.cost == null ? "未知" : Number(entry.cost).toFixed(4);
        return [
          String(entry.runId || entry.id || "").slice(0, 12),
          entry.botName || (runBotId ? botById(runBotId)?.name : null) || "—",
          entry.model || "未知",
          fmtCount(entry.tokensIn ?? entry.inputTokens),
          fmtCount(entry.tokensOut ?? entry.outputTokens),
          fmtCount(entry.totalTokens),
          cost,
        ];
      });
      detail.body.append(tableScroll(usageTable(
        "每次运行（来自本机账本）",
        ["运行编号", "助手", "模型", "输入 token", "输出 token", "总 token", "费用"],
        rows,
      )));
    }
    const runtimeRows = perRuntime.map((entry) => [
      entry.botName, entry.scope, entry.model,
      fmtCount(entry.requests), fmtCount(entry.tokensIn), fmtCount(entry.tokensOut), fmtCount(entry.totalTokens),
      Number(entry.cost || 0).toFixed(4),
    ]);
    if (!perRuntime.length) {
      detail.body.append(el("div", "empty-hint", "还没有正在运行的助手。和助手聊一句，用量就会出现在这里。"));
    }
    const currentTotals = runtimeTotals(perRuntime);
    detail.body.append(tableScroll(usageTable(
      "当前运行中的助手（进程内累计）",
      ["助手", "范围", "模型", "请求", "输入 token", "输出 token", "总 token", "费用"],
      runtimeRows,
      ["合计", "", "", fmtCount(currentTotals.requests), fmtCount(currentTotals.tokensIn), fmtCount(currentTotals.tokensOut), fmtCount(currentTotals.totalTokens), Number(currentTotals.cost || 0).toFixed(4)],
    )));
    loading.replaceWith(...nodes, detail.node);
  } catch (error) {
    if (request !== state.usageRequest || state.view !== "usage") return;
    view.lastChild.textContent = `加载失败：${error.message}`;
    toast(error.message, true);
  } finally {
    if (request === state.usageRequest) refresh.disabled = false;
  }
}

function showActivity() {
  if (state.sel) state.drafts[keyOf(state.sel)] = $("input").value;
  state.view = "activity";
  closeDrawer(false);
  closeSidebar();
  closeNewMenu();
  const view = $("activity-view");
  if (!state.activity) {
    state.activity = state.panels.activityView();
    view.replaceChildren(state.activity.node);
  }
  renderSidebar();
  renderSelected();
}

function hideApprovalDock() {
  const dock = $("approval-dock");
  dock.replaceChildren();
  dock.classList.add("hidden");
}

function renderDock() {
  if (!state.dock) return;
  if (state.view !== "team" || !state.sel || !itemOf(state.sel)) return hideApprovalDock();
  state.dock.setTarget(state.sel);
  state.dock.render($("approval-dock"), state.sel);
}

function updateApprovalBadge() {
  const pending = state.runs ? state.runs.pending().length : 0;
  const attention = state.runs
    ? state.runs.all().filter((run) => ["waiting_input", "waiting_approval"].includes(run.state)).length
    : 0;
  const total = pending + attention;
  const badge = $("activity-count");
  badge.textContent = total > 99 ? "99+" : String(total);
  badge.classList.toggle("hidden", total === 0);
  $("btn-activity").setAttribute("aria-label", total ? `任务，${total} 项需要处理` : "任务");
  if (total && total !== state.announcedAttention) announce(`${total} 项需要处理`);
  state.announcedAttention = total;
}

function openDrawerNode(title, loader) {
  releasePanelCleanup();
  state.drawerReturn = document.activeElement;
  state.drawerPanel = { title, loader: typeof loader === "function" ? loader : () => loader };
  hidden("drawer", false);
  $("head-title").setAttribute("aria-expanded", "true");
  $("btn-settings").setAttribute("aria-expanded", "true");
  $("btn-computer").setAttribute("aria-expanded", "false");
  renderDrawerPanel();
  $("drawer-close").focus();
}

/** Re-render the standalone drawer panel that is currently open (pairing/feishu/run detail). */
function renderDrawerPanel() {
  const panel = state.drawerPanel;
  if (!panel) return;
  releasePanelCleanup();
  const request = ++state.panelRequest;
  $("drawer-title").textContent = panel.title;
  const body = $("drawer-body");
  body.replaceChildren(el("div", "bt-empty", "加载中…"));
  Promise.resolve()
    .then(() => panel.loader())
    .then((view) => {
      if (state.drawerPanel !== panel || request !== state.panelRequest) { view?.dispose?.(); return; }
      setPanelCleanup(view?.dispose);
      body.replaceChildren(view?.node ?? view);
    })
    .catch((error) => {
      if (state.drawerPanel === panel && request === state.panelRequest) body.replaceChildren(el("div", "bt-empty", `加载失败：${error.message}`));
    });
}

function finishRun(run, { text: streamed, botChat }) {
  if (!run) return;
  state.revision += 1;
  const selectedBot = state.sel?.kind === "bot" && state.sel.id === run.botId;
  if (botChat) {
    const history = state.chats[run.botId] || [];
    const tail = history.at(-1);
    const alreadyShown = tail?.role === "assistant" && String(tail.text || "").trim() === streamed;
    if (!run.reply && streamed && !alreadyShown) (state.chats[run.botId] ||= []).push({ role: "assistant", text: streamed, at: Date.now() });
    if (run.reply && selectedBot) void loadChat(run.botId).catch((error) => toast(`历史加载失败：${error.message}`, true));
    else {
      renderSidebar();
      if (selectedBot) renderSelected(true);
    }
  } else {
    void loadAll().catch(() => { });
  }
  if (run.state === "failed") toast(`运行失败：${run.error || "未知错误"}`, true);
  if (run.state === "reconciliation_required") {
    toast("有动作结果未知，要你核对一下。系统不会自动重做", true);
    announce("有动作结果未知，要你核对一下");
  }
  announce(`运行${runStateLabel(run.state)}`);
  updateApprovalBadge();
}

function createWorkbench() {
  state.runs = createRunClient({
    botFor: (id) => botById(id),
    botMark: (bot, size, working, live) => botMark(bot, size, working, live),
    chatLog: () => (state.view === "team" && state.sel?.kind === "bot" ? $("chat-log") : null),
    cancel: (id) => state.runs.cancel(id),
    onRunStarted: (run) => {
      renderSidebar();
      const target = run.roomId ? { kind: "room", id: run.roomId } : run.botId ? { kind: "bot", id: run.botId } : null;
      if (state.view === "team" && target && isSelected(target)) renderSelected(true);
      updateApprovalBadge();
    },
    onRunFinished: finishRun,
    // 私聊完成时用户没在看这个会话：记一条未读，侧边栏头像在打开前一直动。
    onRunEnded: (run) => {
      const target = { kind: "bot", id: run.botId };
      if (run.state !== "completed" || !run.botId || run.roomId || run.kind === "delegation" || isSelected(target)) return;
      state.unread.add(keyOf(target));
      renderSidebar();
    },
    onApprovalsChanged: () => {
      renderDock();
      updateApprovalBadge();
      if (state.view === "activity") state.activity?.repaint?.();
    },
    onArtifact: () => {
      if (state.view === "activity") state.activity?.refresh?.();
    },
    onReplayed: () => { void loadAll().catch(() => { }); },
    onGap: (from, to) => {
      toast(`事件历史可能不完整：seq ${from} → ${to} 之间超出保留窗口`, true);
      announce("事件历史存在缺口，部分过程可能缺失");
    },
  });
  state.runs.on((change) => {
    if (change === "run" && state.view === "activity") state.activity?.repaint?.();
    if (change === "run" || change === "tool") syncAvatars();
  });
  state.dock = createApprovalDock({ client: state.runs });
  state.panels = createPanels({
    client: state.runs,
    deps: {
      bots: () => state.bots,
      botFor: (id) => botById(id),
      openDrawer: (title, content) => openDrawerNode(title, content),
      openModal: (title, content, onClose) => openModal(title, content, onClose),
      closeModal: () => closeModal(),
      announce,
      approvalCard: (record) => state.dock.card(record),
      rerenderPanel: () => {
        if (state.drawerPanel) renderDrawerPanel();
        else if (state.sel?.kind === "bot") void renderSettingsTab(state.sel, state.panelTab);
      },
      onBotUpdated: (updated) => {
        if (!updated || !updated.id) return;
        const index = state.bots.findIndex((bot) => bot.id === updated.id);
        if (index >= 0) state.bots[index] = { ...state.bots[index], ...updated };
        renderSidebar();
        renderSelected();
      },
    },
  });
  state.tray = createAttachmentTray();
}

function openModal(title, form, onClose) {
  state.modalReturn = document.activeElement;
  state.modalCleanup = typeof onClose === "function" ? onClose : null;
  $("modal-title").textContent = title;
  $("modal-body").replaceChildren(form);
  $("modal").classList.toggle("wb-modal-wide", !!form?.classList?.contains("wb-screen-zoomed"));
  hidden("modal-back", false);
  for (const id of ["sidebar", "main", "drawer", "mobile-head"]) $(id).inert = true;
  const modal = $("modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "modal-title");
  modal.tabIndex = -1;
  (form.querySelector("input, select, textarea, button") || modal).focus();
}

function closeModal() {
  const cleanup = state.modalCleanup;
  state.modalCleanup = null;
  hidden("modal-back", true);
  $("modal-body").replaceChildren();
  $("modal").classList.remove("wb-modal-wide");
  for (const id of ["sidebar", "main", "drawer", "mobile-head"]) $(id).inert = false;
  if (cleanup) {
    try { cleanup(); } catch { /* 释放失败不影响关闭窗口 */ }
  }
  const visibleReturn = state.modalReturn?.isConnected && state.modalReturn.getClientRects().length;
  const target = visibleReturn ? state.modalReturn : $("btn-new").getClientRects().length ? $("btn-new") : $("btn-sidebar");
  state.modalReturn = null;
  target.focus();
}

function closeNewMenu() {
  hidden("new-menu", true);
  $("btn-new").setAttribute("aria-expanded", "false");
}

function closeSidebar(restore = false) {
  document.body.classList.remove("sidebar-open");
  hidden("sidebar-backdrop", true);
  $("btn-sidebar").setAttribute("aria-expanded", "false");
  if (restore) $("btn-sidebar").focus();
}

function resizeInput() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function applyTheme(dark) {
  document.body.toggleAttribute("data-ds-dark-theme", dark);
  $("btn-theme").setAttribute("aria-pressed", String(dark));
  $("btn-theme").setAttribute("aria-label", dark ? "切换浅色主题" : "切换深色主题");
  $("btn-theme").title = dark ? "切换浅色主题" : "切换深色主题";
}

/** 用户明确选过的主题；没选过返回 null，由系统深浅色决定。 */
function storedTheme() {
  try {
    const value = localStorage.getItem("omp-bot-theme");
    return value === "dark" || value === "light" ? value : null;
  } catch { return null; }
}

const systemPrefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function bind() {
  $("btn-new").onclick = () => {
    const open = $("new-menu").classList.contains("hidden");
    hidden("new-menu", !open);
    $("btn-new").setAttribute("aria-expanded", String(open));
    if (open) $("new-bot").focus();
  };
  $("new-bot").onclick = openNewBot;
  $("new-room").onclick = openNewRoom;
  $("btn-welcome-new").onclick = openNewBot;
  $("btn-welcome-room").onclick = openNewRoom;
  $("btn-search").onclick = () => {
    const open = $("search-wrap").classList.contains("hidden");
    hidden("search-wrap", !open);
    $("btn-search").setAttribute("aria-expanded", String(open));
    if (open) $("search").focus();
    else { $("search").value = ""; state.search = ""; renderSidebar(); }
  };
  $("search").oninput = () => { state.search = $("search").value; renderSidebar(); };
  $("btn-usage").onclick = () => { void showUsage(); };
  $("btn-activity").onclick = showActivity;
  $("btn-stop").onclick = async () => {
    const target = state.sel && { ...state.sel };
    const active = target && liveRuns(target)[0];
    if (!active) return;
    $("btn-stop").disabled = true;
    try {
      await state.runs.cancel(active.id);
      toast("已接受取消请求，等待原生确认");
      announce("已接受取消请求，等待原生确认停止");
    } catch (error) {
      toast(`取消失败：${error.message}`, true);
    }
    syncBusy();
  };
  $("btn-attach").onclick = () => state.tray?.open();
  $("btn-theme").onclick = () => {
    const dark = !document.body.hasAttribute("data-ds-dark-theme");
    applyTheme(dark);
    try { localStorage.setItem("omp-bot-theme", dark ? "dark" : "light"); } catch { }
  };
  $("btn-sidebar").onclick = () => {
    const open = document.body.classList.toggle("sidebar-open");
    hidden("sidebar-backdrop", !open);
    $("btn-sidebar").setAttribute("aria-expanded", String(open));
    if (open) $("btn-new").focus();
  };
  $("sidebar-backdrop").onclick = () => closeSidebar(true);
  $("btn-settings").onclick = openSettings;
  $("btn-computer").onclick = () => { state.panelTab = "computer"; openSettings(); };
  $("btn-permissions").onclick = () => { state.panelTab = "capabilities"; openSettings(); };
  $("head-title").onclick = openSettings;
  $("drawer-close").onclick = () => closeDrawer();
  $("modal-close").onclick = closeModal;
  $("modal-back").onclick = (event) => { if (event.target === $("modal-back")) closeModal(); };
  $("btn-send").onclick = () => { void send(); };
  $("input").onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
  };
  $("input").oninput = () => {
    if (state.sel) state.drafts[keyOf(state.sel)] = $("input").value;
    resizeInput();
  };
  document.addEventListener("click", (event) => {
    if (!$("new-menu").contains(event.target) && !$("btn-new").contains(event.target)) closeNewMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (!$("modal-back").classList.contains("hidden")) {
      if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
      trapTab(event, $("modal"));
      return;
    }
    if (!$("drawer").classList.contains("hidden") && $("drawer").contains(document.activeElement)) {
      if (event.key === "Escape") { event.preventDefault(); closeDrawer(); return; }
      trapTab(event, $("drawer"));
      return;
    }
    if (event.key !== "Escape") return;
    if (!$("new-menu").classList.contains("hidden")) { closeNewMenu(); $("btn-new").focus(); }
    else if (!$("drawer").classList.contains("hidden")) closeDrawer();
    else if (document.body.classList.contains("sidebar-open")) closeSidebar(true);
    else if (!$("search-wrap").classList.contains("hidden")) {
      hidden("search-wrap", true);
      $("search").value = "";
      state.search = "";
      $("btn-search").setAttribute("aria-expanded", "false");
      renderSidebar();
      $("btn-search").focus();
    }
  });
  window.matchMedia("(min-width: 761px)").addEventListener("change", (event) => { if (event.matches) closeSidebar(); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    if (!storedTheme()) applyTheme(event.matches);
  });
  // Desktop notification click → open the target bot in this window (same-page CustomEvent).
  const openBot = (event) => {
    const botId = event?.detail?.botId;
    if (!botId) return;
    closeSidebar();
    closeDrawer(false);
    if (botById(botId)) {
      select("bot", botId);
      return;
    }
    void loadAll()
      .then(() => { if (botById(botId)) select("bot", botId); else toast(`通知指向的助手不在名单里：${botId}`, true); })
      .catch((error) => toast(`打开助手失败：${error.message}`, true));
  };
  document.addEventListener("ompbot:open-bot", openBot);
  window.addEventListener("ompbot:open-bot", openBot);
}

(async function init() {
  bind();
  const stored = storedTheme();
  applyTheme(stored ? stored === "dark" : systemPrefersDark());
  try {
    await bootstrapAuth();
  } catch (error) {
    toast(`会话引导失败：${error.message}`, true);
  }
  createWorkbench();
  state.tray.mount($("attach-tray"), $("composer"), $("input"), { imageCheck: imageCapabilityProblem });
  renderSelected();
  connectSSE();
  try {
    const [, catalog] = await Promise.all([
      loadAll(),
      state.panels.loadModels().then((list) => ({ models: list })).catch((error) => {
        toast(`模型列表加载失败：${error.message}`, true);
        return { models: [] };
      }),
    ]);
    state.models = catalog.models || [];
  } catch (error) { toast(`加载失败：${error.message}`, true); }
})();

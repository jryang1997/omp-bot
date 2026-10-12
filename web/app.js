/*
 * omp_bot browser UI.
 * Sidebar tile/row markup, transcript markup, character marks, cluster geometry,
 * and the copy icon are adapted from FeiZhuLulu/DeepSeek-Bot, Apache-2.0.
 * Source SHA bdc5fda64e2ea1e83a4d146440072a2413025df4.
 * Modified for native DOM, omp_bot HTTP/SSE endpoints, and accessible local forms.
 * See vendor/ds-bot/LICENSE and vendor/ds-bot/NOTICE.
 */
import { MAIN_LOOK, lookOf, shapeOf, MASK_ID, nextMarkSerial, characterMarkup } from "./vendor/ds-bot/characters.js";
import { inkText } from "./vendor/ds-bot/inks.js";
import {
  $, el, button, toast, announce, api, bootstrapAuth, markdownFragment, runStateLabel, trapTab,
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
  search: "",
  revision: 0,
  refreshRequested: 0,
  refresh: null,
  usageRequest: 0,
  serial: 0,
  modalReturn: null,
  drawerReturn: null,
  drawerPanel: null,
  legacySince: 0,
  legacyReady: false,
  streamOpened: false,
  panelTab: "detail",
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

function botMark(bot, size = 36, working = false, live = true) {
  const look = bot?.isMain ? MAIN_LOOK : lookOf(bot);
  const mark = el("span", "bt-mark");
  mark.dataset.shape = look.shape;
  mark.dataset.state = working ? "working" : "idle";
  if (live) mark.dataset.live = "";
  mark.setAttribute("aria-hidden", "true");
  mark.style.width = `${size}px`;
  mark.style.height = `${size}px`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const box = shapeOf(look.shape).size;
  svg.setAttribute("viewBox", `0 0 ${box} ${box}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = characterMarkup(look.shape, look.color).replaceAll(MASK_ID, `omp-mark-${nextMarkSerial()}`);
  mark.append(svg);
  if (live) {
    const wrapper = el("span", "bt-mark");
    Object.assign(wrapper.style, { width: `${size}px`, height: `${size}px` });
    wrapper.append(mark);
    return wrapper;
  }
  return mark;
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
  return target.kind === "bot" ? botMark(item, size, conversationBusy(target)) : roomAvatar(item, size);
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

function renderSidebar() {
  const list = $("side-list");
  list.replaceChildren();
  const query = state.search.trim().toLocaleLowerCase();
  const matches = (item) => `${item.name} ${item.role || ""}`.toLocaleLowerCase().includes(query);
  const main = state.bots.find((bot) => bot.isMain);
  const appendBot = (bot, tile = false) => {
    const target = { kind: "bot", id: bot.id };
    const row = button(tile ? "bt-tile" : "bt-row", null, () => select("bot", bot.id));
    row.dataset.botId = bot.id;
    row.setAttribute("aria-label", `${bot.name}${bot.isMain ? "，主 Bot" : ""}${conversationBusy(target) ? "，处理中" : ""}`);
    if (isSelected(target)) row.setAttribute("aria-current", "page");
    row.append(avatar(target, tile ? 60 : 36));
    if (tile) {
      row.append(el("span", "bt-tile-name", bot.name));
      if (bot.role) row.append(el("span", "bt-chip", bot.role));
      const wrap = el("div", "bt-tile-wrap");
      wrap.append(row);
      list.append(wrap);
    } else {
      const body = el("span", "bt-row-body");
      const name = el("span", "bt-row-name");
      name.append(el("span", "bt-row-title", bot.name));
      body.append(name);
      const messages = state.chats[bot.id];
      const status = state.runs?.statusText(target);
      const preview = status || messages?.at(-1)?.text || bot.role || bot.model || "默认模型";
      body.append(el("span", "bt-row-preview", String(preview).replace(/\s+/g, " ")));
      if (status) body.append(el("span", "bt-tag wb-tag-live", status));
      row.append(body);
      list.append(row);
    }
  };
  if (main && matches(main)) appendBot(main, true);
  for (const room of state.rooms.filter(matches)) {
    const target = { kind: "room", id: room.id };
    const row = button("bt-row", null, () => select("room", room.id));
    row.dataset.roomId = room.id;
    row.setAttribute("aria-label", room.name);
    if (isSelected(target)) row.setAttribute("aria-current", "page");
    row.append(avatar(target, 36));
    const body = el("span", "bt-row-body");
    const name = el("span", "bt-row-name");
    name.append(el("span", "bt-row-title", room.name));
    body.append(name);
    const preview = state.runs?.statusText(target) || (conversationBusy(target) ? "群聊回合进行中…" : room.log?.at(-1)?.text || `${room.members.length} 位 Bot · ${room.mode === "everyone" ? "全员轮流" : "管理员代答"}`);
    body.append(el("span", "bt-row-preview", String(preview).replace(/\s+/g, " ")));
    row.append(body);
    list.append(row);
  }
  for (const bot of state.bots) if (bot !== main && matches(bot)) appendBot(bot);
  if (!list.children.length) list.append(el("div", "empty-hint", query ? "没有匹配的名称或角色" : "创建一个 Bot，开始组建团队"));
  $("btn-usage").toggleAttribute("aria-current", state.view === "usage");
  if (state.view === "usage") $("btn-usage").setAttribute("aria-current", "page");
  $("btn-activity").toggleAttribute("aria-current", state.view === "activity");
  if (state.view === "activity") $("btn-activity").setAttribute("aria-current", "page");
}

function select(kind, id) {
  const target = { kind, id };
  if (!itemOf(target)) return;
  if (state.sel) state.drafts[keyOf(state.sel)] = $("input").value;
  state.sel = target;
  state.view = "team";
  const fromSidebar = document.body.classList.contains("sidebar-open");
  closeDrawer(false);
  closeSidebar();
  closeNewMenu();
  $("input").value = state.drafts[keyOf(target)] || "";
  resizeInput();
  state.tray?.setBot(kind === "bot" ? id : null);
  renderSidebar();
  renderSelected(true);
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
  $("head-avatar").replaceChildren(avatar(target, 24));
  if (target.kind === "bot") {
    $("head-sub").textContent = [item.role, item.model || "默认模型", item.executionMode ? `模式 ${item.executionMode}` : "", item.approvalMode ? `审批 ${item.approvalMode}` : ""].filter(Boolean).join(" · ");
  } else {
    const admin = botById(item.adminId)?.name || "未设置";
    $("head-sub").textContent = `${item.members.length} 位 Bot · ${item.mode === "everyone" ? "全员轮流" : "管理员代答"} · 管理员 ${admin}`;
  }
  $("head-title").setAttribute("aria-label", `查看 ${item.name} 的详情`);
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
          const img = el("img", "bt-thumb");
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
  const name = el("span", "bt-group-name", error ? `${message.fromName ? `${message.fromName} · ` : ""}错误` : message.fromName || bot?.name || "Bot");
  if (!error) name.style.color = inkText(bot?.isMain ? MAIN_LOOK.color : lookOf(bot).color);
  if (room?.adminId && room.adminId === bot?.id) name.append(el("span", "bt-group-role", " 管理员"));
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
  for (const message of messages) {
    const date = new Date(message.at);
    if (Number.isFinite(date.getTime())) {
      const day = date.toLocaleDateString();
      if (day !== previousDay) {
        log.append(el("div", "bt-time-sep", day));
        previousDay = day;
      }
    }
    const speaker = target.kind === "bot" ? item : botById(message.from) || state.bots.find((bot) => bot.name === message.fromName || bot.name === message.from);
    log.append(messageNode(message, speaker, target.kind === "room" ? item : null));
  }
  const loading = target.kind === "bot" && state.history.get(target.id)?.loading;
  state.runs?.appendLive(log, target);
  if (!messages.length && !loading && !liveRuns(target).length) log.append(el("div", "empty-hint", target.kind === "bot" ? `和 ${item.name} 说点什么吧` : "发一条消息，开始群聊回合"));
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
  $("btn-send").disabled = !ready || loading || saving;
  $("input").disabled = !ready || loading || saving;
  $("composer").setAttribute("aria-busy", String(busy));
  $("btn-stop").hidden = !busy;
  $("btn-stop").disabled = !busy || cancelling;
  $("btn-stop").textContent = cancelling ? "停止中…" : "停止";
  $("steer-mode").hidden = !busy;
  $("btn-attach").disabled = !ready || target.kind !== "bot" || saving || loading;
  if (ready) {
    $("input").placeholder = busy
      ? "输入以补充当前回合，Enter 提交（不新建并发运行）"
      : target.kind === "bot" ? `给 ${item.name} 发消息，Enter 发送` : `在「${item.name}」发言，可 @点名 Bot`;
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
      state.drafts[key] = text;
      $("input").value = text;
      resizeInput();
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
  state.tray?.clear();
  renderSidebar();
  renderSelected(true);
  try {
    if (target.kind === "bot") {
      await state.runs.start({ botId: target.id, text, attachmentIds, source: "user" });
    } else {
      const { spoken } = await api(`/api/rooms/${encodeURIComponent(target.id)}/say`, { method: "POST", body: { text, userName: "你" } });
      if (!spoken.length) {
        state.drafts[key] = text;
        if (isSelected(target)) {
          $("input").value = text;
          resizeInput();
        }
        toast("群里没有可用的 Bot，请在群设置中添加成员。消息已保留。", true);
      }
    }
  } catch (error) {
    if (target.kind === "bot" && text && botById(target.id)) (state.chats[target.id] ||= []).push({ role: "error", text: error.message, at: Date.now() });
    state.drafts[key] = text;
    if (isSelected(target)) {
      $("input").value = text;
      resizeInput();
    }
    toast(`${itemOf(target)?.name || "会话"}：${error.message}`, true);
    announce(`发送失败：${error.message}`);
  } finally {
    if (state.pending.get(key) === pending) state.pending.delete(key);
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

const LEGACY_TYPES = new Set([
  "room_bot_post", "room_bot_pass", "room_turn_error", "room_round_start", "room_round_end", "room_user_post",
  "bot_added", "bot_updated", "bot_removed", "room_created", "room_updated", "room_removed",
  "exchange_request", "bot_to_user",
]);

function connectSSE() {
  const events = new EventSource("/api/events");
  events.onopen = () => {
    $("conn").classList.add("live");
    $("conn-label").textContent = "已连接";
    state.roomActivity.clear();
    void (async () => {
      const snapshot = await loadAll();
      if (Number.isInteger(snapshot?.lastSeq)) state.legacySince = Math.max(state.legacySince, snapshot.lastSeq);
      state.legacyReady = true;
      if (state.sel?.kind === "bot") await loadChat(state.sel.id);
      if (state.streamOpened) {
        // Reconnect: fill any gap through the ledger cursor; the client dedups by seq.
        await state.runs.replenish();
      } else {
        // First load with runs already in flight: rebuild their streamed projection.
        await state.runs.rehydrate();
        if (state.view === "team") renderSelected(true);
      }
      state.streamOpened = true;
      announce("已连接事件流");
    })().catch((error) => {
      toast(`重新同步失败：${error.message}`, true);
      announce("事件流重新同步失败");
    });
  };
  events.onerror = () => {
    $("conn").classList.remove("live");
    $("conn-label").textContent = "连接中…";
    announce("事件流已断开，正在重连");
  };
  events.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    state.runs?.handleEvent(data);
    if (!LEGACY_TYPES.has(data.type)) return;
    // Legacy state is re-derived from the /api/state snapshot until it lands; later events
    // are applied only past the ledger cursor so a replayed stream cannot double-append.
    if (!state.legacyReady) return;
    if (typeof data.seq === "number" && data.seq <= state.legacySince) return;
    handleEvent(data);
    if (typeof data.seq === "number") state.legacySince = data.seq;
  };
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
  const name = field(form, "名字", Object.assign(el("input"), { value: bot?.name || "", placeholder: "如 Ada", required: true }));
  const role = field(form, "角色", Object.assign(el("input"), { value: bot?.role || "", placeholder: "如 协调者" }));
  const model = el("select");
  option(model, "", "（默认模型）");
  for (const item of state.models) option(model, item.selector || `${item.provider}/${item.id}`, item.name || item.id);
  if (bot?.model && ![...model.options].some((item) => item.value === bot.model)) option(model, bot.model, bot.model);
  model.value = bot?.model || "";
  field(form, "模型", model, "选一个 omp models 里已认证的模型");
  const thinking = el("select");
  for (const value of ["", "off", "low", "medium", "high", "xhigh", "max"]) option(thinking, value, value || "（默认 low）");
  thinking.value = bot?.thinking || "";
  field(form, "思考档", thinking);
  const instructions = field(form, "专属指令", Object.assign(el("textarea"), { value: bot?.instructions || "", rows: 5 }));
  const main = Object.assign(el("input"), { type: "checkbox", checked: !!bot?.isMain });
  main.id = `omp-field-${++state.serial}`;
  const label = el("label", "checkline");
  label.htmlFor = main.id;
  label.append(main, document.createTextNode("主 Bot（群里默认当管理员）"));
  form.append(label);
  saveForm(form, bot ? { kind: "bot", id: bot.id } : null, bot ? "保存" : "创建", () => {
    if (!name.value.trim()) { name.focus(); toast("名字必填", true); return null; }
    return { name: name.value.trim(), role: role.value.trim(), model: model.value, thinking: thinking.value, instructions: instructions.value, isMain: main.checked };
  }, onSave);
  return form;
}

function roomForm(room, onSave) {
  const form = el("form");
  form.id = `omp-form-${++state.serial}`;
  const name = field(form, "群名", Object.assign(el("input"), { value: room?.name || "", placeholder: "如 工作组", required: true }));
  const group = el("fieldset", "field");
  group.append(el("legend", null, "成员（至少选一个）"));
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
  const mode = el("select");
  option(mode, "admin", "管理员代答 + @点名");
  option(mode, "everyone", "全员轮流");
  mode.value = room?.mode || "admin";
  field(form, "模式", mode);
  const admin = el("select");
  field(form, "管理员", admin);
  function refreshAdmins(value = admin.value) {
    admin.replaceChildren();
    option(admin, "", "（默认第一个成员）");
    for (const pick of picks) if (pick.checked) option(admin, pick.value, botById(pick.value).name);
    admin.value = [...admin.options].some((item) => item.value === value) ? value : "";
  }
  picks.forEach((pick) => { pick.onchange = () => refreshAdmins(); });
  refreshAdmins(room?.adminId || "");
  saveForm(form, room ? { kind: "room", id: room.id } : null, room ? "保存" : "创建", () => {
    if (!name.value.trim()) { name.focus(); toast("群名必填", true); return null; }
    const ids = picks.filter((pick) => pick.checked).map((pick) => pick.value);
    if (!ids.length) { picks[0]?.focus(); toast("至少选一个成员", true); return null; }
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
  openModal("新建 Bot", form);
}

function openNewRoom() {
  closeNewMenu();
  if (!state.bots.length) { toast("先建至少一个 Bot", true); return; }
  const form = roomForm(null, async (data) => {
    const { room } = await api("/api/rooms", { method: "POST", body: data });
    if ($("modal-body").contains(form)) closeModal();
    state.revision += 1;
    await loadAll();
    select("room", room.id);
    toast(`已创建群 ${room.name}`);
  });
  openModal("新建群", form);
}

function detailProfile(target) {
  const item = itemOf(target);
  const profile = el("div", "detail-profile bt-drawer-id");
  profile.append(avatar(target, 80), el("div", "detail-name bt-drawer-name", item.name));
  profile.append(el("div", "detail-role", target.kind === "bot" ? item.role || "Bot" : `${item.members.length} 位 Bot · ${item.mode === "everyone" ? "全员轮流" : "管理员代答"}`));
  return profile;
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

function openSettings() {
  const target = state.sel && { ...state.sel };
  const item = itemOf(target);
  if (state.view !== "team" || !item) return;
  state.drawerReturn = document.activeElement;
  state.drawerPanel = null;
  hidden("drawer", false);
  $("head-title").setAttribute("aria-expanded", "true");
  $("btn-settings").setAttribute("aria-expanded", "true");
  $("drawer-title").textContent = target.kind === "bot" ? "Bot 详情" : "群详情";
  void renderSettingsTab(target, state.panelTab);
  syncBusy();
  $("drawer-close").focus();
}

const BOT_TABS = [["detail", "详情"], ["capabilities", "能力"], ["skills", "技能"], ["mcp", "MCP"], ["memory", "记忆"], ["routines", "计划"]];

async function renderSettingsTab(target, tab) {
  const item = itemOf(target);
  if (!item || !isSelected(target)) return;
  const tabs = target.kind === "bot" ? BOT_TABS : [["detail", "详情"]];
  if (!tabs.some(([id]) => id === tab)) tab = "detail";
  state.panelTab = tab;
  const body = $("drawer-body");
  const tabBar = el("div", "bt-tabs wb-tabs");
  for (const [id, label] of tabs) {
    const node = button("bt-tab", label, () => { state.panelTab = id; void renderSettingsTab(target, id); });
    node.setAttribute("role", "tab");
    node.setAttribute("aria-selected", String(id === tab));
    tabBar.append(node);
  }
  const content = el("div", "wb-panel-body");
  body.replaceChildren(tabBar, content);
  if (tab === "detail") {
    content.append(detailProfile(target));
    const save = async (data) => {
      await api(`/api/${target.kind === "bot" ? "bots" : "rooms"}/${encodeURIComponent(target.id)}`, { method: "PATCH", body: data });
      state.revision += 1;
      await loadAll();
      if (target.kind === "bot") state.tray?.setBot(target.id);
      void renderSettingsTab(target, "detail");
      toast(target.kind === "bot" ? "已保存，人格和模型改动会在下一条消息生效" : "已保存群设置");
    };
    content.append(target.kind === "bot" ? botForm(item, save) : roomForm(item, save));
    const actions = el("div", "field");
    if (target.kind === "bot") {
      const reload = targetControl(button("btn ghost wide", "重新加载聊天记录", () => runAction(reload, target, async () => {
        await loadChat(target.id);
        toast("已重新加载聊天记录");
      })), target);
      const clear = targetControl(button("btn ghost wide", "清空显示（保留原生会话）", () => {
        if (!confirm(`清空 ${item.name} 的聊天显示？（不删除原生 omp 会话，需要新会话请用“能力 → 新会话”）`)) return;
        return runAction(clear, target, async () => {
          await api(`/api/chat/${encodeURIComponent(target.id)}`, { method: "DELETE" });
          state.history.delete(target.id);
          state.chats[target.id] = [];
          renderSidebar();
          if (isSelected(target)) renderSelected();
          toast("已清空显示");
        });
      }), target);
      const newSession = targetControl(button("btn ghost wide", "新会话（原生 new_session）", () => {
        if (!confirm("开启一个新的原生会话：旧会话与历史都保留，下一条消息进入新会话。继续？")) return;
        return runAction(newSession, target, async () => {
          await api(`/api/bots/${encodeURIComponent(target.id)}/session/new`, { method: "POST", body: {} });
          toast("已开启新会话");
          announce("已开启新的原生会话");
        });
      }), target);
      actions.append(reload, newSession, clear);
    } else {
      const reload = targetControl(button("btn ghost wide", "重新加载群聊记录", () => runAction(reload, target, async () => {
        await loadAll();
        toast("已重新加载群聊记录");
      })), target);
      actions.append(reload);
    }
    const remove = targetControl(button("btn danger wide", target.kind === "bot" ? "删除此 Bot" : "删除此群", () => {
      const prompt = target.kind === "bot" ? `删除 ${item.name}？其会话文件保留在磁盘。` : `删除群「${item.name}」？`;
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

  content.append(el("div", "bt-empty", "加载中…"));
  const loader = { capabilities: "capabilitiesPanel", skills: "skillsPanel", mcp: "mcpPanel", memory: "memoryPanel", routines: "routinesPanel" }[tab];
  try {
    if (tab === "routines") {
      const node = await state.panels.routinesPanel(item.id);
      if (isSelected(target) && state.panelTab === tab) content.replaceChildren(node);
      return;
    }
    const node = await state.panels[loader](item);
    if (isSelected(target) && state.panelTab === tab) content.replaceChildren(node);
  } catch (error) {
    if (isSelected(target) && state.panelTab === tab) content.replaceChildren(el("div", "bt-empty", `加载失败：${error.message}`));
  }
}

function closeDrawer(restore = true) {
  hidden("drawer", true);
  state.drawerPanel = null;
  $("head-title").setAttribute("aria-expanded", "false");
  $("btn-settings").setAttribute("aria-expanded", "false");
  if (restore && state.drawerReturn?.isConnected) state.drawerReturn.focus();
  state.drawerReturn = null;
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
  const title = el("h1", null, "用量");
  const refresh = button("btn ghost", "刷新", () => { void showUsage(); });
  refresh.disabled = true;
  view.replaceChildren(title, el("p", "hint", "当前常驻进程内 runtime 的 token 和请求统计"), refresh, el("div", "empty-hint", "加载中…"));
  try {
    const { perRuntime = [], perRun = [], totals = {}, ledgerAvailable = false } = await api("/api/usage");
    if (request !== state.usageRequest || state.view !== "usage") return;
    view.lastChild.remove();
    if (ledgerAvailable && perRun.length) {
      const runs = el("table", "usage");
      runs.append(el("caption", null, "按 Run 的持久用量（来自账本，含实际模型标识）"));
      const columns = ["Run", "Bot", "模型", "输入 token", "输出 token", "总 token", "费用"];
      const head = el("thead");
      const heading = el("tr");
      columns.forEach((label, index) => { const cell = el("th", index > 2 ? "num" : null, label); cell.scope = "col"; heading.append(cell); });
      head.append(heading);
      runs.append(head);
      const body = el("tbody");
      for (const entry of perRun) {
        const row = el("tr");
        row.append(el("td", null, String(entry.runId || entry.id || "").slice(0, 12)));
        row.append(el("td", null, entry.botId || entry.botName || "—"));
        row.append(el("td", null, entry.model || "未知"));
        row.append(el("td", "num", String(entry.tokensIn ?? entry.inputTokens ?? 0)));
        row.append(el("td", "num", String(entry.tokensOut ?? entry.outputTokens ?? 0)));
        row.append(el("td", "num", String(entry.totalTokens ?? 0)));
        row.append(el("td", "num", entry.cost == null ? "未知" : Number(entry.cost).toFixed(4)));
        body.append(row);
      }
      runs.append(body);
      view.append(runs);
    } else if (!ledgerAvailable) {
      view.append(el("p", "hint", "账本用量不可用：只显示本进程 runtime 统计，持久 per-Run 记账暂缺。"));
    }
    const table = el("table", "usage");
    table.append(el("caption", null, "Bot 运行用量"));
    const columns = [["Bot", "botName"], ["范围", "scope"], ["模型", "model"], ["请求", "requests"], ["输入 token", "tokensIn"], ["输出 token", "tokensOut"], ["总 token", "totalTokens"], ["费用", "cost"]];
    const head = el("thead");
    const heading = el("tr");
    columns.forEach(([label], index) => {
      const cell = el("th", index > 2 ? "num" : null, label);
      cell.scope = "col";
      heading.append(cell);
    });
    head.append(heading);
    table.append(head);
    const body = el("tbody");
    for (const entry of perRuntime) {
      const row = el("tr");
      columns.forEach(([, key], index) => row.append(el("td", index > 2 ? "num" : null, key === "cost" ? Number(entry[key] || 0).toFixed(4) : String(entry[key] ?? ""))));
      body.append(row);
    }
    table.append(body);
    const foot = el("tfoot");
    const total = el("tr", "total");
    columns.forEach(([, key], index) => total.append(el("td", index > 2 ? "num" : null, index === 0 ? "合计" : index < 3 ? "" : key === "cost" ? Number(totals[key] || 0).toFixed(4) : String(totals[key] || 0))));
    foot.append(total);
    table.append(foot);
    if (!perRuntime.length) view.append(el("div", "empty-hint", "还没有活跃的 Bot 进程。和 Bot 聊一句，用量就会出现在这里。"));
    view.append(table);
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
  $("btn-activity").setAttribute("aria-label", total ? `工作台，${total} 项需要处理` : "工作台");
  if (total && total !== state.announcedAttention) announce(`${total} 项需要处理`);
  state.announcedAttention = total;
}

function openDrawerNode(title, loader) {
  state.drawerReturn = document.activeElement;
  state.drawerPanel = { title, loader: typeof loader === "function" ? loader : () => loader };
  hidden("drawer", false);
  $("head-title").setAttribute("aria-expanded", "true");
  $("btn-settings").setAttribute("aria-expanded", "true");
  renderDrawerPanel();
  $("drawer-close").focus();
}

/** Re-render the standalone drawer panel that is currently open (pairing/feishu/run detail). */
function renderDrawerPanel() {
  const panel = state.drawerPanel;
  if (!panel) return;
  $("drawer-title").textContent = panel.title;
  const body = $("drawer-body");
  body.replaceChildren(el("div", "bt-empty", "加载中…"));
  Promise.resolve()
    .then(() => panel.loader())
    .then((node) => { if (state.drawerPanel === panel) body.replaceChildren(node); })
    .catch((error) => { if (state.drawerPanel === panel) body.replaceChildren(el("div", "bt-empty", `加载失败：${error.message}`)); });
}

function finishRun(run) {
  if (!run) return;
  state.revision += 1;
  const botChat = !!run.botId && !run.roomId && run.kind !== "delegation";
  const selectedBot = state.sel?.kind === "bot" && state.sel.id === run.botId;
  if (botChat) {
    const node = state.runs.liveNode(run.id);
    const streamed = node?.text() || "";
    const history = state.chats[run.botId] || [];
    const tail = history.at(-1);
    const alreadyShown = tail?.role === "assistant" && String(tail.text || "").trim() === streamed;
    if (!run.reply && streamed && !alreadyShown) (state.chats[run.botId] ||= []).push({ role: "assistant", text: streamed, at: Date.now() });
    state.runs.dropLive(run.id);
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
    toast("外部效果未知：该运行需人工对账，不会自动重试或重放", true);
    announce("运行需人工对账，未完成的副作用未知");
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
  state.dock = createApprovalDock({ client: state.runs });
  state.panels = createPanels({
    client: state.runs,
    deps: {
      bots: () => state.bots,
      botFor: (id) => botById(id),
      openDrawer: (title, content) => openDrawerNode(title, content),
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

function openModal(title, form) {
  state.modalReturn = document.activeElement;
  $("modal-title").textContent = title;
  $("modal-body").replaceChildren(form);
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
  hidden("modal-back", true);
  $("modal-body").replaceChildren();
  for (const id of ["sidebar", "main", "drawer", "mobile-head"]) $(id).inert = false;
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
      .then(() => { if (botById(botId)) select("bot", botId); else toast(`通知指向的 Bot 不在花名册：${botId}`, true); })
      .catch((error) => toast(`打开 Bot 失败：${error.message}`, true));
  };
  document.addEventListener("ompbot:open-bot", openBot);
  window.addEventListener("ompbot:open-bot", openBot);
}

(async function init() {
  bind();
  let dark = false;
  try { dark = localStorage.getItem("omp-bot-theme") === "dark"; } catch { }
  applyTheme(dark);
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

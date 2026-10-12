// app.js — omp-bot GUI 前端。零依赖，纯 DOM。
// 数据来自 /api/*，实时事件走 /api/events (SSE)。

const state = {
  view: "bots", // bots | rooms | usage
  bots: [],
  rooms: [],
  models: [],
  sel: null, // {kind:'bot'|'room', id}
  chats: {}, // botId -> messages[]
  busy: false,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// 稳定的头像颜色（按名字哈希）
function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}
function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

// ---- API ----
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---- toast ----
function toast(msg, isErr = false) {
  const t = el("div", "toast" + (isErr ? " err" : ""), msg);
  $("toast-wrap").appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}

// ---- 加载 ----
async function loadAll() {
  const [st, models] = await Promise.all([
    api("/api/state"),
    api("/api/models").catch(() => ({ models: [] })),
  ]);
  state.bots = st.bots;
  state.rooms = st.rooms;
  state.models = models.models || [];
  renderSidebar();
}

// ---- 侧边栏 ----
function renderSidebar() {
  const list = $("side-list");
  list.innerHTML = "";
  $("btn-new").textContent = state.view === "rooms" ? "＋ 新建群" : state.view === "bots" ? "＋ 新建 Bot" : "＋ 新建";
  $("btn-new").disabled = state.view === "usage";

  if (state.view === "usage") {
    list.appendChild(el("div", "empty-hint", "用量视图"));
    return;
  }

  const items = state.view === "bots" ? state.bots : state.rooms;
  if (!items.length) {
    list.appendChild(el("div", "empty-hint", state.view === "bots" ? "还没有 bot，点下方新建" : "还没有群，点下方新建"));
    return;
  }

  for (const it of items) {
    const row = el("div", "side-item");
    if (state.sel && state.sel.kind === (state.view === "bots" ? "bot" : "room") && state.sel.id === it.id) {
      row.classList.add("active");
    }
    const av = el("div", "avatar", state.view === "bots" ? initials(it.name) : "＃");
    av.style.background = avatarColor(it.name);
    row.appendChild(av);
    const meta = el("div", "meta");
    const nm = el("div", "nm");
    nm.appendChild(document.createTextNode(it.name));
    if (it.isMain) nm.appendChild(el("span", "badge-main", "★"));
    meta.appendChild(nm);
    meta.appendChild(
      el("div", "sub", state.view === "bots" ? it.role || it.model || "默认模型" : `${it.members.length} 人 · ${it.mode}`),
    );
    row.appendChild(meta);
    row.onclick = () => select(state.view === "bots" ? "bot" : "room", it.id);
    list.appendChild(row);
  }
}

// ---- 选择 & 主区 ----
async function select(kind, id) {
  state.sel = { kind, id };
  renderSidebar();
  $("drawer").classList.add("hidden");
  $("main").classList.remove("hidden");
  if (kind === "bot") {
    await loadChat(id);
    renderChatHead();
    renderChat();
  } else {
    renderRoomView(id);
  }
}

function renderChatHead() {
  const bot = state.bots.find((b) => b.id === state.sel.id);
  if (!bot) return;
  $("head-name").textContent = bot.name + (bot.isMain ? " ★" : "");
  $("head-sub").textContent = [bot.role, bot.model || "默认模型", bot.thinking ? `thinking:${bot.thinking}` : ""]
    .filter(Boolean)
    .join(" · ");
  $("btn-settings").onclick = () => openBotSettings(bot);
  $("input").placeholder = `给 ${bot.name} 发消息，Enter 发送`;
}

async function loadChat(botId) {
  try {
    const { messages } = await api(`/api/chat/${botId}`);
    state.chats[botId] = messages || [];
  } catch {
    state.chats[botId] = [];
  }
}

function renderChat() {
  const log = $("chat-log");
  log.innerHTML = "";
  const botId = state.sel.id;
  const bot = state.bots.find((b) => b.id === botId);
  const msgs = state.chats[botId] || [];
  if (!msgs.length) {
    log.appendChild(el("div", "empty-hint", `和 ${bot?.name ?? "它"} 说点什么吧`));
    return;
  }
  for (const m of msgs) {
    const wrap = el("div", "msg " + (m.role === "user" ? "user" : m.role === "error" ? "error" : "bot"));
    const side = el("div");
    side.appendChild(el("div", "who", m.role === "user" ? "你" : m.role === "error" ? "错误" : bot?.name ?? "bot"));
    side.appendChild(el("div", "bubble", m.text));
    wrap.appendChild(side);
    log.appendChild(wrap);
  }
  log.scrollTop = log.scrollHeight;
}

function renderRoomView(roomId) {
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return;
  $("head-name").textContent = "＃ " + room.name;
  const names = room.members.map((id) => state.bots.find((b) => b.id === id)?.name ?? id);
  const admin = state.bots.find((b) => b.id === room.adminId)?.name ?? "-";
  $("head-sub").textContent = `${room.mode} 模式 · admin: ${admin} · 成员: ${names.join(", ")}`;
  $("btn-settings").onclick = () => openRoomSettings(room);
  $("input").placeholder = `在「${room.name}」发言，触发群聊回合`;

  const log = $("chat-log");
  log.innerHTML = "";
  log.appendChild(el("div", "empty-hint", "群聊回合会实时显示每个 bot 的发言"));
  for (const m of room.log || []) {
    log.appendChild(renderRoomMsg(m));
  }
  log.scrollTop = log.scrollHeight;
}

function renderRoomMsg(m) {
  const wrap = el("div", "msg " + (m.kind === "user" ? "user" : "bot"));
  const side = el("div");
  side.appendChild(el("div", "who", m.fromName || m.from));
  side.appendChild(el("div", "bubble", m.text));
  wrap.appendChild(side);
  return wrap;
}

// ---- 发送 ----
async function send() {
  if (state.busy || !state.sel) return;
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  state.busy = true;
  $("btn-send").disabled = true;

  const log = $("chat-log");
  if (state.sel.kind === "bot") {
    // 乐观显示用户消息
    const botId = state.sel.id;
    state.chats[botId] = state.chats[botId] || [];
    state.chats[botId].push({ role: "user", text, at: Date.now() });
    renderChat();
    const typing = el("div", "typing", "输入中…");
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;
    try {
      const { reply } = await api(`/api/chat/${botId}`, { method: "POST", body: { text } });
      state.chats[botId].push({ role: "assistant", text: reply, at: Date.now() });
    } catch (e) {
      state.chats[botId].push({ role: "error", text: e.message, at: Date.now() });
    } finally {
      typing.remove();
      renderChat();
      state.busy = false;
      $("btn-send").disabled = false;
    }
  } else {
    // 群聊：用户消息即时显示，bot 发言由 SSE 实时推送
    const roomId = state.sel.id;
    const room = state.rooms.find((r) => r.id === roomId);
    room.log = room.log || [];
    room.log.push({ kind: "user", from: "user", fromName: "你", text, at: Date.now() });
    log.appendChild(renderRoomMsg({ kind: "user", fromName: "你", text }));
    const typing = el("div", "typing", "群聊回合进行中…");
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;
    try {
      await api(`/api/rooms/${roomId}/say`, { method: "POST", body: { text } });
    } catch (e) {
      toast(e.message, true);
    } finally {
      typing.remove();
      state.busy = false;
      $("btn-send").disabled = false;
    }
  }
}

// ---- SSE：实时事件 ----
function connectSSE() {
  const es = new EventSource("/api/events");
  es.onopen = () => $("conn").classList.add("live");
  es.onerror = () => $("conn").classList.remove("live");
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    handleEvent(e);
  };
}

function handleEvent(e) {
  // 群聊里 bot 的实时发言
  if (e.type === "room_bot_post" && state.sel?.kind === "room" && state.sel.id === e.roomId) {
    const log = $("chat-log");
    log.appendChild(renderRoomMsg({ kind: "bot", fromName: e.bot, text: e.text }));
    log.scrollTop = log.scrollHeight;
    const room = state.rooms.find((r) => r.id === e.roomId);
    if (room) (room.log = room.log || []).push({ kind: "bot", from: e.bot, fromName: e.bot, text: e.text });
  } else if (e.type === "room_bot_pass" && state.sel?.kind === "room" && state.sel.id === e.roomId) {
    const log = $("chat-log");
    log.appendChild(el("div", "sys-line", `${e.bot} 跳过（PASS）`));
    log.scrollTop = log.scrollHeight;
  } else if (["bot_added", "bot_updated", "bot_removed", "room_created", "room_updated", "room_removed"].includes(e.type)) {
    // 结构变化 → 重载
    loadAll();
  } else if (e.type === "exchange_request") {
    toast(`${e.from} → ${e.to}（委派中）`);
  }
}

// ---- 新建 bot ----
function openNewBot() {
  openModal("新建 Bot", botForm(null, async (data) => {
    await api("/api/bots", { method: "POST", body: data });
    closeModal();
    await loadAll();
    toast("已创建 " + data.name);
  }));
}

function botForm(bot, onSave) {
  const body = $("modal-body");
  body.innerHTML = "";
  const f = (label, node, hint) => {
    const w = el("div", "field");
    w.appendChild(el("label", null, label));
    w.appendChild(node);
    if (hint) w.appendChild(el("div", "hint", hint));
    body.appendChild(w);
    return node;
  };
  const name = f("名字", Object.assign(el("input"), { value: bot?.name ?? "", placeholder: "如 Ada" }));
  const role = f("角色", Object.assign(el("input"), { value: bot?.role ?? "", placeholder: "如 协调者" }));
  const modelSel = el("select");
  modelSel.appendChild(Object.assign(el("option"), { value: "", textContent: "（默认模型）" }));
  for (const m of state.models) {
    const v = m.selector || `${m.provider}/${m.id}`;
    modelSel.appendChild(Object.assign(el("option"), { value: v, textContent: `${m.name || m.id}` }));
  }
  if (bot?.model) modelSel.value = bot.model;
  f("模型", modelSel, "选一个 omp models 里已认证的模型");
  const thinkSel = el("select");
  for (const t of ["", "off", "low", "medium", "high", "xhigh", "max"]) {
    thinkSel.appendChild(Object.assign(el("option"), { value: t, textContent: t === "" ? "（默认 low）" : t }));
  }
  thinkSel.value = bot?.thinking ?? "";
  f("思考档", thinkSel);
  const instr = f("专属指令", Object.assign(el("textarea"), { value: bot?.instructions ?? "" }), "写进 bot 人格，如「你保管秘密数字 4271」");
  const isMain = el("input");
  isMain.type = "checkbox";
  isMain.checked = !!bot?.isMain;
  const cl = el("label", "checkline");
  cl.appendChild(isMain);
  cl.appendChild(document.createTextNode("主 bot（★，群里默认当 admin）"));
  body.appendChild(cl);

  const save = el("button", "btn primary wide", bot ? "保存" : "创建");
  save.onclick = () => {
    const data = { name: name.value.trim(), role: role.value.trim(), model: modelSel.value, thinking: thinkSel.value, instructions: instr.value, isMain: isMain.checked };
    if (!data.name) return toast("名字必填", true);
    onSave(data).catch((e) => toast(e.message, true));
  };
  body.appendChild(save);
}

// ---- 新建群 ----
function openNewRoom() {
  if (state.bots.length < 1) return toast("先建至少一个 bot", true);
  openModal("新建群", roomForm(null, async (data) => {
    await api("/api/rooms", { method: "POST", body: data });
    closeModal();
    await loadAll();
    toast("已创建群 " + data.name);
  }));
}

function roomForm(room, onSave) {
  const body = $("modal-body");
  body.innerHTML = "";
  const name = el("input");
  name.value = room?.name ?? "";
  name.placeholder = "如 工作组";
  const wf = el("div", "field");
  wf.appendChild(el("label", null, "群名"));
  wf.appendChild(name);
  body.appendChild(wf);

  body.appendChild(el("label", null, "成员（勾选）")).style.cssText = "font-size:12px;color:var(--muted);margin-bottom:6px;display:block";
  const picks = [];
  const curMembers = new Set(room?.members ?? []);
  for (const b of state.bots) {
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = curMembers.has(b.id);
    cb.dataset.id = b.id;
    picks.push(cb);
    const line = el("div", "member-pick");
    line.appendChild(cb);
    line.appendChild(document.createTextNode(`${b.name}${b.role ? " — " + b.role : ""}`));
    body.appendChild(line);
  }

  const adminSel = el("select");
  const modeSel = el("select");
  for (const mode of ["admin", "everyone"]) {
    modeSel.appendChild(Object.assign(el("option"), { value: mode, textContent: mode === "admin" ? "admin（管理员代答 + @点名）" : "everyone（全员轮流）" }));
  }
  modeSel.value = room?.mode ?? "admin";
  const mf = el("div", "field");
  mf.appendChild(el("label", null, "模式"));
  mf.appendChild(modeSel);
  body.appendChild(mf);

  const af = el("div", "field");
  af.appendChild(el("label", null, "管理员 (admin)"));
  af.appendChild(adminSel);
  body.appendChild(af);
  function refreshAdmins() {
    adminSel.innerHTML = "";
    adminSel.appendChild(Object.assign(el("option"), { value: "", textContent: "（默认第一个成员）" }));
    for (const cb of picks) {
      if (cb.checked) {
        const b = state.bots.find((x) => x.id === cb.dataset.id);
        adminSel.appendChild(Object.assign(el("option"), { value: cb.dataset.id, textContent: b.name }));
      }
    }
    if (room?.adminId) adminSel.value = room.adminId;
  }
  picks.forEach((cb) => (cb.onchange = refreshAdmins));
  refreshAdmins();

  const save = el("button", "btn primary wide", room ? "保存" : "创建");
  save.onclick = () => {
    const members = picks.filter((c) => c.checked).map((c) => c.dataset.id);
    if (!name.value.trim()) return toast("群名必填", true);
    if (!members.length) return toast("至少选一个成员", true);
    onSave({ name: name.value.trim(), members, adminId: adminSel.value || null, mode: modeSel.value }).catch((e) => toast(e.message, true));
  };
  body.appendChild(save);
}

// ---- 设置抽屉 ----
function openBotSettings(bot) {
  const drawer = $("drawer");
  drawer.classList.remove("hidden");
  $("drawer-title").textContent = `设置 · ${bot.name}`;
  const body = $("drawer-body");
  body.innerHTML = "";
  botFormInDrawer(body, bot, async (data) => {
    await api(`/api/bots/${bot.id}`, { method: "PATCH", body: data });
    await loadAll();
    toast("已保存（人格/模型改动会在下一条消息生效）");
    renderChatHead();
  });

  const danger = el("div", "field");
  danger.style.marginTop = "24px";
  const clearBtn = el("button", "btn wide", "清空聊天记录");
  clearBtn.onclick = async () => {
    if (!confirm(`清空 ${bot.name} 的聊天记录？（不影响 bot 的 omp 会话记忆）`)) return;
    await api(`/api/chat/${bot.id}`, { method: "DELETE" });
    state.chats[bot.id] = [];
    renderChat();
  };
  const delBtn = el("button", "btn danger wide", "删除此 bot");
  delBtn.style.marginTop = "8px";
  delBtn.onclick = async () => {
    if (!confirm(`删除 ${bot.name}？其会话文件保留在磁盘。`)) return;
    await api(`/api/bots/${bot.id}`, { method: "DELETE" });
    state.sel = null;
    $("main").classList.add("hidden");
    drawer.classList.add("hidden");
    await loadAll();
    toast("已删除");
  };
  danger.appendChild(clearBtn);
  danger.appendChild(delBtn);
  body.appendChild(danger);
}

// bot 表单（抽屉内嵌版，与 modal 版共用字段逻辑）
function botFormInDrawer(body, bot, onSave) {
  const f = (label, node, hint) => {
    const w = el("div", "field");
    w.appendChild(el("label", null, label));
    w.appendChild(node);
    if (hint) w.appendChild(el("div", "hint", hint));
    body.appendChild(w);
    return node;
  };
  const name = f("名字", Object.assign(el("input"), { value: bot.name }));
  const role = f("角色", Object.assign(el("input"), { value: bot.role ?? "" }));
  const modelSel = el("select");
  modelSel.appendChild(Object.assign(el("option"), { value: "", textContent: "（默认模型）" }));
  for (const m of state.models) {
    const v = m.selector || `${m.provider}/${m.id}`;
    modelSel.appendChild(Object.assign(el("option"), { value: v, textContent: m.name || m.id }));
  }
  modelSel.value = bot.model ?? "";
  f("模型", modelSel);
  const thinkSel = el("select");
  for (const t of ["", "off", "low", "medium", "high", "xhigh", "max"]) {
    thinkSel.appendChild(Object.assign(el("option"), { value: t, textContent: t === "" ? "（默认 low）" : t }));
  }
  thinkSel.value = bot.thinking ?? "";
  f("思考档", thinkSel);
  const instr = f("专属指令", Object.assign(el("textarea"), { value: bot.instructions ?? "" }));
  const isMain = el("input");
  isMain.type = "checkbox";
  isMain.checked = !!bot.isMain;
  const cl = el("label", "checkline");
  cl.appendChild(isMain);
  cl.appendChild(document.createTextNode("主 bot（★）"));
  body.appendChild(cl);
  const save = el("button", "btn primary wide", "保存");
  save.onclick = () =>
    onSave({ name: name.value.trim(), role: role.value.trim(), model: modelSel.value, thinking: thinkSel.value, instructions: instr.value, isMain: isMain.checked }).catch(
      (e) => toast(e.message, true),
    );
  body.appendChild(save);
}

function openRoomSettings(room) {
  const drawer = $("drawer");
  drawer.classList.remove("hidden");
  $("drawer-title").textContent = `群设置 · ${room.name}`;
  const body = $("drawer-body");
  body.innerHTML = "";
  roomFormInDrawer(body, room, async (data) => {
    await api(`/api/rooms/${room.id}`, { method: "PATCH", body: data });
    await loadAll();
    toast("已保存群设置");
    renderRoomView(room.id);
  });
  const del = el("button", "btn danger wide", "删除此群");
  del.style.marginTop = "24px";
  del.onclick = async () => {
    if (!confirm(`删除群「${room.name}」？`)) return;
    await api(`/api/rooms/${room.id}`, { method: "DELETE" });
    state.sel = null;
    $("main").classList.add("hidden");
    drawer.classList.add("hidden");
    await loadAll();
  };
  body.appendChild(del);
}

function roomFormInDrawer(body, room, onSave) {
  const name = el("input");
  name.value = room.name;
  const nf = el("div", "field");
  nf.appendChild(el("label", null, "群名"));
  nf.appendChild(name);
  body.appendChild(nf);
  body.appendChild(el("label", null, "成员")).style.cssText = "font-size:12px;color:var(--muted);margin-bottom:6px;display:block";
  const picks = [];
  const cur = new Set(room.members);
  for (const b of state.bots) {
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = cur.has(b.id);
    cb.dataset.id = b.id;
    picks.push(cb);
    const line = el("div", "member-pick");
    line.appendChild(cb);
    line.appendChild(document.createTextNode(b.name));
    body.appendChild(line);
  }
  const modeSel = el("select");
  for (const mode of ["admin", "everyone"]) {
    modeSel.appendChild(Object.assign(el("option"), { value: mode, textContent: mode }));
  }
  modeSel.value = room.mode;
  const mf = el("div", "field");
  mf.appendChild(el("label", null, "模式"));
  mf.appendChild(modeSel);
  body.appendChild(mf);
  const adminSel = el("select");
  const af = el("div", "field");
  af.appendChild(el("label", null, "管理员"));
  af.appendChild(adminSel);
  body.appendChild(af);
  function refresh() {
    adminSel.innerHTML = "";
    adminSel.appendChild(Object.assign(el("option"), { value: "", textContent: "（默认第一个）" }));
    for (const cb of picks) {
      if (cb.checked) {
        const b = state.bots.find((x) => x.id === cb.dataset.id);
        adminSel.appendChild(Object.assign(el("option"), { value: cb.dataset.id, textContent: b.name }));
      }
    }
    adminSel.value = room.adminId ?? "";
  }
  picks.forEach((cb) => (cb.onchange = refresh));
  refresh();
  const save = el("button", "btn primary wide", "保存");
  save.onclick = () => {
    const members = picks.filter((c) => c.checked).map((c) => c.dataset.id);
    if (!members.length) return toast("至少一个成员", true);
    onSave({ name: name.value.trim(), members, adminId: adminSel.value || null, mode: modeSel.value }).catch((e) => toast(e.message, true));
  };
  body.appendChild(save);
}

// ---- 用量视图 ----
async function showUsage() {
  $("main").classList.remove("hidden");
  $("drawer").classList.add("hidden");
  $("head-name").textContent = "用量";
  $("head-sub").textContent = "当前常驻进程内 runtime 的 token / 请求统计";
  $("btn-settings").onclick = null;
  $("composer").classList.add("hidden");
  $("chat-log").classList.add("hidden");
  let uv = $("usage-view");
  if (!uv) {
    uv = el("div", "", "");
    uv.id = "usage-view";
    $("main").insertBefore(uv, $("composer"));
  }
  uv.classList.remove("hidden");
  uv.innerHTML = "加载中…";
  const { perRuntime, totals } = await api("/api/usage").catch(() => ({ perRuntime: [], totals: {} }));
  if (!perRuntime.length) {
    uv.innerHTML = "";
    uv.appendChild(el("div", "empty-hint", "还没有活跃的 bot 进程。去和某个 bot 聊一句，用量就会出现在这里。"));
    return;
  }
  const table = el("table", "usage");
  const cols = [
    ["bot", (r) => r.botName],
    ["scope", (r) => r.scope],
    ["model", (r) => r.model],
    ["reqs", (r) => r.requests, 1],
    ["tok in", (r) => r.tokensIn, 1],
    ["tok out", (r) => r.tokensOut, 1],
    ["total", (r) => r.totalTokens, 1],
    ["cost", (r) => (r.cost ?? 0).toFixed(4), 1],
  ];
  const thead = el("thead");
  const hr = el("tr");
  for (const [h, , num] of cols) hr.appendChild(el("th", num ? "num" : null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = el("tbody");
  for (const r of perRuntime) {
    const tr = el("tr");
    for (const [, fn, num] of cols) tr.appendChild(el("td", num ? "num" : null, String(fn(r) ?? "")));
    tb.appendChild(tr);
  }
  const tot = el("tr", "total");
  tot.appendChild(el("td", null, "合计"));
  tot.appendChild(el("td"));
  tot.appendChild(el("td"));
  tot.appendChild(el("td", "num", String(totals.requests ?? 0)));
  tot.appendChild(el("td", "num", String(totals.tokensIn ?? 0)));
  tot.appendChild(el("td", "num", String(totals.tokensOut ?? 0)));
  tot.appendChild(el("td", "num", String(totals.totalTokens ?? 0)));
  tot.appendChild(el("td", "num", (totals.cost ?? 0).toFixed(4)));
  tb.appendChild(tot);
  table.appendChild(tb);
  uv.innerHTML = "";
  uv.appendChild(table);
}

function leaveUsageView() {
  const uv = $("usage-view");
  if (uv) uv.classList.add("hidden");
  $("composer").classList.remove("hidden");
  $("chat-log").classList.remove("hidden");
}

// ---- modal ----
function openModal(title, buildFn) {
  $("modal-title").textContent = title;
  $("modal-back").classList.remove("hidden");
  buildFn();
}
function closeModal() {
  $("modal-back").classList.add("hidden");
  $("modal-body").innerHTML = "";
}

// ---- 事件绑定 ----
function bind() {
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.onclick = () => {
      for (const b of document.querySelectorAll(".nav-btn")) b.classList.remove("active");
      btn.classList.add("active");
      state.view = btn.dataset.view;
      if (state.view === "usage") {
        state.sel = null;
        renderSidebar();
        showUsage();
      } else {
        leaveUsageView();
        // 选中项与当前视图类型不符（如从群聊切到 Bots）→ 回到未选中态，
        // 否则主区会残留上一个视图的内容。
        const wantKind = state.view === "bots" ? "bot" : "room";
        if (state.sel && state.sel.kind === wantKind) {
          select(state.sel.kind, state.sel.id);
        } else {
          state.sel = null;
          $("main").classList.add("hidden");
        }
        renderSidebar();
      }
    };
  }
  $("btn-new").onclick = () => (state.view === "rooms" ? openNewRoom() : openNewBot());
  $("btn-send").onclick = send;
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $("input").addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 160) + "px";
  });
  $("drawer-close").onclick = () => $("drawer").classList.add("hidden");
  $("modal-close").onclick = closeModal;
  $("modal-back").onclick = (e) => { if (e.target.id === "modal-back") closeModal(); };
}

// ---- 启动 ----
(async function init() {
  bind();
  connectSSE();
  $("main").classList.add("hidden");
  try {
    await loadAll();
  } catch (e) {
    toast("加载失败: " + e.message, true);
  }
})();

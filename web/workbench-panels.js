/*
 * Product panels: activity/tasks, run detail, native capabilities, skills, MCP,
 * memory, routines, devices/channels and model catalog.
 * Every panel is driven by a real endpoint; a missing endpoint renders an honest
 * pending note instead of a fake control.
 */
import { el, button, toast, announce, api, apiOptional, fmtTime, fmtClock, fmtDuration, fmtWhen, renderMarkdown, fmtSize, runStateLabel, isLiveRun, downloadText, BOT_PERMISSION_LABELS, permissionOf } from "./workbench-core.js";
import { artifactCard, loadArtifacts, exportRunTranscript } from "./workbench-attach.js";
import { createComputerView } from "./workbench-computer.js";

const FILTERS = [
  ["all", "全部", () => true],
  ["attention", "待我处理", (run) => ["waiting_input", "waiting_approval"].includes(run.state)],
  ["active", "进行中", (run) => isLiveRun(run.state)],
  ["completed", "已完成", (run) => run.state === "completed"],
  ["failed", "失败", (run) => ["failed", "cancelled", "interrupted", "reconciliation_required"].includes(run.state)],
];

const SIDE_EFFECT_LABELS = { in_flight: "进行中", done: "做完了", unknown: "结果未知，要人工核对" };

const DROP_REASON_LABELS = {
  parent_cancelled: "派活的任务被取消了",
  parent_bot_gone: "派活的助手已删除",
  target_gone: "接手的助手已删除",
  visibility_revoked: "两个助手已不在同一工作区",
  wake_rejected: "交回时被拒",
  budget_exhausted: "整棵派工树的预算用完了，没能唤醒派活的助手",
  rejected_inline: "当场就被拒，报错已直接给了派活的助手",
};

const DELEGATION_RESULT_LABELS = {
  completed: "做完了",
  failed: "失败了",
  cancelled: "被取消了",
  interrupted: "重启中断了",
  reconciliation_required: "要人工核对",
  not_started: "没能开跑",
};

/** 一条派活给用户看的状态：执行到哪、交回了没有，合成一句。 */
function delegationStatus(rec) {
  if (rec.state === "queued") return { key: "queued", label: "排队中" };
  if (rec.state === "running") return { key: "running", label: "在做" };
  const done = DELEGATION_RESULT_LABELS[rec.result?.state] ?? "结束了";
  if (rec.delivery === "delivered") return { key: "delivered", label: `${done}，已交回` };
  if (rec.delivery === "dropped") return { key: "dropped", label: `${done}，没交回` };
  return { key: "pending", label: `${done}，等着交回` };
}

function pendingNote(what, endpoint) {
  const note = el("div", "wb-pending");
  note.append(el("div", "wb-pending-title", `${what}暂不可用`));
  note.append(el("div", "bt-note", `本地服务还没有提供 ${endpoint}（或返回 404），所以这里不会放假操作。接口就绪后刷新页面即可。`));
  return note;
}

function section(title, ...children) {
  const box = el("section", "bt-set-section wb-section");
  const head = el("h3", null, title);
  box.append(head);
  const card = el("div", "bt-set-card");
  card.append(...children.filter(Boolean));
  box.append(card);
  return box;
}

let rowLabelSeq = 0;

/**
 * 行内表单控件的统一命名：没有自己的 aria-label、也没有外层 <label> 的控件，
 * 用行标题作可访问名称、提示作说明；按钮与隐藏输入不动。
 */
function bindRowLabels(control, labelId, hintId) {
  const controls = control.matches("input, select, textarea") ? [control] : [...control.querySelectorAll("input, select, textarea")];
  for (const node of controls) {
    if (["hidden", "button", "submit", "reset", "image"].includes(node.type)) continue;
    if (node.closest("label")) continue; // 复选框等已由外层 label 命名，不再重复挂行标题
    if (!node.hasAttribute("aria-label") && !node.hasAttribute("aria-labelledby")) node.setAttribute("aria-labelledby", labelId);
    if (hintId && !node.hasAttribute("aria-describedby")) node.setAttribute("aria-describedby", hintId);
  }
}

function row(label, hint, control) {
  const node = el("div", "bt-set-row");
  const copy = el("div", "bt-set-copy");
  const title = el("div", null, label);
  copy.append(title);
  const hintNode = hint ? el("div", "bt-set-hint", hint) : null;
  if (hintNode) copy.append(hintNode);
  node.append(copy);
  if (control) {
    const box = el("div", "bt-set-control");
    box.append(control);
    node.append(box);
    if (typeof label === "string" && label.trim()) {
      const seq = ++rowLabelSeq;
      title.id = `wb-row-label-${seq}`;
      if (hintNode) hintNode.id = `wb-row-hint-${seq}`;
      bindRowLabels(control, title.id, hintNode ? hintNode.id : null);
    }
  }
  return node;
}

function kv(key, value) {
  const line = el("div", "bt-kv");
  line.append(el("span", null, key), el("span", null, value == null || value === "" ? "—" : String(value)));
  return line;
}

const ms = (value) => (typeof value === "number" ? value : Date.parse(value));

const TTL_OPTIONS = [["300000", "5 分钟"], ["3600000", "1 小时"], ["86400000", "1 天"]];

const PERMISSION_LABELS = { read: "读取", run: "运行", approve: "审批" };

/** 服务端错误可能是字符串，也可能是 {code,message}：原样带出来，不吞信息。 */
function errorText(value) {
  if (value == null) return "未知错误";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (typeof value.message === "string") return value.code ? `${value.message}（${value.code}）` : value.message;
  if (value.code) return String(value.code);
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * 原生 get_state 的 model 可能是字符串，也可能是 {id|model, provider, name} 对象。
 * 统一成可读标识（provider/id，name 作补充），绝不把对象原样 String() 成 [object Object]。
 */
function modelText(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  const id = (typeof value.id === "string" && value.id)
    || (typeof value.model === "string" && value.model)
    || (typeof value.name === "string" && value.name)
    || null;
  if (!id) return null;
  const provider = typeof value.provider === "string" && value.provider ? value.provider : null;
  const base = provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
  return typeof value.name === "string" && value.name && value.name !== id ? `${base}（${value.name}）` : base;
}

function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function select(values, current, onChange) {
  const node = el("select", "bt-select");
  for (const [value, label] of values) {
    const opt = el("option", null, label);
    opt.value = value;
    node.append(opt);
  }
  node.value = current ?? "";
  if (onChange) node.onchange = () => onChange(node.value);
  return node;
}

function busy(control, promise, label = "保存中…") {
  const previous = control.textContent;
  control.disabled = true;
  control.textContent = label;
  return Promise.resolve(promise).finally(() => { control.disabled = false; control.textContent = previous; });
}

export function createPanels({ client, deps }) {
  const models = { list: [], at: 0 };

  /** The drawer renders one bot at a time; browser actions need its id. */
  let currentBot = null;

  /* ------------------------------- activity ------------------------------- */

  function activityView() {
    const root = el("section", "wb-activity-view");
    const head = el("div", "wb-view-head");
    head.append(el("h1", null, "任务"));
    const toolbar = el("div", "ui-toolbar");
    toolbar.append(button("btn ghost", "连接手机", () => deps.openDrawer("连接手机", () => pairingSection())));
    toolbar.append(button("btn ghost", "飞书连接", () => deps.openDrawer("飞书连接", () => feishuSection())));
    toolbar.append(button("btn ghost", "刷新", () => void draw()));
    head.append(toolbar);
    root.append(head);

    let filter = "all";
    let query = "";

    // 页签上直接带数量，计数复用页签的筛选规则，数字和列表不会对不上。
    const bar = el("div", "wb-task-bar");
    const tabs = el("div", "bt-tabs wb-tabs");
    tabs.setAttribute("role", "tablist");
    const tabButtons = new Map();
    const metricValues = new Map();
    for (const [id, label] of FILTERS) {
      const tab = button("bt-tab", label, () => { filter = id; paint(); });
      tab.setAttribute("role", "tab");
      tab.dataset.filter = id;
      if (id !== "all") {
        const count = el("span", "wb-tab-count", "0");
        count.dataset.metric = id;
        tab.append(count);
        metricValues.set(id, count);
      }
      tabButtons.set(id, tab);
      tabs.append(tab);
    }
    bar.append(tabs);

    const search = el("input", "bt-input wb-search");
    search.type = "search";
    search.placeholder = "搜索任务内容、助手名称或状态";
    search.setAttribute("aria-label", "搜索任务");
    search.oninput = () => { query = search.value.trim(); paint(); };
    bar.append(search);
    root.append(bar);

    const list = el("div", "wb-run-list wb-row-group");
    const approvals = el("div", "wb-approval-list");
    const empty = el("div", "bt-empty hidden");
    const emptyTitle = el("div", null, "还没有任务");
    const emptyHint = el("div", "bt-note");
    empty.append(emptyTitle, emptyHint);
    // 助手之间派的活：排队、在做、交回了没有。放在任务列表上面，空就整块隐藏。
    const delegationBox = el("div", "wb-approval-list wb-delegation-list hidden");
    let delegations = [];
    let delegationTimer = null;
    // 团队事实：成员提议等你确认、接受时撞车的，和现在写在团队共识里的事实。都没有就整块隐藏。
    const factBox = el("div", "wb-approval-list wb-fact-list hidden");
    let teamFacts = { facts: [], proposals: [] };
    let factsOpen = false;
    root.append(approvals, factBox, delegationBox, list, empty);

    // 导出是低频动作，收进默认收起的「高级选项」，不占主流程。
    const exportAll = button("btn ghost", "导出全部任务", () => {
      const runs = client.all();
      if (!runs.length) { toast("还没有任务记录", true); return; }
      downloadText("runs.json", JSON.stringify(runs, null, 2), "application/json;charset=utf-8");
    });
    const advanced = el("details", "ui-disclosure");
    advanced.append(el("summary", null, "高级选项"));
    const advancedBody = el("div", "ui-disclosure-body");
    advancedBody.append(row("导出全部任务", "把全部任务记录导出为一个文件，用于备份或排查问题。", exportAll));
    advanced.append(advancedBody);
    root.append(advanced);

    async function loadDelegations() {
      try {
        const { delegations: rows } = await api("/api/delegations?limit=20");
        delegations = Array.isArray(rows) ? rows : [];
      } catch {
        delegations = [];
      }
      paintDelegations();
    }

    async function loadTeamFacts() {
      try {
        const data = await api("/api/team/facts");
        teamFacts = { facts: Array.isArray(data?.facts) ? data.facts : [], proposals: Array.isArray(data?.proposals) ? data.proposals : [] };
      } catch {
        teamFacts = { facts: [], proposals: [] };
      }
      paintTeamFacts();
    }

    /** 任务一有变化就顺手刷新派活和团队事实提议（落定、交回、提议都发生在 Run 里），合并成一次请求。 */
    function scheduleDelegations() {
      clearTimeout(delegationTimer);
      delegationTimer = setTimeout(() => { void loadDelegations(); void loadTeamFacts(); }, 300);
    }

    function paintTeamFacts() {
      factBox.replaceChildren();
      const pending = teamFacts.proposals.filter((p) => p.state === "pending");
      // 撞车的只留一天：提示该重提了，过后就不占地方。
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const conflicts = teamFacts.proposals.filter((p) => p.state === "conflict" && (p.decidedAt ?? 0) > dayAgo);
      const facts = teamFacts.facts;
      factBox.classList.toggle("hidden", !pending.length && !conflicts.length && !facts.length);
      if (pending.length || conflicts.length) {
        factBox.append(el("div", "wb-dock-label", `团队事实待确认（${pending.length}）`));
        for (const p of [...pending, ...conflicts]) factBox.append(proposalTile(p));
      }
      if (facts.length) {
        const more = el("details", "ui-disclosure wb-fact-current");
        // 纠正完会重画，记住展开状态，免得用户连着改几条要反复点开。
        more.open = factsOpen;
        more.addEventListener("toggle", () => { factsOpen = more.open; });
        more.append(el("summary", null, `现在的团队事实（${facts.length}）`));
        const body = el("div", "ui-disclosure-body");
        for (const fact of facts) {
          body.append(row(fact.text, null, button("btn ghost", "纠正", function () {
            const next = prompt("改成什么？一行写完。", fact.text);
            if (next == null || !next.trim() || next.trim() === fact.text) return;
            return busy(this, api("/api/team/facts", { method: "POST", body: { fact: next, replaces: fact.text, source: "用户在工作台纠正" } })
              .then(() => { toast("已改好，旧说法不会再被写回"); return loadTeamFacts(); })
              .catch((error) => { toast(error.message, true); return loadTeamFacts(); }), "保存中…");
          })));
        }
        more.append(body);
        factBox.append(more);
      }
    }

    function proposalTile(p) {
      const tile = el("div", "wb-run-tile");
      tile.dataset.proposalId = p.id;
      tile.dataset.state = p.state;
      const top = el("div", "wb-run-top");
      top.append(el("span", "wb-run-bot", `${p.botName || "用户"} 提议`));
      top.append(el("span", "bt-state wb-run-state", p.state === "conflict" ? "旧事实已变，要重提" : "等你确认"));
      tile.append(top);
      tile.append(el("div", "wb-run-text", p.replaces ? `把「${p.replaces}」改成「${p.fact}」` : `新增：${p.fact}`));
      tile.append(el("div", "bt-note", `来源：${p.source}`));
      if (p.state === "conflict" && p.reason) tile.append(el("div", "bt-note", String(p.reason)));
      const foot = el("div", "wb-run-foot");
      foot.append(el("span", "wb-run-time", fmtTime(p.createdAt)));
      const actions = el("div", "bt-actions");
      if (p.state === "pending") {
        const decide = (what, label) => function () {
          return busy(this, api(`/api/team/proposals/${encodeURIComponent(p.id)}/${what}`, { method: "POST", body: {} })
            .then(() => { toast(label); return loadTeamFacts(); })
            .catch((error) => { toast(error.message, true); return loadTeamFacts(); }), "处理中…");
        };
        actions.append(button("btn", "接受", decide("accept", "已写进团队共识")), button("btn ghost", "拒绝", decide("reject", "已拒绝")));
      }
      foot.append(actions);
      tile.append(foot);
      return tile;
    }

    function paintDelegations() {
      delegationBox.replaceChildren();
      delegationBox.classList.toggle("hidden", delegations.length === 0);
      if (!delegations.length) return;
      delegationBox.append(el("div", "wb-dock-label", `助手之间派的活（${delegations.length}）`));
      const group = el("div", "wb-row-group");
      for (const rec of delegations) group.append(delegationTile(rec));
      delegationBox.append(group);
    }

    function delegationTile(rec) {
      const who = `${rec.fromName || rec.fromBotId} → ${rec.targetName || rec.targetBotId}`;
      const status = delegationStatus(rec);
      const tile = compactRow({ who, text: rec.message, label: status.label, tone: delegationTone(rec), at: rec.createdAt },
        () => void deps.openDrawer(who, () => delegationDetail(rec)));
      tile.dataset.delegationId = rec.id;
      tile.dataset.state = status.key;
      return tile;
    }

    function paintApprovals() {
      approvals.replaceChildren();
      const pending = client.pending();
      if (!pending.length) {
        approvals.classList.add("hidden");
        return;
      }
      approvals.classList.remove("hidden");
      approvals.append(el("div", "wb-dock-label", `需要你确认（${pending.length}）`));
      for (const record of pending) approvals.append(deps.approvalCard ? deps.approvalCard(record) : el("div", "bt-empty", record.title || record.id));
    }

    /** 搜索命中范围：任务文本、助手真实名字、用户能读到的状态，以及内部标识。 */
    function runSearchText(run) {
      const bot = deps.botFor(run.botId);
      return [run.text, bot?.name, run.botId, run.id, runStateLabel(run.state), run.state]
        .filter(Boolean).join(" ").toLocaleLowerCase();
    }

    function paintEmpty(count) {
      empty.classList.toggle("hidden", count > 0);
      if (count > 0) return;
      if (query) {
        emptyTitle.textContent = `没有找到和「${query}」有关的任务`;
        emptyHint.textContent = "换个词试试，或者清空搜索框。";
      } else if (filter !== "all") {
        emptyTitle.textContent = "这一类还没有任务";
        emptyHint.textContent = "切到「全部」可以看到其他任务。";
      } else {
        emptyTitle.textContent = "还没有任务";
        emptyHint.textContent = "在助手里说一句想做什么，任务就会出现在这里。";
      }
    }

    function paint() {
      for (const [id, tab] of tabButtons) tab.setAttribute("aria-selected", String(id === filter));
      const all = client.all();
      for (const [id, value] of metricValues) {
        const predicate = FILTERS.find(([filterId]) => filterId === id)[2];
        const n = all.filter(predicate).length;
        value.textContent = String(n);
        value.classList.toggle("is-zero", n === 0);
      }
      paintApprovals();
      const predicate = FILTERS.find(([id]) => id === filter)[2];
      const needle = query.toLocaleLowerCase();
      list.replaceChildren();
      const runs = all
        .filter(predicate)
        .filter((run) => !needle || runSearchText(run).includes(needle))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      paintEmpty(runs.length);
      for (const run of runs) list.append(runTile(run));
      announce(`${runs.length} 个任务`);
    }

    /** 列表里的一行：谁、做什么、状态、时间。整行是一个按钮，点开详情。 */
    function compactRow({ who, text, label, tone, at }, open) {
      const tile = el("div", "wb-run-tile wb-row");
      const main = el("button", "wb-row-main");
      main.type = "button";
      main.onclick = open;
      const pill = el("span", "wb-pill wb-run-state", label);
      pill.dataset.tone = tone;
      main.append(
        el("span", "wb-run-bot", who),
        el("span", "wb-run-text", String(text || "").replace(/\s+/g, " ").trim().slice(0, 240) || "（没有内容）"),
        pill,
        el("span", "wb-run-time", fmtWhen(at)),
      );
      tile.append(main);
      return tile;
    }

    function runTile(run) {
      const bot = deps.botFor(run.botId);
      // kind、scope、深度这些内部字段只留在任务详情里，主视图不出现。
      const tile = compactRow({ who: bot?.name || run.botId || "任务", text: run.text, label: runStateLabel(run.state), tone: runTone(run.state), at: run.createdAt },
        () => void deps.openDrawer(`${bot?.name || "助手"}的任务`, () => runDetail(run)));
      tile.dataset.runId = run.id;
      tile.dataset.state = run.state;
      if (isLiveRun(run.state)) {
        tile.append(button("btn ghost danger wb-row-stop", "停止", () => void client.cancel(run.id).then(() => { toast("已接受取消请求"); paint(); }).catch((error) => toast(error.message, true))));
      }
      return tile;
    }

    async function draw() {
      try {
        const { runs } = await api("/api/runs");
        for (const run of runs || []) client.record(run);
        paint();
      } catch (error) {
        toast(`任务列表加载失败：${error.message}`, true);
        paint();
      }
    }

    void draw();
    void loadDelegations();
    void loadTeamFacts();
    return {
      node: root,
      refresh: () => { void loadDelegations(); void loadTeamFacts(); return draw(); },
      repaint: () => { paint(); scheduleDelegations(); },
    };
  }

  /* ----------------------------- detail pieces ---------------------------- */

  /** 外部动作给人看的名字；没收录的工具照原名显示。 */
  const EFFECT_TOOL_LABELS = {
    computer_shell: "运行命令",
    computer_install_packages: "安装软件包",
    computer_publish_file: "发布文件",
    computer_files: "文件操作",
    computer_input: "键鼠操作",
    computer_upload_attachment: "上传附件",
    computer_screenshot: "截图",
  };

  const RUN_TONES = {
    completed: "ok",
    failed: "bad",
    cancelled: "muted",
    interrupted: "muted",
    reconciliation_required: "warn",
    waiting_input: "warn",
    waiting_approval: "warn",
  };
  const runTone = (state) => RUN_TONES[state] ?? (isLiveRun(state) ? "live" : "muted");

  function delegationTone(rec) {
    const key = delegationStatus(rec).key;
    if (key === "queued" || key === "running") return "live";
    if (["failed", "reconciliation_required", "not_started"].includes(rec.result?.state)) return "bad";
    if (key === "dropped") return "warn";
    return key === "delivered" ? "ok" : "muted";
  }

  /** 抽屉顶部：状态胶囊和一行时间。 */
  function detailHero(label, tone, meta) {
    const hero = el("div", "wb-detail-hero");
    const pill = el("span", "wb-pill", label);
    pill.dataset.tone = tone;
    hero.append(pill);
    const line = meta.filter(Boolean).join(" · ");
    if (line) hero.append(el("span", "wb-detail-meta", line));
    return hero;
  }

  function callout(tone, title, text, alert = false) {
    const box = el("div", "wb-callout");
    box.dataset.tone = tone;
    if (alert) box.setAttribute("role", "alert");
    box.append(el("div", "wb-callout-title", title));
    if (text) box.append(el("div", "wb-callout-text", String(text)));
    return box;
  }

  /** 正文块：标题加一段正文。markdown 为真时按助手回复渲染。 */
  function block(title, text, markdown = false) {
    const box = el("section", "wb-block");
    box.append(el("h3", "wb-block-title", title));
    const body = el("div", markdown ? "wb-prose wb-prose-md" : "wb-prose");
    if (markdown) renderMarkdown(body, text);
    else body.textContent = String(text || "（没有内容）");
    box.append(body);
    return box;
  }

  function checklist(items) {
    const list = el("ul", "wb-checklist");
    for (const item of items) list.append(el("li", null, String(item)));
    return list;
  }

  /** 技术信息：排查用，默认收起。值为空的行不显示。 */
  function techDetails(pairs, ...extra) {
    const box = el("details", "ui-disclosure wb-tech");
    box.append(el("summary", null, "技术信息"));
    const body = el("div", "ui-disclosure-body");
    const facts = el("div", "wb-kv-list wb-tech-list");
    for (const [key, value] of pairs) if (value != null && value !== "") facts.append(kv(key, value));
    body.append(facts, ...extra.filter(Boolean));
    box.append(body);
    return box;
  }

  const spanOf = (from, to) => (from && to ? fmtDuration(ms(to) - ms(from)) : null);

  /* --------------------------- delegation detail -------------------------- */

  function delegationDetail(rec) {
    const root = el("div", "wb-detail");
    const status = delegationStatus(rec);
    const span = spanOf(rec.startedAt || rec.createdAt, rec.returnedAt);
    root.append(detailHero(status.label, delegationTone(rec), [
      rec.createdAt ? `${fmtWhen(rec.createdAt)} 派出` : null,
      span ? `用时 ${span}` : null,
    ]));
    if (rec.dropReason) root.append(callout("warn", "没交回", DROP_REASON_LABELS[rec.dropReason] ?? rec.dropReason));
    if (rec.result?.error) root.append(callout("bad", "出错了", rec.result.error, true));
    root.append(block("派的活", rec.message));
    const acceptance = Array.isArray(rec.acceptance) ? rec.acceptance : [];
    if (acceptance.length) {
      const box = el("section", "wb-block");
      box.append(el("h3", "wb-block-title", "验收标准"), checklist(acceptance));
      root.append(box);
    }
    if (rec.result?.reply) root.append(block("交回的结果", rec.result.reply, true));
    root.append(techDetails([
      ["派活号", rec.id],
      ["派活的", rec.fromName || rec.fromBotId],
      ["接手的", rec.targetName || rec.targetBotId],
      ["派出", rec.createdAt ? fmtTime(rec.createdAt) : null],
      ["开跑", rec.startedAt ? fmtTime(rec.startedAt) : null],
      ["结束", rec.returnedAt ? fmtTime(rec.returnedAt) : null],
      ["交回", rec.deliveredAt ? fmtTime(rec.deliveredAt) : null],
      ["子任务", rec.childRunId],
      ["交回的任务", rec.wakeRunId],
    ]));
    return root;
  }

  /* ------------------------------ run detail ------------------------------ */

  function effectList(effects) {
    const list = el("div", "wb-effects");
    for (const effect of effects) {
      const tool = effect?.tool || effect?.kind || effect?.id || "";
      const status = effect?.status ?? "";
      const failed = status === "done" && effect?.outcome === "error";
      const outcome = failed ? "做完了，报错" : SIDE_EFFECT_LABELS[status] ?? status ?? "—";
      const item = el("div", "wb-effect");
      item.dataset.effectStatus = status;
      item.dataset.tone = status === "unknown" ? "warn" : failed ? "bad" : status === "in_flight" ? "live" : "ok";
      if (tool) item.dataset.tool = tool;
      item.append(el("span", "wb-effect-dot"));
      item.append(el("span", "wb-effect-name", EFFECT_TOOL_LABELS[tool] ?? (tool || "动作")));
      item.append(el("span", "wb-effect-state", effect?.error ? `${outcome}：${effect.error}` : outcome));
      list.append(item);
    }
    return list;
  }

  async function runDetail(run) {
    const root = el("div", "wb-detail");
    const span = isLiveRun(run.state) ? null : spanOf(run.createdAt, run.updatedAt);
    root.append(detailHero(runStateLabel(run.state), runTone(run.state), [
      run.createdAt ? fmtWhen(run.createdAt) : null,
      span ? `用时 ${span}` : null,
    ]));
    if (run.error) root.append(callout("bad", "出错了", run.error, true));
    const effects = Array.isArray(run.sideEffects) ? run.sideEffects : [];
    // 「结果未知」是进程在动作中途没了，要人工去核对，不会自动重发。
    const unknown = effects.filter((effect) => effect?.status === "unknown").length;
    if (unknown) root.append(callout("warn", `有 ${unknown} 个动作结果未知`, "进程在动作中途停了，系统不会自动重做。请去核对一下实际结果。"));
    root.append(block("任务内容", run.text));
    if (run.reply) root.append(block("助手的回复", run.reply, true));
    if (effects.length) {
      const box = el("section", "wb-block");
      box.append(el("h3", "wb-block-title", "做过的动作"), effectList(effects));
      root.append(box);
    }

    const artifacts = await loadArtifacts({ runId: run.id });
    if (artifacts === null) root.append(section("成果", pendingNote("成果", "/api/artifacts")));
    else if (artifacts.length) {
      const box = el("div", "wb-artifact-list");
      for (const artifact of artifacts) box.append(artifactCard(artifact));
      root.append(section(`成果（${artifacts.length}）`, box));
    }

    const actions = el("div", "wb-detail-actions");
    if (isLiveRun(run.state)) {
      actions.append(button("btn ghost danger", "停止", function () { return busy(this, client.cancel(run.id).then(() => { toast("已接受取消请求"); announce("已接受取消请求"); }), "停止中…"); }));
    }
    if (run.botId) {
      actions.append(button("btn ghost", "重试", () => {
        if (!confirm("重试会以相同内容发起一个新任务。已经发生的对外动作不会回滚。继续？")) return;
        void client.start({ botId: run.botId, text: run.text, source: "retry", parentRunId: run.id })
          .then(() => toast("已发起重试任务"))
          .catch((error) => toast(`重试失败：${error.message}`, true));
      }));
      actions.append(button("btn ghost", "新会话", function () {
        if (!confirm("开启新会话：保留旧会话历史，下一条消息进入一个新的原生会话。继续？")) return;
        return busy(this, api(`/api/bots/${encodeURIComponent(run.botId)}/session/new`, { method: "POST", body: {} }).then(() => toast("已开启新会话")), "创建中…");
      }));
      actions.append(button("btn ghost", "分叉", function () {
        return busy(this, api(`/api/bots/${encodeURIComponent(run.botId)}/session/fork`, { method: "POST", body: {} }).then(() => toast("已分叉会话")), "分叉中…");
      }));
      actions.append(button("btn ghost", "导出", () => exportRunTranscript(run)));
    }
    if (actions.childElementCount) root.append(actions);

    const extra = [];
    if (run.botId) {
      const exportLink = el("a", "btn ghost", "导出原生会话 HTML");
      exportLink.href = `/api/bots/${encodeURIComponent(run.botId)}/session/export`;
      exportLink.setAttribute("download", "");
      const exportRow = el("div", "wb-detail-actions");
      exportRow.append(exportLink);
      extra.push(exportRow);
      // 原生会话读不出来（比如 omp 不在、会话文件坏了）时只这一块报错，上面的状态和外部动作照常显示。
      for (const [what, load] of [["原生会话条目", nativeEntriesSection], ["原生会话状态", nativeStateSection]]) {
        try {
          extra.push(await load(run.botId));
        } catch (error) {
          extra.push(section(what, el("div", "bt-empty", `读取失败：${error.message}`)));
        }
      }
    }
    root.append(techDetails([
      ["任务号", run.id],
      ["助手", deps.botFor(run.botId)?.name || run.botId],
      ["类型", run.kind],
      ["范围", run.scope],
      ["创建", run.createdAt ? fmtTime(run.createdAt) : null],
      ["更新", run.updatedAt ? fmtTime(run.updatedAt) : null],
      ["会话", run.sessionId],
      ["会话文件", run.sessionFile],
      ["预算", run.budget != null ? JSON.stringify(run.budget) : null],
      ["深度", run.depth],
      ...effects.map((effect, i) => [`动作 ${i + 1}`, [effect?.tool || effect?.kind, effect?.id].filter(Boolean).join(" · ")]),
    ], ...extra));
    return root;
  }

  async function nativeEntriesSection(botId) {
    const data = await apiOptional(`/api/bots/${encodeURIComponent(botId)}/native/entries`);
    if (!data) return section("原生会话条目", pendingNote("原生会话条目", `/api/bots/${botId}/native/entries`));
    const entries = data.entries || [];
    const box = el("div", "wb-entries");
    if (!entries.length) box.append(el("div", "bt-empty", "还没有原生会话条目。"));
    for (const entry of entries) {
      const line = el("div", "wb-entry");
      line.append(el("span", "wb-entry-kind", entry.type || entry.kind || "entry"));
      line.append(el("span", "wb-entry-text", String(entry.text || entry.summary || entry.id || "").slice(0, 300)));
      line.append(el("span", "bt-note", fmtTime(entry.at || entry.createdAt)));
      const fork = button("btn ghost", "从此分叉", function () {
        if (!confirm("从该条目分叉会话？会创建新的原生会话分支，不改动旧会话。")) return;
        return busy(this, api(`/api/bots/${encodeURIComponent(botId)}/session/fork`, { method: "POST", body: { entryId: entry.id } }).then(() => toast("已从该条目分叉")), "分叉中…");
      });
      if (!entry.id) fork.disabled = true;
      line.append(fork);
      box.append(line);
    }
    return section(`原生会话条目（${entries.length}）`, box);
  }

  async function nativeStateSection(botId) {
    if (!botId) return el("div");
    const data = await apiOptional(`/api/bots/${encodeURIComponent(botId)}/native/state`);
    if (!data) return section("原生会话状态", pendingNote("原生会话状态", `/api/bots/${encodeURIComponent(botId)}/native/state`));
    const box = el("div", "wb-kv-list");
    for (const key of ["started", "busy", "sessionId", "sessionFile", "executionMode", "approvalMode", "sandbox"]) {
      if (data[key] !== undefined) box.append(kv(key, typeof data[key] === "object" ? JSON.stringify(data[key]) : String(data[key])));
    }
    if (data.sandboxNote) box.append(el("div", "bt-note", String(data.sandboxNote)));
    const state = data.state && typeof data.state === "object" ? data.state : null;
    if (state) {
      for (const [key, value] of Object.entries(state)) {
        box.append(kv(`state.${key}`, value && typeof value === "object" ? JSON.stringify(value) : String(value)));
      }
    } else if (data.state !== undefined) box.append(kv("state", String(data.state)));
    const capabilities = data.capabilities;
    if (capabilities) box.append(kv("capabilities", typeof capabilities === "object" ? JSON.stringify(capabilities) : String(capabilities)));
    const wrap = section("原生会话状态", box);
    const more = el("details", "wb-raw");
    more.append(el("summary", null, "原始状态 JSON"));
    more.append(el("pre", "wb-pre", JSON.stringify(data, null, 2)));
    wrap.append(more);
    return wrap;
  }

  /* --------------------------- bot settings panels ------------------------- */

  async function capabilitiesPanel(bot) {
    currentBot = bot;
    const root = el("div", "wb-panel-body");
    root.append(el("p", "ui-intro", "这里决定这个助手能做什么，以及动手前要不要先问你。改动会立刻保存。"));
    const capabilities = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/native/capabilities`);
    const computer = capabilities && capabilities.computer && capabilities.computer.bound === true ? capabilities.computer : null;
    // 常用设置放最前：能做什么、问不问、在哪里工作，然后是记忆与登录。
    const permissionCard = el("div", "bt-set-card");
    const PERMISSION_HINTS = {
      chat: "只聊天：不运行命令，不改文件，也不用电脑。",
      ask: "本机改东西先问我：读写文件照常，运行命令和操作浏览器前先问你。共享电脑里除装系统包都不问。",
      full: "全部放手：本机和共享电脑都不再逐次问你，装系统包仍会问。可访问当前账户有权限的文件和程序。",
    };
    const level = permissionOf(bot);
    permissionCard.append(row("权限", `${PERMISSION_HINTS[level]}选择从下一次任务生效。工作目录不限制文件访问范围。`,
      select(Object.entries(BOT_PERMISSION_LABELS), level, async (value) => {
        if (value === "full" && !confirm(`让「${bot.name}」全部放手？\n\n之后它可以读写文件、运行命令、操作浏览器，不再逐次向你确认，可访问当前账户有权限的文件和程序。需要你提供的信息和装系统包仍会问。\n\n选择会保留，从下一次任务生效，可随时改回。`)) return void deps.rerenderPanel?.();
        // 档位会影响下面的工作目录、操作范围与记忆说明：保存成功后整页重绘，提示不会停留在旧档。
        if (await patchBot(bot, { permission: value, confirmPermission: value === "full" })) deps.rerenderPanel?.();
      })));
    permissionCard.append(row("工作目录", "本机工具从这里开始找资料和保存成果，仍可访问其他有权限的位置。", Object.assign(el("input", "bt-input"), {
      value: bot.workspace || "",
      placeholder: "如 C:/work/project",
      onchange: (event) => { void patchBot(bot, { workspace: event.target.value.trim() || null }); },
    })));
    const chatOnly = permissionOf(bot) === "chat";
    permissionCard.append(row("操作范围", computer
      ? computer.note || "本机和共享电脑两套工具都在。"
      : "执行任务时，助手可以访问当前账户有权限访问的文件和程序；工作目录不限制访问范围。",
      el("span", "bt-note", chatOnly ? (computer ? "只聊天（电脑只提供桌面）" : "只聊天") : computer ? "本机 + 共享电脑" : "本机账户权限")));
    root.append(section("权限与确认", permissionCard));

    const memoryToggle = checkbox(bot.memoryEnabled === true, (checked) => void patchBot(bot, { memoryEnabled: checked }));
    const memoryCard = el("div", "bt-set-card");
    memoryCard.append(row("记忆开关",
      "开启后这个助手有自己的记忆库，私聊群聊通用，从下次任务生效。第一次开会下载约 2.7GB 的中文嵌入模型和运行库。",
      memoryToggle));
    root.append(section("记忆", memoryCard));

    const loginCard = el("div", "bt-set-card");
    loginCard.append(row("登录", "助手提示需要登录时，点这里按原生流程完成。凭据只在原生窗口里输入，不会进入聊天记录。", button("btn ghost", "开始登录", function () {
      return busy(this, api(`/api/bots/${encodeURIComponent(bot.id)}/native/command`, { method: "POST", body: { command: "login" } })
        .then(() => { announce("已请求原生登录，请在需要你确认的事项中完成"); toast("已请求原生登录，请在“需要你确认”里完成"); })
        .catch((error) => toast(`登录请求失败：${error.message}`, true)), "请求中…");
    })));
    root.append(section("登录", loginCard));

    // 高级设置默认收起：用量上限、模型目录、原生诊断与浏览器状态都是排查用的，日常不用打开。
    const advanced = el("details", "ui-disclosure");
    advanced.append(el("summary", null, "高级设置"));
    const advancedBody = el("div", "ui-disclosure-body");

    const budgetCard = el("div", "bt-set-card");
    budgetCard.append(row("预算 token", "这个助手累计可用的 token 上限；留空表示不设上限。费用、时长和并发限制不受影响。", Object.assign(el("input", "bt-input"), {
      value: bot.budget?.maxTokens ?? "",
      inputmode: "numeric",
      onchange: (event) => {
        const raw = event.target.value.trim();
        const tokens = raw === "" ? null : Number(raw);
        if (raw !== "" && (!Number.isFinite(tokens) || tokens < 0)) { toast("预算必须是非负数字", true); return; }
        const budget = { ...(bot.budget || {}) };
        if (tokens == null) delete budget.maxTokens;
        else budget.maxTokens = tokens;
        void patchBot(bot, { budget: Object.keys(budget).length ? budget : null });
      },
    })));
    advancedBody.append(section("用量上限", budgetCard));

    if (!capabilities) advancedBody.append(section("原生能力", pendingNote("原生能力", `/api/bots/${bot.id}/native/capabilities`)));
    else {
      const facts = el("div", "bt-set-card");
      const native = capabilities.native;
      if (native) {
        facts.append(kv("模型", modelText(native.model) || "未知"), kv("思考档", native.thinkingLevel), kv("会话", native.sessionId));
        facts.append(kv("已落定", String(native.isSettled)), kv("流式中", String(native.isStreaming)), kv("消息数", native.messageCount));
        if (native.contextUsage != null) facts.append(kv("上下文用量", typeof native.contextUsage === "object" ? JSON.stringify(native.contextUsage) : native.contextUsage));
      } else facts.append(kv("原生状态", capabilities.nativeError || "未知"));
      facts.append(kv("工具", capabilities.tools === "unknown" ? "未知" : `${capabilities.tools?.count ?? 0} 个`));
      facts.append(kv("命令", capabilities.commands ? `${capabilities.commands.length} 个` : (capabilities.commandsError || "未知")));
      facts.append(kv("MCP", capabilities.mcp?.servers?.length ? `${capabilities.mcp.servers.length} 个服务` : "未配置"));
      // 私有技能列表为空不代表没有技能：原生自己的 skill 命令是另一个来源，两者分开计数。
      const skillCommands = Array.isArray(capabilities.skills?.commands) ? capabilities.skills.commands : null;
      const privateSkills = Array.isArray(capabilities.skills?.effective) ? capabilities.skills.effective : [];
      let skillText;
      if (skillCommands === null) skillText = capabilities.commandsError ? `未取到（${capabilities.commandsError}）` : "未取到原生技能列表";
      else skillText = `原生提供 ${skillCommands.length} 个${privateSkills.length ? ` · 私有生效 ${privateSkills.length} 个` : ""}`;
      facts.append(kv("技能", skillText));
      facts.append(kv("记忆", capabilities.memory?.available ? "可用" : `不可用（${(capabilities.memory?.reasons || []).join("；") || "未知"}）`));
      facts.append(kv("认证", capabilities.auth?.loginProviders || "未知"));
      const details = el("details", "wb-raw");
      details.append(el("summary", null, "完整能力 JSON（探测结果）"));
      if (Array.isArray(capabilities.tools?.names)) details.append(kv("工具名", capabilities.tools.names.join(", ")));
      if (native && native.sessionFile) details.append(kv("会话文件", native.sessionFile));
      details.append(el("pre", "wb-pre", JSON.stringify(capabilities, null, 2)));
      facts.append(details);
      advancedBody.append(section("原生能力", facts));
    }

    advancedBody.append(modelSection(bot));
    advancedBody.append(browserSection(capabilities?.browser));
    advanced.append(advancedBody);
    root.append(advanced);
    return root;
  }

  /** 电脑面板持有轮询定时器与桌面画面对象 URL，由抽屉生命周期负责释放。 */
  function computerPanel(bot) {
    return createComputerView(bot, {
      ui: { section, row, kv, busy },
      openModal: deps.openModal,
      closeModal: deps.closeModal,
    });
  }

  function browserSection(status) {
    const box = el("div", "bt-set-card");
    if (!status) {
      box.append(row("浏览器", "未取得原生状态。", el("span", "bt-note", "未知")));
      return section("浏览器", box);
    }
    const capability = status.capability || null;
    const stateLabel = capability ? ({ available: "可用", unavailable: "不可用", unknown: "未知" }[capability.state] || "未知") : "未知";
    box.append(kv("原生能力", `${stateLabel}${capability?.evidence ? ` · 依据 ${capability.evidence}` : ""}`));
    if (capability?.reason) box.append(el("div", "bt-note", capability.reason));
    if (capability && capability.state !== "available") {
      box.append(el("div", "bt-note", "能力未知或不可用时不会接管——接口只暂停 Bot 回合，不会替你开浏览器，也不会伪装成功。"));
    }
    box.append(kv("运行中", String(!!status.runtimeRunning)));
    box.append(kv("人工接管中", status.paused ? `是${status.takeover?.startedAt ? ` · ${fmtTime(status.takeover.startedAt)}` : ""}` : "否"));
    box.append(kv("原生说明", status.native));
    box.append(kv("人工地址", status.humanUrl || "无（不提供公网地址）"));
    const settings = status.settings || {};
    const files = Object.keys(settings.files || {});
    box.append(kv("配置", settings.explicitEnabled == null
      ? `browser.enabled 未显式配置（原生默认 true）${files.length ? ` · 读到 ${files.join("、")}` : ""}`
      : `browser.enabled = ${String(settings.explicitEnabled)}（${settings.source}）`));
    for (const line of status.howItWorks || []) box.append(el("div", "bt-note", line));
    const bot = currentBot;
    const actions = el("div", "bt-actions");
    if (bot) {
      const takeover = button("btn ghost", "接管", function () {
        if (!confirm("接管只暂停该 Bot 的新回合；请先在 Bot 会话里跑一个回合执行 eval browser.open({headed:true,persist:true,url}) 打开可见窗口（headed 才看得见，persist 才不被原生冻结），再确认接管。继续？")) return;
        return busy(this, browserAction(bot, "takeover"), "接管中…");
      });
      if (capability && capability.state !== "available") takeover.disabled = true;
      actions.append(takeover);
      actions.append(button("btn ghost", "释放", function () {
        return busy(this, browserAction(bot, "release"), "释放中…");
      }));
    }
    box.append(row(
      "人工接管",
      "接管期间 Bot 不再受理新回合；释放要求原生 isSettled 且无排队工作，否则保留暂停并回报原因。可见窗口必须先由原生 eval 打开，本接口不新增浏览器引擎。",
      actions,
    ));
    return section("浏览器", box);
  }

  function modelSection(bot) {
    const box = el("div", "bt-set-card");
    const list = models.list;
    const current = bot.model || "";
    const selectNode = select([["", "（默认模型）"], ...list.map((item) => [item.selector || `${item.provider}/${item.id}`, `${item.provider || "?"} · ${item.name || item.id}`])], current, (value) => void patchBot(bot, { model: value }));
    if (current && !list.some((item) => (item.selector || `${item.provider}/${item.id}`) === current)) {
      const opt = el("option", null, `${current}（当前，未在目录中）`);
      opt.value = current;
      selectNode.append(opt);
      selectNode.value = current;
    }
    box.append(row("模型", "只列出 omp 已认证的 provider/model。", selectNode));
    const search = el("input", "bt-input");
    search.type = "search";
    search.placeholder = "搜索模型";
    search.setAttribute("aria-label", "搜索模型");
    const results = el("div", "wb-model-results");
    search.oninput = () => {
      const query = search.value.trim().toLocaleLowerCase();
      results.replaceChildren();
      if (!query) return;
      for (const item of list.filter((entry) => `${entry.provider} ${entry.name} ${entry.id} ${entry.selector}`.toLocaleLowerCase().includes(query)).slice(0, 40)) {
        const line = el("div", "bt-option");
        line.append(el("span", "bt-option-label", `${item.provider || "?"} · ${item.name || item.id}`));
        line.append(button("bt-soft-sm", "使用", () => void patchBot(bot, { model: item.selector || `${item.provider}/${item.id}` })));
        results.append(line);
      }
      if (!results.children.length) results.append(el("div", "bt-empty", "没有匹配的模型"));
    };
    const refresh = button("btn ghost", "刷新目录", function () {
      return busy(this, loadModels(true).then(() => toast(`模型目录已刷新（${models.list.length} 个）`)), "刷新中…");
    });
    box.append(row("查找模型", "认证变化后刷新目录，显示精确 provider/model。", search));
    box.append(results);
    box.append(row("目录", models.list.length ? `已加载 ${models.list.length} 个模型 · ${fmtTime(models.at)}` : "未加载", refresh));
    return section("模型", box);
  }

  async function patchBot(bot, patch) {
    try {
      const { bot: updated } = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: patch });
      deps.onBotUpdated?.(updated);
      toast("已保存");
      announce("设置已保存");
      return true;
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
      // 保存没成功就不能让控件停留在新选择上：按服务端真实值重绘一遍。
      deps.rerenderPanel?.();
      return false;
    }
  }

  async function browserAction(bot, action) {
    const verb = action === "takeover" ? "接管" : "释放";
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/browser/${action}`, { method: "POST", body: {} });
      toast(action === "takeover" ? "已接管：该 Bot 新回合已暂停" : "已释放：原生 settled 已复查通过");
      deps.rerenderPanel?.();
    } catch (error) {
      const code = error.data?.code ? `（${error.data.code}）` : "";
      toast(`浏览器${verb}未生效${code}：${error.message}`, true);
    }
  }

  async function pairingSection() {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional("/api/pairing");
    if (!data) return { node: section("配对与设备", pendingNote("配对与设备", "/api/pairing")) };
    // 与电脑面板同一套视图约定：{node, dispose} 由抽屉生命周期在关闭/替换时立即释放。
    const mobile = await mobileSection();
    root.append(mobile.node);
    const box = el("div", "bt-set-card");
    const tickets = data.tickets || [];
    const devices = data.devices || [];
    const permText = (list) => (Array.isArray(list) ? list : []).map((name) => PERMISSION_LABELS[name] || name).join("、") || "无权限";
    if (!tickets.length && !devices.length) box.append(el("div", "bt-empty", "还没有配对码或设备。"));
    for (const ticket of tickets) {
      const line = el("div", "bt-set-row");
      const copy = el("div", "bt-set-copy");
      const expiry = ticket.expiresAt ? `到期 ${fmtClock(ticket.expiresAt)}` : "";
      // 服务端只在签发新码时回收过期票：列表里的过期票如实标「已过期」，不显示成还能兑换。
      const status = ticket.revokedAt ? "已撤销" : ticket.usedAt ? "已兑换" : (ticket.expiresAt && ms(ticket.expiresAt) <= Date.now()) ? "已过期" : "待兑换";
      copy.append(el("div", null, `配对码 ${ticket.label || ticket.id}`));
      copy.append(el("div", "bt-set-hint", `${status} · ${permText(ticket.permissions)} · ${expiry}`));
      line.append(copy);
      const control = el("div", "bt-set-control");
      control.append(el("span", "bt-note", ticket.revokedAt ? "已撤销" : status));
      if (!ticket.revokedAt) {
        control.append(button("btn ghost danger", "撤销", function () {
          if (!confirm(`撤销配对码「${ticket.label || ticket.id}」？撤销后不能再用它兑换设备。`)) return;
          return busy(this, api(`/api/pairing/${encodeURIComponent(ticket.id)}`, { method: "DELETE" }).then(() => { toast("已撤销"); deps.rerenderPanel?.(); }), "撤销中…");
        }));
      }
      line.append(control);
      box.append(line);
    }
    for (const device of devices) {
      const line = el("div", "bt-set-row");
      const copy = el("div", "bt-set-copy");
      copy.append(el("div", null, device.label || device.id));
      copy.append(el("div", "bt-set-hint", `${device.revokedAt ? "已撤销" : "已配对"} · ${permText(device.permissions)}${device.lastUsedAt ? ` · 最近 ${fmtClock(device.lastUsedAt)}` : ""}`));
      line.append(copy);
      const control = el("div", "bt-set-control");
      control.append(el("span", "bt-note", device.revokedAt ? "已撤销" : ""));
      if (!device.revokedAt) {
        control.append(button("btn ghost danger", "撤销设备", function () {
          if (!confirm(`撤销设备「${device.label || device.id}」？撤销后它保存的旧地址不能再访问。`)) return;
          return busy(this, api(`/api/pairing/${encodeURIComponent(device.id)}`, { method: "DELETE" }).then(() => { toast("已撤销"); deps.rerenderPanel?.(); }), "撤销中…");
        }));
      }
      line.append(control);
      box.append(line);
    }
    root.append(section("现有配对", box));
    root.append(el("div", "bt-note", "手机只能使用配对时授予的读取、运行与审批权限。配对码与二维码都是一次性、短时效，兑换或到期即失效。"));
    return { node: root, dispose: mobile.dispose };
  }

  /** 配对面板共用的授权范围控件：可操作的 Bot、权限、备注与有效期。 */
  function scopeControls() {
    const bots = deps.bots();
    const chosen = new Set(bots.map((bot) => bot.id));
    const botsBox = el("div", "bt-set-card");
    for (const bot of bots) {
      const label = el("label", "wb-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = true;
      input.onchange = () => { input.checked ? chosen.add(bot.id) : chosen.delete(bot.id); };
      label.append(input, document.createTextNode(bot.name));
      botsBox.append(label);
    }
    if (!bots.length) botsBox.append(el("div", "bt-empty", "还没有 Bot，先创建一个。"));
    const perms = new Set(["read", "run"]);
    const permBox = el("div", "bt-set-card");
    for (const [value, text, hint] of [
      ["read", "读取", "查看会话与成果"],
      ["run", "运行", "发起新的任务"],
      ["approve", "审批", "可代替人工批准原生审批请求"],
    ]) {
      const label = el("label", "wb-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = perms.has(value);
      input.onchange = () => { input.checked ? perms.add(value) : perms.delete(value); };
      label.append(input, el("span", null, `${text} · ${hint}`));
      permBox.append(label);
    }
    const labelInput = Object.assign(el("input", "bt-input"), { placeholder: "备注，如 我的手机" });
    const ttl = select(TTL_OPTIONS, "300000");
    return { chosen, botsBox, perms, permBox, labelInput, ttl };
  }


  /**
   * 一次性配对码卡片：倒计时、复制控件，可带二维码和手动填入的地址。
   * 二维码只接受服务端返回的 data:image，过期就撤掉图片并禁用复制，不留下还能用的错觉。
   */
  function pairingCodeCard(code, ticket, options = {}) {
    const { address, lead, qrDataUrl, title = "配对码（只显示这一次）", onCountdown } = options;
    const card = el("div", "wb-code");
    card.append(el("div", "wb-pending-title", title));
    if (lead) card.append(el("div", "bt-note", lead));
    let qrFrame = null;
    if (qrDataUrl !== undefined) {
      if (typeof qrDataUrl === "string" && qrDataUrl.startsWith("data:image/")) {
        const image = el("img", "wb-qr");
        image.src = qrDataUrl;
        image.alt = "手机配对二维码";
        qrFrame = el("div", "wb-qr-frame");
        qrFrame.append(image);
        card.append(qrFrame);
      } else {
        card.append(el("div", "bt-note", "服务端没有返回可用的二维码图片，请用下面的地址和配对码手动配对。"));
      }
    }
    const manual = typeof address === "string" && address;
    if (manual) card.append(el("div", "bt-note", "扫码不方便时，在手机上点「手动输入」，填下面的地址和配对码。"));
    const copies = [];
    const line = el("div", "wb-code-row");
    const text = el("code", "wb-code-text", code);
    copies.push(button("btn ghost", "复制", async () => {
      try { await navigator.clipboard.writeText(code); toast("已复制配对码"); }
      catch (error) { toast(`复制失败：${error.message}`, true); }
    }));
    line.append(text, copies.at(-1));
    card.append(line);
    if (manual) {
      const addressLine = el("div", "wb-code-row");
      const addressText = el("code", "wb-code-text wb-code-address", address);
      copies.push(button("btn ghost", "复制地址", async () => {
        try { await navigator.clipboard.writeText(address); toast("已复制地址"); }
        catch (error) { toast(`复制失败：${error.message}`, true); }
      }));
      addressLine.append(addressText, copies.at(-1));
      card.append(addressLine);
    }
    const note = el("div", "bt-note", "一次性、短时效：兑换或到期即失效。");
    if (ticket?.expiresAt) {
      const countdown = el("span", "wb-code-countdown");
      let timer = null;
      // 停表函数交给调用方：抽屉关闭/卡片替换时立即释放，不等下一次 tick 自己发现被隐藏。
      const stopCountdown = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
      onCountdown?.(stopCountdown);
      const tick = () => {
        // 兜底：卡片被替换或抽屉已关闭（display:none，节点仍在文档里）时自停，避免对隐藏卡片重绘。
        if (!card.isConnected || !card.getClientRects().length) { stopCountdown(); return; }
        // 后台标签不重绘、不播报；回到前台的下一次 tick 立即校正。
        if (document.hidden) return;
        const left = Math.max(0, Math.round((ticket.expiresAt - Date.now()) / 1000));
        countdown.textContent = left > 0 ? `剩余 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "已过期，请重新生成";
        if (left <= 0) {
          card.dataset.expired = "1";
          if (qrFrame) qrFrame.replaceWith(el("div", "wb-qr-expired", "二维码已过期，请重新生成"));
          for (const control of copies) control.disabled = true;
          announce("配对码已过期");
          stopCountdown();
        }
      };
      timer = setInterval(tick, 1000);
      queueMicrotask(tick);
      note.append(" ", countdown);
    }
    card.append(note);
    return card;
  }

  /* ----------------------------- phone entry ----------------------------- */

  /**
   * 手机接入（安卓）：开启/关闭入口、提供安装包、生成一次性配对二维码。
   * 状态与开关结果只认 /api/mobile 的真实返回，不做乐观显示；没有地址就不发邀请。
   */
  async function mobileSection() {
    const loaded = await apiOptional("/api/mobile");
    // 本段里创建过、还没被释放的配对码倒计时；抽屉关闭时由 dispose 立即全部停掉。
    const countdownStops = new Set();
    const stopCountdowns = () => { for (const stop of countdownStops) stop(); countdownStops.clear(); };
    if (!loaded) return { node: section("手机接入（安卓）", pendingNote("手机接入", "/api/mobile")), dispose: stopCountdowns };
    let status = loaded;
    let selectedAddress = "";

    const statusArea = el("div", "wb-mobile-area");
    const installArea = el("div", "wb-mobile-area");
    const formArea = el("div", "wb-mobile-area");
    const inviteArea = el("div", "wb-mobile-area wb-mobile-invite");

    const addresses = () => (Array.isArray(status.addresses) ? status.addresses : [])
      .filter((entry) => entry && typeof entry.url === "string" && entry.url.trim());

    async function readStatus() {
      return apiOptional("/api/mobile").catch(() => null);
    }

    async function setEnabled(next, control) {
      const previous = status;
      try {
        const result = await busy(control, api("/api/mobile", { method: "POST", body: { enabled: next } }), next ? "处理中…" : "关闭中…");
        // 返回不完整时重新读一次真实状态，避免把没落地的事显示成已生效。
        status = result && typeof result === "object" && "running" in result ? result : (await readStatus()) || previous;
      } catch (error) {
        status = (await readStatus()) || previous;
        toast(`手机接入${next ? "开启" : "关闭"}失败：${errorText(error)}`, true);
        paint();
        return;
      }
      const ok = next ? status.running === true : status.enabled !== true;
      const message = next
        ? (ok ? "手机接入已开启" : "手机接入已保存，但没有运行起来")
        : (ok ? "手机接入已关闭" : "手机接入没有关掉，请再试一次");
      toast(message, !ok);
      announce(message);
      paint();
    }

    async function refreshStatus(control) {
      let fresh = null;
      try {
        fresh = await busy(control, apiOptional("/api/mobile"), "刷新中…");
      } catch (error) {
        toast(`刷新失败：${errorText(error)}`, true);
      }
      if (fresh) status = fresh;
      paint();
    }

    function paintStatus() {
      const enabled = status.enabled === true;
      const running = status.running === true;
      const found = addresses();
      statusArea.replaceChildren();
      const actions = el("div", "wb-mobile-actions");
      const action = (label, cls, next) => {
        const node = button(cls, label, () => void setEnabled(next, node));
        return node;
      };
      if (!enabled) actions.append(action("开启手机接入", "btn primary", true));
      else {
        if (!running) actions.append(action("重新启动", "btn primary", true));
        actions.append(action("关闭手机接入", "btn ghost", false));
      }
      const refresh = button("btn ghost", "刷新", () => void refreshStatus(refresh));
      actions.append(refresh);
      statusArea.append(row(
        "手机入口",
        "开启后电脑会在本地网络上开一个入口，只接受已配对的手机：看授权 Bot 的会话、派活、处理审批、取回成果，改不了电脑上的设置。不用时随时关掉。",
        actions,
      ));
      statusArea.append(kv("状态", enabled ? (running ? "已开启，运行中" : "已开启，但没有运行") : "已关闭"));
      statusArea.append(kv("端口", running ? String(status.port ?? "—") : "未运行"));
      statusArea.append(kv("可用地址", found.length ? `${found.length} 个` : running ? "没有找到" : "—"));
      if (status.lastError) {
        const warn = el("div", "wb-warn");
        warn.setAttribute("role", "alert");
        warn.append(
          el("div", "wb-pending-title", enabled && !running ? "手机入口启动失败" : "最近一次错误"),
          el("div", "bt-note", errorText(status.lastError)),
        );
        statusArea.append(warn);
      }
      if (running && !found.length) {
        statusArea.append(el("div", "bt-note", "入口在运行，但电脑没有找出可用的地址：确认电脑已连上 Wi-Fi 或网线（或已登录 Tailscale），然后点「刷新」。"));
      }
    }

    /** 只给真实存在的安装包做下载入口；同源地址按当前登录态取字节，绝对地址直接用链接下载。 */
    function apkControl(apk) {
      const url = typeof apk.url === "string" && apk.url.trim() ? apk.url.trim() : "/api/mobile/apk";
      if (!url.startsWith("/")) {
        const link = el("a", "btn primary", "下载安装包");
        link.href = url;
        link.setAttribute("download", "");
        link.rel = "noopener noreferrer";
        return link;
      }
      return button("btn primary", "下载安装包", function () {
        return busy(this, fetch(url, { credentials: "same-origin" }).then(async (response) => {
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          saveBlob("omp-bot-android.apk", await response.blob());
          toast("安装包已开始下载");
        }).catch((error) => {
          toast(`下载安装包失败：${error.message}`, true);
        }), "下载中…");
      });
    }

    function paintInstall() {
      const apk = status.apk && typeof status.apk === "object" ? status.apk : {};
      installArea.replaceChildren();
      const steps = el("ol", "wb-steps");
      for (const text of [
        "在电脑上下载安装包，传到手机上安装；系统会问一次是否允许安装来自这个来源的应用。",
        "手机和电脑要能互相访问：同一个 Wi-Fi 或局域网，或者两台设备都登录同一个 Tailscale 网络。",
        "打开手机上的 OMP Bot，扫码或手动填入地址和配对码，即可连上这台电脑。",
      ]) steps.append(el("li", null, text));
      installArea.append(steps);
      if (apk.available !== true) {
        installArea.append(row("安卓安装包", "电脑上还没有可下载的安装包。", el("span", "bt-note", "暂不可下载")));
        return;
      }
      const version = typeof apk.version === "string" && apk.version ? `当前版本 ${apk.version}。` : "";
      installArea.append(row("安卓安装包", `${version}下载后传到手机安装即可。`, apkControl(apk)));
    }

    function paintForm() {
      formArea.replaceChildren();
      if (status.running !== true) {
        formArea.append(el("div", "bt-note", status.enabled === true
          ? "手机入口已开启，但没有运行；先在上面点「重新启动」，再生成配对二维码。"
          : "先开启上面的手机入口，然后生成配对二维码。"));
        return;
      }
      const found = addresses();
      const preferred = found.find((entry) => entry.kind !== "loopback") || found[0];
      const current = found.some((entry) => entry.url === selectedAddress) ? selectedAddress : preferred?.url || "";
      selectedAddress = current;
      const scope = scopeControls();
      const addressSelect = select(
        found.map((entry) => [entry.url, `${entry.label || entry.kind || "地址"} · ${entry.url}`]),
        current,
        (value) => { selectedAddress = value; },
      );
      addressSelect.setAttribute("aria-label", "手机连接地址");
      const form = el("div", "wb-form");
      form.append(row(
        "手机连到",
        "手机要能访问这个地址：同一个 Wi-Fi 或局域网，或者两台设备都登录同一个 Tailscale 网络。",
        found.length ? addressSelect : el("div", "bt-note", "没有可用的地址：确认电脑已联网，然后点上面的「刷新」。"),
      ));
      form.append(row("授权 Bot", "手机只能对你勾选的 Bot 读取和派活。", scope.botsBox));
      form.append(row("权限", "读取和运行默认开启；审批让手机能代替你批准原生审批请求，需要单独勾选。", scope.permBox));
      form.append(row("备注", "给这台手机起个名字，以后在设备列表里好认。", scope.labelInput));
      form.append(row("有效期", "过期后二维码与配对码都失效，需要重新生成。", scope.ttl));
      form.append(button("btn primary wide", "生成配对二维码", function () {
        if (!found.length) { toast("还没有可用地址", true); return; }
        if (!scope.chosen.size) { toast("至少选择一个 Bot", true); return; }
        const address = addressSelect.value || current;
        return busy(this, api("/api/mobile/invitation", {
          method: "POST",
          body: {
            botIds: [...scope.chosen],
            permissions: [...scope.perms],
            label: scope.labelInput.value.trim() || undefined,
            ttlMs: Number(scope.ttl.value),
            address,
          },
        }).then((invitation) => {
          stopCountdowns(); // 上一张码随卡片替换立即停表
          inviteArea.replaceChildren(mobileInviteCard(invitation, address, (stop) => countdownStops.add(stop)));
          announce("已生成手机配对二维码");
        }).catch((error) => {
          stopCountdowns();
          inviteArea.replaceChildren(el("div", "wb-error", `生成失败：${errorText(error)}`));
          toast(`生成配对二维码失败：${errorText(error)}`, true);
        }), "生成中…");
      }));
      formArea.append(form);
    }

    function mobileInviteCard(invitation, address, onCountdown) {
      const data = invitation && typeof invitation === "object" ? invitation : {};
      if (!data.code) {
        const warn = el("div", "wb-warn");
        warn.setAttribute("role", "alert");
        warn.append(el("div", "wb-pending-title", "没有拿到配对码"), el("div", "bt-note", "服务端没有返回配对码，请重新生成。"));
        return warn;
      }
      return pairingCodeCard(data.code, data.ticket, {
        title: "手机配对二维码（只显示这一次）",
        lead: "手机在同一个网络里打开 OMP Bot，点「扫码配对」对准下面的二维码。",
        qrDataUrl: typeof data.qrDataUrl === "string" ? data.qrDataUrl : "",
        address,
        onCountdown,
      });
    }

    function paint() {
      paintStatus();
      paintInstall();
      paintForm();
    }

    paint();
    return { node: section("手机接入（安卓）", statusArea, installArea, formArea, inviteArea), dispose: stopCountdowns };
  }

  const FEISHU_TRANSPORTS = [
    ["websocket", "官方长连接（不需要公网域名）"],
    ["http", "本地回调 HTTP（需要 HTTPS 入口）"],
  ];

  /** 存储的 transport（后端口径：没存过是 null）优先；缺省时按 HTTP 证据判断：旧配置保留 HTTP，全新配置默认长连接。 */
  function feishuTransport(data) {
    const config = data.configuration || {};
    if (config.transport) return config.transport === "http" ? "http" : "websocket";
    const inbound = data.inbound || {};
    const httpConfigured = Number(config.port) > 0 || inbound.verificationTokenConfigured || inbound.encryptKeyConfigured
      || config.verificationTokenEnv || config.encryptKeyEnv;
    return httpConfigured ? "http" : "websocket";
  }

  function socketStateLabel(receiver) {
    const label = { idle: "未启动", connecting: "连接中", connected: "已连接", reconnecting: "重连中", failed: "连接失败" }[receiver.state]
      || (receiver.running ? "已连接" : "未连接");
    if (receiver.running) return `${label}（官方长连接运行中）`;
    return receiver.reconnectAttempts ? `${label} · 已重连 ${receiver.reconnectAttempts} 次` : label;
  }

  async function feishuSection() {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional("/api/channels/feishu");
    if (!data) { root.append(pendingNote("飞书渠道", "/api/channels/feishu")); return root; }
    const receiver = data.receiver || {};
    const inbound = data.inbound || {};
    const outbound = data.outbound || {};
    const config = data.configuration || {};
    const socket = (receiver.transport || feishuTransport(data)) === "websocket";
    const connected = !!receiver.running;

    const facts = el("div", "bt-set-card");
    facts.append(kv("启用", data.enabled ? "已启用" : "未启用"));
    facts.append(kv("接入方式", socket ? "官方长连接（websocket）" : "本地回调 HTTP"));
    facts.append(kv("连接状态", socket
      ? socketStateLabel(receiver)
      : connected ? `运行中 · ${receiver.path || ""}（:${receiver.port || "?"}）` : "未运行"));
    if (!socket) {
      facts.append(kv("仅回环", receiver.loopbackOnly ? "是（不提供公网入口）" : "否"));
      facts.append(kv("事件校验", inbound.signatureMode ? `${inbound.signatureMode}${inbound.signatureRequired ? "（需要签名）" : ""}` : inbound.signatureRequired ? "需要签名" : "按配置"));
      facts.append(kv("验证 token", inbound.verificationTokenConfigured ? "已配置" : "未配置"));
      facts.append(kv("加密密钥", inbound.encryptKeyConfigured ? "已配置" : "未配置"));
    }
    facts.append(kv("身份映射", inbound.identities ? `${Array.isArray(inbound.identities) ? inbound.identities.length : inbound.identities} 项` : "未配置"));
    facts.append(kv("出站", outbound.configured ? `已配置 · ${outbound.appId || ""}` : "未配置"));
    facts.append(kv("凭据来源", outbound.secretSource));
    facts.append(kv("API", outbound.apiBase));
    if (data.lastError) facts.append(kv("最近错误", data.lastError.code || JSON.stringify(data.lastError)));
    if (data.startError) facts.append(kv("接收器启动失败", data.startError.message || data.startError.code));
    root.append(section("飞书状态", facts));

    for (const [title, text] of [["签名校验警告", inbound.signatureWarning], ["身份白名单警告", inbound.identityWarning]]) {
      if (!text) continue;
      const warn = el("div", "wb-warn");
      warn.setAttribute("role", "alert");
      warn.append(el("div", "wb-pending-title", title), el("div", "bt-note", String(text)));
      root.append(warn);
    }

    const stats = inbound.events;
    if (stats) {
      const box = el("div", "bt-set-card");
      box.append(kv("事件总数", stats.total), kv("已确认（未跑完）", stats.accepted), kv("已完成", stats.completed), kv("失败", stats.failed), kv("已中断", stats.interrupted));
      if (Number(stats.interrupted) > 0) box.append(el("div", "bt-note wb-warn-text", "有中断事件：重启后未完成的事件不会自动重放，需要人工确认。"));
      root.append(section("入站事件统计", box));
    }
    if (Number(inbound.interruptedOnStartup) > 0) {
      const startupNotice = el("div", "bt-set-card");
      startupNotice.append(el("div", "bt-set-row", `本次启动把 ${inbound.interruptedOnStartup} 条未完成事件标记为 interrupted（不自动重放）。`));
      root.append(section("启动提示", startupNotice));
    }
    if (inbound.delivery) root.append(el("div", "bt-note", String(inbound.delivery)));

    const missing = [...(data.missing || []), ...(data.outboundMissing || [])];
    if (missing.length) {
      const list = el("div", "bt-set-card");
      for (const item of missing) list.append(el("div", "bt-set-row", String(item)));
      root.append(section("待办清单（缺少的配置）", list));
    }

    const form = el("div", "bt-set-card wb-feishu-form");
    const mode = select(FEISHU_TRANSPORTS, feishuTransport(data));
    mode.setAttribute("aria-label", "飞书接入方式");
    form.append(row("接入方式", "长连接由本机主动连出：不需要公网域名、回调 URL、Verification Token 或 Encrypt Key。开放平台仍需订阅事件，并让应用处于可用范围（已发布版本或测试可用名单），否则收不到事件。本地回调 HTTP 需要自备 HTTPS 入口把事件路径转发到本机端口。", mode));
    const fields = {};
    for (const [key, label, secret] of [
      ["appId", "App ID", false],
      ["appSecret", "App Secret", true],
      ["verificationToken", "Verification Token", true],
      ["encryptKey", "Encrypt Key", true],
    ]) {
      const input = el("input", "bt-input");
      input.type = secret ? "password" : "text";
      input.autocomplete = "off";
      input.setAttribute("aria-label", label);
      input.value = secret ? "" : config[key] || "";
      fields[key] = input;
      form.append(row(label, secret ? "留空保留已有值；凭据仅发送到本机服务并保存到本地配置。" : null, input));
    }
    const port = Object.assign(el("input", "bt-input"), { type: "number", min: "1", max: "65535", value: config.port || "" });
    port.setAttribute("aria-label", "回调端口");
    form.append(row("回调端口", "选择固定本机端口；只把飞书事件路径交给 HTTPS 反向代理。", port));
    const identities = Object.assign(el("textarea", "bt-textarea"), { rows: 6, value: JSON.stringify(config.identities || [], null, 2) });
    identities.setAttribute("aria-label", "飞书身份映射");
    form.append(row("身份映射", "每项填 openId、chatId、botIds 和 permissions。审批需显式加入 approve；仅授权指定身份，名单之外的用户发来的消息一律拒绝，未配置时可以先保存。", identities));
    const botIds = deps.bots().map(bot => `${bot.name} = ${bot.id}`).join("\n");
    if (botIds) form.append(el("pre", "wb-pre", botIds));
    const rowOf = (node) => node.closest(".bt-set-row");
    const sync = () => {
      const http = mode.value === "http";
      rowOf(port).hidden = !http;
      rowOf(fields.verificationToken).hidden = !http;
      rowOf(fields.encryptKey).hidden = !http;
    };
    mode.onchange = sync;
    sync();
    form.append(button("btn primary", "保存飞书配置", function () {
      let mapping;
      try { mapping = JSON.parse(identities.value); } catch { toast("身份映射必须是有效 JSON 数组", true); return; }
      if (!Array.isArray(mapping)) { toast("身份映射必须是数组", true); return; }
      const transport = mode.value === "http" ? "http" : "websocket";
      const body = { transport, appId: fields.appId.value.trim(), identities: mapping };
      if (transport === "http") {
        const callbackPort = Number(port.value);
        if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) { toast("回调端口需为 1 到 65535 的整数", true); return; }
        body.port = callbackPort;
      }
      for (const key of ["appSecret", "verificationToken", "encryptKey"]) if (fields[key].value) {
        body[key] = fields[key].value;
        body[`${key}Env`] = null;
      }
      return busy(this, api("/api/channels/feishu", { method: "PUT", body }).then(result => {
        for (const key of ["appSecret", "verificationToken", "encryptKey"]) fields[key].value = "";
        toast(result.startError ? `配置已保存；接收器未启动：${result.startError.message}` : "配置已保存；用启用按钮启动渠道");
        deps.rerenderPanel?.();
      }).catch(error => toast(`保存失败：${error.message}`, true)), "保存中…");
    }));
    root.append(section("飞书接入配置", form));

    const actions = el("div", "bt-set-card");
    actions.append(row("启用渠道", data.enabled
        ? "关闭会真的停止接收：HTTP 释放端口，长连接断开。"
        : socket ? "启用后由本机建立官方长连接；缺少 App ID/App Secret 时后端返回的错误会原样显示。" : "启用需要配置齐全；未配置时后端返回的错误会原样显示。",
      button(data.enabled ? "btn ghost danger" : "btn primary", data.enabled ? "停用" : "启用", function () {
        const enabled = !data.enabled;
        if (enabled) announce("正在请求启用飞书渠道");
        return busy(this, api("/api/channels/feishu", { method: "PUT", body: { enabled } })
          .then(result => { toast(result.startError ? `接收器未启动：${result.startError.message}` : enabled ? "已启用飞书渠道" : "已停用飞书渠道", !!result.startError); deps.rerenderPanel?.(); })
          .catch((error) => toast(error.message, true)), "处理中…");
      })));
    const live = checkbox(false, () => { });
    const checks = el("div", "bt-set-card");
    const checkActions = el("div", "bt-actions");
    checkActions.append(live, button("btn ghost", "运行自检", function () {
      return busy(this, api("/api/channels/feishu/test", { method: "POST", body: { live: live.checked } }).then((result) => {
        checks.replaceChildren();
        checks.append(kv("结果", result.ok ? "通过" : "未通过"));
        for (const check of result.checks || []) checks.append(kv(check.name, `${check.ok ? "✓" : "✗"} ${check.detail || ""}`));
      }).catch((error) => toast(`自检失败：${error.message}`, true)), "检测中…");
    }));
    actions.append(row("自检", "默认静态自检；勾选 live 才会请求鉴权端点（可能连不上真实飞书）。", checkActions));
    root.append(section("渠道操作", actions), checks);
    if (socket) {
      root.append(el("div", "bt-note", "官方长连接不需要公网域名、回调 URL 或反向代理，本服务也不建隧道；状态里的「已连接」取自真实长连接会话。"));
    } else {
      if (receiver.loopbackOnly && !receiver.remoteHint) root.append(el("div", "bt-note", "接收器仅监听回环地址，本页面不提供公网或隧道按钮。"));
      if (receiver.remoteHint) root.append(el("div", "bt-note", `远端接入：${receiver.remoteHint}`));
    }
    return root;
  }

  async function skillsPanel(bot) {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/skills`);
    if (!data) { root.append(pendingNote("技能", `/api/bots/${encodeURIComponent(bot.id)}/skills`)); return root; }
    // GET /skills 不带原生命令列表；用同一套能力接口拿真实工作目录与原生 skill 命令，不新增后端字段。
    // 探测失败只降级这一节，主内容仍然渲染，并把真实错误带出来。
    let caps = null;
    let probeError = null;
    try {
      caps = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/native/capabilities`);
    } catch (error) {
      probeError = error.message;
    }
    const nativeCommands = caps && caps.skills && Array.isArray(caps.skills.commands) ? caps.skills.commands : null;
    const commandsError = caps && typeof caps.commandsError === "string" && caps.commandsError ? caps.commandsError : null;
    const probeNote = commandsError || probeError;

    const library = Array.isArray(data.library) ? data.library : [];
    const own = Array.isArray(data.private) ? data.private : [];
    const libraryDir = data.libraryDir || null;
    const privateDir = data.privateDir || null;
    const saveFilter = async (next, revert) => {
      try {
        await api(`/api/bots/${encodeURIComponent(bot.id)}/skills`, { method: "PUT", body: { skills: next } });
        toast("已保存，下一条消息起生效");
        deps.rerenderPanel?.();
      } catch (error) {
        toast(`保存失败：${error.message}`, true);
        revert?.();
      }
    };

    // 共享库：所有 bot 共用 team/skills，每个 bot 勾自己要用的。
    const libBox = el("div", "bt-set-card");
    const useAll = data.filter === null || data.filter === undefined;
    const allLabel = el("label", "wb-check");
    const allInput = el("input");
    allInput.type = "checkbox";
    allInput.checked = useAll;
    allInput.onchange = () => {
      allInput.disabled = true;
      // 关掉「全部」时从当前全部库技能起步，用户再逐个取消。
      const next = allInput.checked ? null : library.map((s) => s.name);
      void saveFilter(next, () => { allInput.checked = !allInput.checked; }).finally(() => { allInput.disabled = false; });
    };
    allLabel.append(allInput, el("span", null, "用库里全部技能（以后装进库的也自动用上）"));
    libBox.append(allLabel);
    if (!library.length) libBox.append(el("div", "bt-empty", "共享库里还没有技能。在下面「装技能」里选「装进共享库」。"));
    const chosen = new Set(library.filter((s) => s.selected).map((s) => s.name));
    for (const skill of library) {
      const label = el("label", "wb-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = chosen.has(skill.name);
      input.disabled = useAll;
      input.onchange = () => {
        input.checked ? chosen.add(skill.name) : chosen.delete(skill.name);
        input.disabled = true;
        void saveFilter([...chosen], () => {
          input.checked = !input.checked;
          input.checked ? chosen.add(skill.name) : chosen.delete(skill.name);
        }).finally(() => { input.disabled = false; });
      };
      const text = el("span");
      text.append(document.createTextNode(`${skill.name}${skill.description ? ` · ${skill.description}` : ""}`));
      if (skill.loadable === false) text.append(el("span", "bt-note", " [没写 description，omp 不会加载]"));
      label.append(input, text);
      libBox.append(label);
    }
    if (libraryDir) libBox.append(el("div", "bt-note", `共享库在 ${libraryDir}，团队里每个 bot 都能勾选。`));
    root.append(section(`共享技能库（${library.length}）`, libBox));

    // 私有技能：只给这个 bot，总是加载。
    const ownBox = el("div", "bt-set-card");
    if (!own.length) ownBox.append(el("div", "bt-empty", "还没有只给这个 Bot 的技能。"));
    for (const skill of own) {
      const line = el("div", "bt-set-row");
      line.append(document.createTextNode(`${skill.name}${skill.description ? ` · ${skill.description}` : ""}`));
      if (skill.enabled === false) line.append(el("span", "bt-note", " [目录内已禁用]"));
      ownBox.append(line);
    }
    ownBox.append(el("div", "bt-note", privateDir ? `私有技能总是加载，放在 ${privateDir}。` : "私有技能总是加载。"));
    root.append(section(`只给这个 Bot 的技能（${own.length}）`, ownBox));

    // 装技能：从本机的技能目录装，或者直接贴 SKILL.md。
    const target = select([["library", "装进共享库"], ["bot", `只给 ${bot.name || "这个 Bot"}`]], "library");
    const path = Object.assign(el("input", "bt-input"), { placeholder: "本机技能目录，里面要有 SKILL.md" });
    const content = Object.assign(el("textarea", "bt-textarea"), {
      rows: 5,
      placeholder: "或者直接贴 SKILL.md 的内容。开头的 frontmatter 要写 name 和 description。",
    });
    const form = el("div", "wb-form");
    form.append(row("装到", "库里和每个 Bot 的私有技能不能重名。", target), row("目录", null, path), row("SKILL.md", null, content));
    form.append(button("btn primary wide", "装上", function () {
      const body = { target: target.value };
      if (content.value.trim()) body.content = content.value;
      else if (path.value.trim()) body.path = path.value.trim();
      else { toast("填技能目录，或者贴上 SKILL.md", true); return; }
      return busy(this, api(`/api/bots/${encodeURIComponent(bot.id)}/skills/install`, { method: "POST", body })
        .then((out) => {
          const where = out.installed?.target === "library" ? "共享库" : (bot.name || "这个 Bot");
          toast(`已把「${out.installed?.name}」装进${where}，下一条消息起生效`);
          deps.rerenderPanel?.();
        })
        .catch((error) => toast(`没装上：${error.message}`, true)), "安装中…");
    }));
    root.append(section("装技能", form));

    const nativeBox = el("div", "bt-set-card");
    if (nativeCommands === null) nativeBox.append(el("div", "bt-empty", probeNote
      ? `还没有探测到原生技能来源：${probeNote}。修好后刷新页面重试。`
      : "还没有探测到原生技能来源：刷新页面重试；Bot 未启动时先让它跑一次会话。"));
    else if (!nativeCommands.length) nativeBox.append(el("div", "bt-empty", "原生环境没有提供技能命令。"));
    else {
      nativeBox.append(el("div", "bt-note", "OMP 原生在这个 Bot 的进程里实际提供的技能。"));
      const list = el("details", "wb-raw");
      list.append(el("summary", null, "技能名称"));
      list.append(el("pre", "wb-pre", nativeCommands.join("\n")));
      nativeBox.append(list);
    }
    root.append(section(`原生提供的技能（${nativeCommands === null ? "未探测" : `${nativeCommands.length} 个`}）`, nativeBox));

    const detail = el("details", "wb-raw");
    detail.append(el("summary", null, "原生发现细节"));
    detail.append(kv("原生来源", data.nativeSource || "get_available_commands + Bot 私有 skill 目录"));
    detail.append(el("div", "bt-note", data.note || "真实装载仍由 OMP 原生流程完成。"));
    root.append(detail);
    return root;
  }

  async function mcpPanel(bot) {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/mcp`);
    if (!data) { root.append(pendingNote("MCP 配置", `/api/bots/${encodeURIComponent(bot.id)}/mcp`)); return root; }
    const status = el("div", "bt-set-card");
    status.append(kv("作用域", data.scope));
    status.append(kv("状态", data.error ? "配置无法解析" : data.exists ? "已有配置文件" : "还没有配置文件"));
    if (data.error) status.append(kv("解析错误", data.error));
    const fileDetails = el("details", "wb-raw");
    fileDetails.append(el("summary", null, "原生文件细节"));
    fileDetails.append(kv("文件", data.path), kv("存在", String(!!data.exists)), kv("回显密钥", String(!!data.secretsReturned)));
    if (data.enabledServers?.length || data.disabledServers?.length) {
      fileDetails.append(kv("enabledServers", (data.enabledServers || []).join(", ") || "—"));
      fileDetails.append(kv("disabledServers", (data.disabledServers || []).join(", ") || "—"));
    }
    if (data.note) fileDetails.append(el("div", "bt-note", data.note));
    status.append(fileDetails);
    root.append(section("原生 mcp.json", status));
    // 只聊天档会关掉项目级 MCP 来源，保存成功也不代表会生效。
    if (bot.executionMode === "chat") {
      root.append(el("div", "bt-note", "这台 Bot 是只聊天档，不加载项目级 MCP 配置：保存的服务要等切到先问我或全部放手后才生效。"));
    }

    const servers = el("div", "bt-set-card");
    if (!data.servers?.length) servers.append(el("div", "bt-empty", "还没有配置 MCP 服务。"));
    for (const server of data.servers) {
      const line = el("div", "bt-set-row");
      const copy = el("div", "bt-set-copy");
      copy.append(el("div", null, `${server.name} · ${server.type}`));
      copy.append(el("div", "bt-set-hint", [
        server.command || server.url,
        server.args ? `${server.args} 个参数` : null,
        server.enabled === false ? "已禁用" : "已启用",
        server.hasSecrets ? `密钥 ${server.secretKeys?.join(", ")}（不回显）` : null,
      ].filter(Boolean).join(" · ")));
      line.append(copy);
      servers.append(line);
    }
    root.append(section(`服务（${data.servers?.length || 0}）`, servers));

    const name = Object.assign(el("input", "bt-input"), { placeholder: "服务名，如 filesystem" });
    const type = select([["stdio", "stdio（本地命令）"], ["http", "http（远程 URL）"], ["sse", "sse（远程 URL）"]], "stdio");
    const command = Object.assign(el("input", "bt-input"), { placeholder: "命令，如 npx" });
    const args = Object.assign(el("input", "bt-input"), { placeholder: "参数，空格分隔（可留空）" });
    const url = Object.assign(el("input", "bt-input"), { placeholder: "https://…/mcp" });
    const secrets = Object.assign(el("textarea", "bt-textarea"), { rows: 3, placeholder: "KEY=VALUE，每行一个（stdio 写入 env，http/sse 写入 headers；密钥只落 Bot 私有目录）" });
    const rowOf = (node) => node.closest(".bt-set-row");
    const sync = () => {
      const stdio = type.value === "stdio";
      rowOf(command).hidden = !stdio;
      rowOf(args).hidden = !stdio;
      rowOf(url).hidden = stdio;
    };
    const form = el("div", "wb-form");
    form.append(row("类型", null, type), row("名称", null, name), row("命令", "stdio 必填", command), row("参数", null, args), row("URL", "http/sse 必填", url), row("环境/请求头", null, secrets));
    // 行建好后再同步可见性：隐藏行的查找依赖控件已经挂进对应的行。
    type.onchange = sync;
    sync();
    form.append(el("div", "bt-note", "保存会写入 Bot 私有 .omp/mcp.json（不改全局配置），只覆盖同名的服务；保存后该 Bot 的原生进程会重启以生效。"));
    form.append(button("btn primary wide", "保存服务", function () {
      const entry = type.value === "stdio" ? { type: "stdio", command: command.value.trim() } : { type: type.value, url: url.value.trim() };
      if (type.value === "stdio" && !command.value.trim()) { toast("stdio 需要命令", true); return; }
      if (type.value !== "stdio" && !url.value.trim()) { toast("http/sse 需要 URL", true); return; }
      if (!name.value.trim()) { toast("名称必填", true); return; }
      if (type.value === "stdio" && args.value.trim()) entry.args = args.value.trim().split(/\s+/);
      const pairs = secrets.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const index = line.indexOf("=");
        return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1)] : null;
      }).filter(Boolean);
      if (pairs.length) entry[type.value === "stdio" ? "env" : "headers"] = Object.fromEntries(pairs);
      return busy(this, api(`/api/bots/${encodeURIComponent(bot.id)}/mcp`, { method: "PUT", body: { mcpServers: { [name.value.trim()]: entry } } })
        .then((out) => { toast(out.restartRequired ? "已保存；请确认 runtime 已重启以生效" : "已保存并重启 runtime"); deps.rerenderPanel?.(); })
        .catch((error) => toast(`保存失败：${error.message}`, true)), "保存中…");
    }));
    root.append(section("添加 / 覆盖服务", form));
    return root;
  }

  const MEMORY_SOURCES = { "coding-agent-transcript": "对话存档", "coding-agent-retain": "它主动记下" };
  // mnemopi 存档的对话带 [role: user] / [user:end] 标记，显示时换成「用户：」「助手：」。
  function readableMemory(text) {
    return String(text || "")
      .replace(/^\[role: user\]\n?/gm, "用户：")
      .replace(/^\[role: assistant\]\n?/gm, "助手：")
      .replace(/^\[(user|assistant):end\]\n?/gm, "")
      .trim();
  }

  // mnemopi 存 UTC 的 ISO 时间，按本机时区显示。
  function memoryWhen(at) {
    if (!at) return "";
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return String(at);
    return d.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  async function memoryPanel(bot) {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/memory`);
    if (!data) { root.append(pendingNote("记忆", `/api/bots/${bot.id}/memory`)); return root; }
    const counts = data.counts || {};
    const facts = el("div", "bt-set-card");
    facts.append(kv("开关", data.enabled ? "已开启" : "未开启（在设置里打开，下次任务生效）"));
    facts.append(kv("条目", `${Number(counts.working || 0)} 条近期记忆 · ${Number(counts.episodic || 0)} 条整理后的记忆`));
    if (data.readError) facts.append(el("div", "bt-note", data.readError));
    if (data.note) facts.append(el("div", "bt-note", data.note));
    const details = el("details", "wb-raw");
    details.append(el("summary", null, "记忆库细节"));
    details.append(kv("后端", data.backend || "mnemopi"));
    details.append(kv("库名（bank）", data.bank || "未知"));
    details.append(kv("库文件", data.dbExists ? `${data.dbPath}（${fmtSize(data.dbBytes)}）` : `${data.dbPath || "未知"}（还没建）`));
    if (data.embedding) details.append(kv("嵌入模型", data.embedding.model || data.embedding.variant || "未知"));
    facts.append(details);
    root.append(section("状态", facts));

    const list = el("div", "bt-set-card");
    const memories = Array.isArray(data.memories) ? data.memories : [];
    if (!memories.length) list.append(el("div", "bt-note", data.enabled ? "还没记下东西。多聊几轮，它会自己存。" : "库里没有这个助手的记忆。"));
    for (const item of memories) {
      const rowEl = el("div", "bt-set-row wb-memory-item");
      rowEl.append(el("div", "bt-note", [memoryWhen(item.at), item.kind === "episodic" ? "整理后" : "近期", MEMORY_SOURCES[item.source]].filter(Boolean).join(" · ")));
      rowEl.append(el("div", "wb-memory-text", readableMemory(item.content)));
      list.append(rowEl);
    }
    root.append(section("最近的记忆", list));
    return root;
  }

  async function routinesPanel(botId) {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional("/api/routines");
    if (!data) { root.append(pendingNote("计划任务", "/api/routines")); return root; }
    const list = el("div", "bt-set-card");
    const routines = (data.routines || []).filter((routine) => !botId || botId === "all" || routine.botId === botId);
    if (!routines.length) list.append(el("div", "bt-empty", "还没有计划任务。"));
    for (const routine of routines) {
      const line = el("div", "bt-set-row");
      const copy = el("div", "bt-set-copy");
      copy.append(el("div", null, routine.name || routine.id));
      copy.append(el("div", "bt-set-hint", `${scheduleText(routine.schedule)}${routine.paused ? " · 已暂停" : ""}${routine.nextRunAt ? ` · 下次 ${fmtTime(routine.nextRunAt)}` : ""}${routine.missedPolicy === "record" && routine.missedCount ? ` · 错过 ${routine.missedCount} 次` : ""}${routine.lastStatus ? ` · 上次 ${routine.lastStatus}` : ""}`));
      if (routine.lastError) copy.append(el("div", "bt-set-hint", `错误：${routine.lastError}`));
      line.append(copy);
      const actions = el("div", "bt-set-control");
      actions.append(button("btn ghost", routine.paused ? "启用" : "暂停", function () {
        return busy(this, api(`/api/routines/${encodeURIComponent(routine.id)}`, { method: "PATCH", body: { paused: !routine.paused } })
          .then(() => { toast(routine.paused ? "已启用" : "已暂停"); deps.rerenderPanel?.(); })
          .catch((error) => toast(error.message, true)), "…");
      }));
      actions.append(button("btn ghost", "立即运行", function () {
        return busy(this, api(`/api/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST", body: {} })
          .then(out => toast(out.status === "skipped" ? `已跳过：${out.reason || "当前无法运行"}` : out.status === "error" ? `运行失败：${out.error || out.reason || "未知错误"}` : "已发起运行", out.status === "error"))
          .catch((error) => toast(error.message, true)), "发起中…");
      }));
      actions.append(button("btn ghost danger", "删除", function () {
        if (!confirm(`删除计划任务「${routine.name || routine.id}」？`)) return;
        return busy(this, api(`/api/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" })
          .then(() => { toast("已删除"); deps.rerenderPanel?.(); }), "删除中…");
      }));
      line.append(actions);
      list.append(line);
    }
    root.append(section("计划任务", list));

    const bots = deps.bots();
    const target = select(bots.map((item) => [item.id, item.name]), botId && botId !== "all" ? botId : (bots[0]?.id || ""));
    const name = Object.assign(el("input", "bt-input"), { placeholder: "计划名称，如 每日简报" });
    const text = Object.assign(el("textarea", "bt-textarea"), { placeholder: "交给 Bot 的任务文本", rows: 3 });
    const kind = select([["daily", "每天"], ["interval", "固定间隔"], ["once", "一次"]], "daily");
    const time = Object.assign(el("input", "bt-input"), { type: "time", value: "09:00" });
    const timezone = Object.assign(el("input", "bt-input"), { placeholder: "IANA 时区，如 Asia/Shanghai", value: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai" });
    const interval = Object.assign(el("input", "bt-input"), { type: "number", min: "60000", placeholder: "间隔毫秒（≥60000）" });
    const at = Object.assign(el("input", "bt-input"), { type: "datetime-local" });
    const enable = checkbox(false, () => { });
    const rowOf = (node) => node.closest(".bt-set-row");
    const sync = () => {
      rowOf(time).hidden = kind.value !== "daily";
      rowOf(timezone).hidden = kind.value !== "daily";
      rowOf(interval).hidden = kind.value !== "interval";
      rowOf(at).hidden = kind.value !== "once";
    };
    const form = el("div", "wb-form");
    form.append(
      row("Bot", null, target),
      row("名称", null, name),
      row("任务", null, text),
      row("触发", "daily 需要时间与时区；interval 需要毫秒间隔；once 需要将来的时刻。", kind),
      row("时间", "daily 使用该时刻", time),
      row("时区", "IANA 时区", timezone),
      row("间隔毫秒", "interval 使用", interval),
      row("执行时刻", "once 使用，必须晚于现在", at),
      row("创建后立即启用", "默认创建为暂停；启用是显式动作。", enable),
    );
    // 行建好后再同步可见性：隐藏行的查找依赖控件已经挂进对应的行。
    kind.onchange = sync;
    sync();
    form.append(button("btn primary wide", "创建计划", function () {
      let schedule;
      if (kind.value === "daily") {
        if (!/^\d{2}:\d{2}$/.test(time.value)) { toast("请选择每日时间", true); return; }
        schedule = { kind: "daily", time: time.value, timezone: timezone.value.trim() || "UTC" };
      } else if (kind.value === "interval") {
        const ms = Number(interval.value);
        if (!(ms >= 60000)) { toast("间隔至少 60000 毫秒", true); return; }
        schedule = { kind: "interval", intervalMs: ms };
      } else {
        const atMs = Date.parse(at.value);
        if (!Number.isFinite(atMs) || atMs <= Date.now()) { toast("执行时刻必须晚于现在", true); return; }
        schedule = { kind: "once", at: atMs };
      }
      if (!name.value.trim() || !text.value.trim() || !target.value) { toast("Bot、名称和任务必填", true); return; }
      return busy(this, api("/api/routines", { method: "POST", body: { botId: target.value, name: name.value.trim(), text: text.value.trim(), schedule, paused: !enable.checked } })
        .then(() => { toast("已创建计划"); deps.rerenderPanel?.(); })
        .catch((error) => toast(`创建失败：${error.message}`, true)), "创建中…");
    }));
    root.append(section("新建计划", form));
    root.append(el("div", "bt-note", "上一轮仍活跃时按策略跳过，不产生无界队列；错过执行只记录为 missed，不伪造执行。计划由后端调度，每次发起都走同一套 run 逻辑。"));
    return root;
  }

  function scheduleText(schedule) {
    if (!schedule || typeof schedule !== "object") return "未定义计划";
    if (schedule.kind === "daily") return `每天 ${schedule.time}（${schedule.timezone}）`;
    if (schedule.kind === "interval") return `每 ${fmtDuration(schedule.intervalMs)}`;
    if (schedule.kind === "once") return `一次 · ${fmtTime(schedule.at)}`;
    return JSON.stringify(schedule);
  }

  async function loadModels(refresh = false) {
    try {
      const data = await api(`/api/models${refresh ? "?refresh=1" : ""}`);
      models.list = data.models || [];
      models.at = Date.now();
    } catch (error) {
      if (refresh) throw error;
      models.list = [];
    }
    return models.list;
  }

  return {
    activityView,
    runDetail,
    capabilitiesPanel,
    computerPanel,
    skillsPanel,
    mcpPanel,
    memoryPanel,
    routinesPanel,
    loadModels,
    getModels: () => models.list,
  };
}

function checkbox(checked, onChange) {
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  return input;
}

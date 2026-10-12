/*
 * Product panels: activity/tasks, run detail, native capabilities, skills, MCP,
 * memory, routines, devices/channels and model catalog.
 * Every panel is driven by a real endpoint; a missing endpoint renders an honest
 * pending note instead of a fake control.
 */
import { el, button, toast, announce, api, apiOptional, fmtTime, fmtClock, fmtDuration, runStateLabel, isLiveRun, downloadText } from "./workbench-core.js";
import { artifactCard, loadArtifacts, exportRunTranscript } from "./workbench-attach.js";

const FILTERS = [
  ["all", "全部", () => true],
  ["attention", "待我处理", (run) => ["waiting_input", "waiting_approval"].includes(run.state)],
  ["active", "进行中", (run) => isLiveRun(run.state)],
  ["completed", "已完成", (run) => run.state === "completed"],
  ["failed", "失败", (run) => ["failed", "cancelled", "interrupted", "reconciliation_required"].includes(run.state)],
];

function pendingNote(what, endpoint) {
  const note = el("div", "wb-pending");
  note.append(el("div", "wb-pending-title", `${what}暂不可用`));
  note.append(el("div", "bt-note", `后端未提供 ${endpoint}（或返回 404）。已按要求不放置假操作，请父代理补齐该接口后再启用。`));
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

function row(label, hint, control) {
  const node = el("div", "bt-set-row");
  const copy = el("div", "bt-set-copy");
  copy.append(el("div", null, label));
  if (hint) copy.append(el("div", "bt-set-hint", hint));
  node.append(copy);
  if (control) {
    const box = el("div", "bt-set-control");
    box.append(control);
    node.append(box);
  }
  return node;
}

function kv(key, value) {
  const line = el("div", "bt-kv");
  line.append(el("span", null, key), el("span", null, value == null || value === "" ? "—" : String(value)));
  return line;
}

const ms = (value) => (typeof value === "number" ? value : Date.parse(value));

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
    root.id = "activity-view";
    const head = el("div", "wb-view-head");
    head.append(el("h1", null, "工作台"));
    const refresh = button("btn ghost", "刷新", () => void draw());
    const exportAll = button("btn ghost", "导出全部运行", () => {
      const runs = client.all();
      if (!runs.length) { toast("还没有运行记录", true); return; }
      downloadText("runs.json", JSON.stringify(runs, null, 2), "application/json;charset=utf-8");
    });
    head.append(refresh, exportAll);
    head.append(button("btn ghost", "配对与设备", () => deps.openDrawer("配对与设备", () => pairingSection())));
    head.append(button("btn ghost", "飞书渠道", () => deps.openDrawer("飞书渠道", () => feishuSection())));
    root.append(head);

    let filter = "all";
    let query = "";
    const tabs = el("div", "bt-tabs wb-tabs");
    const tabButtons = new Map();
    for (const [id, label] of FILTERS) {
      const tab = button("bt-tab", label, () => { filter = id; paint(); });
      tab.setAttribute("role", "tab");
      tab.dataset.filter = id;
      tabButtons.set(id, tab);
      tabs.append(tab);
    }
    root.append(tabs);

    const search = el("input", "bt-input wb-search");
    search.type = "search";
    search.placeholder = "搜索运行文本、Bot 或状态";
    search.setAttribute("aria-label", "搜索运行");
    search.oninput = () => { query = search.value.trim().toLocaleLowerCase(); paint(); };
    root.append(search);

    const list = el("div", "wb-run-list");
    const approvals = el("div", "wb-approval-list");
    root.append(approvals, list);
    const empty = el("div", "bt-empty", "没有匹配的运行。");
    root.append(empty);

    function paintApprovals() {
      approvals.replaceChildren();
      const pending = client.pending();
      if (!pending.length) {
        approvals.classList.add("hidden");
        return;
      }
      approvals.classList.remove("hidden");
      approvals.append(el("div", "wb-dock-label", `需要你处理的原生请求（${pending.length}）`));
      for (const record of pending) approvals.append(deps.approvalCard ? deps.approvalCard(record) : el("div", "bt-empty", record.title || record.id));
    }

    function paint() {
      for (const [id, tab] of tabButtons) tab.setAttribute("aria-selected", String(id === filter));
      paintApprovals();
      const predicate = FILTERS.find(([id]) => id === filter)[2];
      list.replaceChildren();
      const runs = client.all()
        .filter(predicate)
        .filter((run) => !query || `${run.text} ${run.botId} ${run.state} ${run.kind}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      empty.classList.toggle("hidden", runs.length > 0);
      for (const run of runs) list.append(runTile(run));
      announce(`${runs.length} 个运行`);
    }

    function runTile(run) {
      const bot = deps.botFor(run.botId);
      const row = el("div", "wb-run-tile");
      row.dataset.runId = run.id;
      row.dataset.state = run.state;
      const top = el("div", "wb-run-top");
      top.append(el("span", "wb-run-bot", bot?.name || run.botId || run.kind));
      top.append(el("span", "bt-state wb-run-state", runStateLabel(run.state)));
      top.append(el("span", "wb-run-time", fmtTime(run.createdAt)));
      row.append(top);
      row.append(el("div", "wb-run-text", String(run.text || "").slice(0, 240) || "（无文本）"));
      const foot = el("div", "wb-run-foot");
      foot.append(el("span", "bt-note", `${run.kind}${run.scope ? ` · ${run.scope}` : ""}${run.depth ? ` · 深度 ${run.depth}` : ""}`));
      const open = button("btn ghost", "详情", () => void deps.openDrawer(`运行 ${run.id.slice(0, 12)}`, () => runDetail(run)));
      foot.append(open);
      if (isLiveRun(run.state)) {
        foot.append(button("btn ghost danger", "停止", () => void client.cancel(run.id).then(() => { toast("已接受取消请求"); paint(); }).catch((error) => toast(error.message, true))));
      }
      row.append(foot);
      return row;
    }

    async function draw() {
      try {
        const { runs } = await api("/api/runs");
        for (const run of runs || []) client.record(run);
        paint();
      } catch (error) {
        toast(`运行列表加载失败：${error.message}`, true);
        paint();
      }
    }

    void draw();
    return { node: root, refresh: draw, repaint: paint };
  }

  /* ------------------------------ run detail ------------------------------ */

  async function runDetail(run) {
    const root = el("div", "wb-detail");
    const state = el("div", "wb-detail-state");
    state.append(el("span", "bt-state", runStateLabel(run.state)));
    root.append(state);
    const facts = el("div", "wb-kv-list");
    facts.append(
      kv("Run", run.id),
      kv("Bot", deps.botFor(run.botId)?.name || run.botId || "—"),
      kv("范围", run.scope),
      kv("类型", run.kind),
      kv("创建", fmtTime(run.createdAt)),
      kv("更新", fmtTime(run.updatedAt)),
      kv("会话", run.sessionId),
      kv("会话文件", run.sessionFile),
      kv("耗时", run.createdAt && run.updatedAt ? fmtDuration(ms(run.updatedAt) - ms(run.createdAt)) : null),
      kv("预算", run.budget != null ? JSON.stringify(run.budget) : null),
    );
    root.append(facts);
    if (run.error) {
      const err = el("div", "wb-error");
      err.setAttribute("role", "alert");
      err.append(el("div", "wb-pending-title", "错误"), el("div", "bt-note", String(run.error)));
      root.append(err);
    }
    root.append(section("请求", el("div", "wb-pre", String(run.text || ""))));
    if (run.reply) root.append(section("回复", el("div", "wb-pre", String(run.reply))));

    const actions = el("div", "bt-set-card");
    if (isLiveRun(run.state)) {
      actions.append(row("停止这次运行", "取消会级联到宿主工具与子 Run；外部动作是否发生另行对账。", button("btn ghost danger", "停止", function () { return busy(this, client.cancel(run.id).then(() => { toast("已接受取消请求"); announce("已接受取消请求"); }), "停止中…"); })));
    }
    if (run.botId) {
      actions.append(row("重试", "以相同文本发起一个新的运行；不会回滚已经发生的外部动作。", button("btn ghost", "重试", () => {
        if (!confirm("重试会以相同文本发起一个新的运行。已经发生的对外动作不会回滚。继续？")) return;
        void client.start({ botId: run.botId, text: run.text, source: "retry", parentRunId: run.id })
          .then(() => toast("已发起重试运行"))
          .catch((error) => toast(`重试失败：${error.message}`, true));
      })));
      actions.append(row("新会话", "开启新的原生会话；旧会话与历史都保留，不等于清空显示。", button("btn ghost", "新会话", function () {
        if (!confirm("开启新会话：保留旧会话历史，下一条消息进入一个新的原生会话。继续？")) return;
        return busy(this, api(`/api/bots/${encodeURIComponent(run.botId)}/session/new`, { method: "POST", body: {} }).then(() => toast("已开启新会话")), "创建中…");
      })));
      actions.append(row("分叉会话", "从当前会话分叉出一个新的原生会话分支。", button("btn ghost", "分叉", function () {
        return busy(this, api(`/api/bots/${encodeURIComponent(run.botId)}/session/fork`, { method: "POST", body: {} }).then(() => toast("已分叉会话")), "分叉中…");
      })));
      actions.append(row("导出这次运行", "导出为本地 Markdown 文件，包含文本、回复与错误。", button("btn ghost", "导出", () => exportRunTranscript(run))));
      const exportLink = el("a", "btn ghost", "导出原生会话 HTML");
      exportLink.href = `/api/bots/${encodeURIComponent(run.botId)}/session/export`;
      exportLink.setAttribute("download", "");
      actions.append(row("导出原生会话", "由后端调用原生导出，返回 HTML 附件；历史与外部动作不受影响。", exportLink));
    }
    root.append(section("操作", actions));

    const artifacts = await loadArtifacts({ runId: run.id });
    if (artifacts === null) root.append(section("成果", pendingNote("成果", "/api/artifacts")));
    else if (artifacts.length) {
      const box = el("div", "wb-artifact-list");
      for (const artifact of artifacts) box.append(artifactCard(artifact));
      root.append(section(`成果（${artifacts.length}）`, box));
    }

    if (run.botId) root.append(await nativeEntriesSection(run.botId));
    root.append(await nativeStateSection(run.botId));
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
    const capabilities = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/native/capabilities`);
    const executionInfo = capabilities?.execution || {};

    const execution = el("div", "bt-set-card");
    execution.append(row("执行模式", "supervised 使用 OMP 原生审批；chat 走 --no-tools 受控读取；full 为本机完全能力，是明确的安全降级，不是沙箱。",
      select([["supervised", "supervised（原生审批）"], ["chat", "chat（受控读取，无任意工具）"], ["full", "full（本机完全能力）"]], bot.executionMode || executionInfo.mode || "supervised", async (value) => {
        if (value === "full" && !confirm("本机完全能力不是沙箱：模型可以访问当前用户权限内的一切。确认切换到 full？")) return void deps.rerenderPanel?.();
        await patchBot(bot, { executionMode: value, confirmExecutionMode: value === "full" });
      })));
    execution.append(row("沙箱模式", executionInfo.note || "需要经过验证的沙箱环境；本机未检测到可用沙箱，因此不提供该选项，也不把它显示为“安全模式”。", el("span", "bt-note", executionInfo.sandbox ? "可用" : "不可用")));
    execution.append(row("审批档", "always-ask 每次工具调用都询问；write 仅写操作询问；yolo 不询问（仅在明确确认后可用）。",
      select([["always-ask", "always-ask"], ["write", "write"], ["yolo", "yolo"]], bot.approvalMode || executionInfo.approvalMode || "write", async (value) => {
        if (value === "yolo" && !confirm("yolo 会放行写操作而不再逐次询问。确认切换到 yolo？")) return void deps.rerenderPanel?.();
        await patchBot(bot, { approvalMode: value, confirmApprovalMode: value === "yolo" });
      })));
    execution.append(row("工作目录", "用户显式选择的目录；目录名不等于 OS 沙箱。", Object.assign(el("input", "bt-input"), {
      value: bot.workspace || "",
      placeholder: "如 C:/work/project",
      onchange: (event) => { void patchBot(bot, { workspace: event.target.value.trim() || null }); },
    })));
    const memoryReady = capabilities?.memory?.nativePrereq?.ready === true;
    const memoryReason = capabilities?.memory?.nativePrereq?.reason;
    const memoryToggle = checkbox(bot.memoryEnabled === true, (checked) => void patchBot(bot, { memoryEnabled: checked }));
    if (!memoryReady && bot.memoryEnabled !== true) memoryToggle.disabled = true;
    execution.append(row("记忆开关", memoryReady
      ? "模型来源已就绪；开启后使用 Bot 私有记忆目录，启动新回合生效。"
      : `暂不能开启：${memoryReason || "尚未确认隔离模型来源"}`, memoryToggle));
    execution.append(row("预算 token", "Bot 的累计 token 额度，留空清除此项；费用、时长和并发限制保留。", Object.assign(el("input", "bt-input"), {
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
    root.append(section("执行与权限", execution));

    if (!capabilities) root.append(section("原生能力", pendingNote("原生能力", `/api/bots/${bot.id}/native/capabilities`)));
    else {
      const facts = el("div", "bt-set-card");
      const native = capabilities.native;
      if (native) {
        facts.append(kv("模型", native.model), kv("思考档", native.thinkingLevel), kv("会话", native.sessionId), kv("会话文件", native.sessionFile));
        facts.append(kv("已落定", String(native.isSettled)), kv("流式中", String(native.isStreaming)), kv("消息数", native.messageCount));
        if (native.contextUsage != null) facts.append(kv("上下文用量", typeof native.contextUsage === "object" ? JSON.stringify(native.contextUsage) : native.contextUsage));
      } else facts.append(kv("原生状态", capabilities.nativeError || "未知"));
      facts.append(kv("工具", capabilities.tools === "unknown" ? "未知" : `${capabilities.tools?.count ?? 0} 个`));
      if (Array.isArray(capabilities.tools?.names)) {
        const pre = el("pre", "wb-pre", capabilities.tools.names.join(", "));
        facts.append(pre);
      }
      facts.append(kv("命令", capabilities.commands ? `${capabilities.commands.length} 个` : (capabilities.commandsError || "未知")));
      facts.append(kv("MCP", capabilities.mcp?.servers?.length ? `${capabilities.mcp.servers.length} 个服务` : "未配置"));
      facts.append(kv("技能", capabilities.skills?.effective?.length ? `${capabilities.skills.effective.length} 个生效` : "无过滤/无发现"));
      facts.append(kv("记忆", capabilities.memory?.available ? "可用" : `不可用（${(capabilities.memory?.reasons || []).join("；") || "未知"}）`));
      facts.append(kv("认证", capabilities.auth?.loginProviders || "未知"));
      const details = el("details", "wb-raw");
      details.append(el("summary", null, "完整能力 JSON（探测结果）"));
      details.append(el("pre", "wb-pre", JSON.stringify(capabilities, null, 2)));
      facts.append(details);
      root.append(section("原生能力", facts));
    }

    root.append(modelSection(bot));
    root.append(browserSection(capabilities?.browser));

    const loginBox = el("div", "bt-set-card");
    loginBox.append(row("原生登录 / 认证", "通过原生登录流程完成认证；凭据只在原生 UI 请求里输入，不进入聊天记录。", button("btn ghost", "开始登录", function () {
      return busy(this, api(`/api/bots/${encodeURIComponent(bot.id)}/native/command`, { method: "POST", body: { command: "login" } })
        .then(() => { announce("已请求原生登录，请在待处理请求中完成"); toast("已请求原生登录，请在“需要你处理”中完成"); })
        .catch((error) => toast(`登录请求失败：${error.message}`, true)), "请求中…");
    })));
    root.append(section("认证", loginBox));
    return root;
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
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
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
    if (!data) return section("配对与设备", pendingNote("配对与设备", "/api/pairing"));
    const box = el("div", "bt-set-card");
    const tickets = data.tickets || [];
    const devices = data.devices || [];
    if (!tickets.length && !devices.length) box.append(el("div", "bt-empty", "还没有配对码或设备。"));
    for (const ticket of tickets) {
      const line = el("div", "bt-set-row");
      const copy = el("div", "bt-set-copy");
      const expiry = ticket.expiresAt ? `到期 ${fmtClock(ticket.expiresAt)}` : "";
      const status = ticket.revokedAt ? "已撤销" : ticket.usedAt ? "已兑换" : "待兑换";
      copy.append(el("div", null, `配对码 ${ticket.label || ticket.id}`));
      copy.append(el("div", "bt-set-hint", `${status} · ${(ticket.permissions || []).join("+") || "无权限"} · ${expiry}`));
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
      copy.append(el("div", "bt-set-hint", `${device.revokedAt ? "已撤销" : "已配对"} · ${(device.permissions || []).join("+") || "无权限"}${device.lastUsedAt ? ` · 最近 ${fmtClock(device.lastUsedAt)}` : ""}`));
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
    root.append(await pairingForm());
    root.append(el("div", "bt-note", "设备凭证只能读取与运行，不能修改花名册、策略或连接器；因此这里不为设备提供管理入口。配对码一次性、短时效。"));
    return root;
  }

  async function pairingForm() {
    const form = el("div", "wb-form");
    const chosen = new Set(deps.bots().map((bot) => bot.id));
    const botsBox = el("div", "bt-set-card");
    for (const bot of deps.bots()) {
      const label = el("label", "wb-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = true;
      input.onchange = () => { input.checked ? chosen.add(bot.id) : chosen.delete(bot.id); };
      label.append(input, document.createTextNode(bot.name));
      botsBox.append(label);
    }
    const perms = new Set(["read", "run"]);
    const permBox = el("div", "bt-set-card");
    for (const [value, text, hint] of [
      ["read", "读取", "查看会话与成果"],
      ["run", "运行", "发起新的运行"],
      ["approve", "审批", "可代替人工批准原生审批请求"],
    ]) {
      const label = el("label", "wb-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = perms.has(value);
      input.onchange = () => { input.checked ? perms.add(value) : perms.delete(value); };
      const copy = el("span", null, `${text} · ${hint}`);
      label.append(input, copy);
      permBox.append(label);
    }
    const labelInput = Object.assign(el("input", "bt-input"), { placeholder: "备注，如 我的手机" });
    const ttl = select([["300000", "5 分钟"], ["3600000", "1 小时"], ["86400000", "1 天"]], "300000");
    form.append(row("授权 Bot", "配对设备只能对勾选的 Bot 读取与运行。", botsBox));
    form.append(row("权限", "read/run 默认开启；approve 允许设备代替人工批准原生审批，需单独勾选。", permBox));
    form.append(row("备注", null, labelInput), row("有效期", null, ttl));
    const output = el("div", "wb-form");
    form.append(button("btn primary wide", "生成配对码", function () {
      if (!chosen.size) { toast("至少选择一个 Bot", true); return; }
      return busy(this, api("/api/pairing/codes", {
        method: "POST",
        body: { botIds: [...chosen], permissions: [...perms], label: labelInput.value.trim() || undefined, ttlMs: Number(ttl.value) },
      }).then(({ ticket, code }) => {
        output.replaceChildren(pairingCodeCard(code, ticket));
        announce("已生成一次性配对码");
      }), "生成中…");
    }));
    form.append(output);
    return section("新建配对码", form);
  }

  function pairingCodeCard(code, ticket) {
    const card = el("div", "wb-code");
    card.append(el("div", "wb-pending-title", "配对码（只显示这一次）"));
    const line = el("div", "wb-code-row");
    const text = el("code", "wb-code-text", code);
    const copy = button("btn ghost", "复制", async () => {
      try { await navigator.clipboard.writeText(code); toast("已复制配对码"); }
      catch (error) { toast(`复制失败：${error.message}`, true); }
    });
    line.append(text, copy);
    card.append(line);
    const note = el("div", "bt-note", "一次性、短时效：兑换或到期即失效。");
    if (ticket?.expiresAt) {
      const countdown = el("span", "wb-code-countdown");
      const tick = () => {
        const left = Math.max(0, Math.round((ticket.expiresAt - Date.now()) / 1000));
        countdown.textContent = left > 0 ? `剩余 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "已过期";
        if (!card.isConnected) { clearInterval(timer); return; }
        if (left <= 0) clearInterval(timer);
      };
      const timer = setInterval(tick, 1000);
      tick();
      note.append(" ", countdown);
    }
    card.append(note);
    return card;
  }

  async function feishuSection() {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional("/api/channels/feishu");
    if (!data) { root.append(pendingNote("飞书渠道", "/api/channels/feishu")); return root; }
    const facts = el("div", "bt-set-card");
    facts.append(kv("启用", data.enabled ? "已启用" : "未启用"));
    const receiver = data.receiver || {};
    facts.append(kv("接收器", receiver.running ? `运行中 · ${receiver.path || ""}（:${receiver.port || "?"}）` : "未运行"));
    facts.append(kv("仅回环", receiver.loopbackOnly ? "是（不提供公网入口）" : "否"));
    const inbound = data.inbound || {};
    facts.append(kv("事件校验", inbound.signatureMode ? `${inbound.signatureMode}${inbound.signatureRequired ? "（需要签名）" : ""}` : inbound.signatureRequired ? "需要签名" : "按配置"));
    facts.append(kv("验证 token", inbound.verificationTokenConfigured ? "已配置" : "未配置"));
    facts.append(kv("加密密钥", inbound.encryptKeyConfigured ? "已配置" : "未配置"));
    facts.append(kv("身份映射", inbound.identities ? `${Array.isArray(inbound.identities) ? inbound.identities.length : inbound.identities} 项` : "未配置"));
    const outbound = data.outbound || {};
    facts.append(kv("出站", outbound.configured ? `已配置 · ${outbound.appId || ""}` : "未配置"));
    facts.append(kv("凭据来源", outbound.secretSource));
    facts.append(kv("API", outbound.apiBase));
    if (data.lastError) facts.append(kv("最近错误", data.lastError.code || JSON.stringify(data.lastError)));
    if (data.startError) facts.append(kv("接收器启动失败", data.startError.message || data.startError.code));
    root.append(section("飞书状态", facts));

    if (inbound.signatureWarning) {
      const warn = el("div", "wb-warn");
      warn.setAttribute("role", "alert");
      warn.append(el("div", "wb-pending-title", "签名校验警告"), el("div", "bt-note", String(inbound.signatureWarning)));
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
      root.append(section("启动提示", el("div", "bt-set-card", el("div", "bt-set-row", `本次启动把 ${inbound.interruptedOnStartup} 条未完成事件标记为 interrupted（不自动重放）。`))));
    }
    if (inbound.delivery) root.append(el("div", "bt-note", String(inbound.delivery)));

    const missing = [...(data.missing || []), ...(data.outboundMissing || [])];
    if (missing.length) {
      const list = el("div", "bt-set-card");
      for (const item of missing) list.append(el("div", "bt-set-row", String(item)));
      root.append(section("待办清单（缺少的配置）", list));
    }

    const config = data.configuration || {};
    const form = el("div", "bt-set-card");
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
    form.append(row("身份映射", "每项填 openId、chatId、botIds 和 permissions。审批需显式加入 approve；仅授权指定身份。", identities));
    const botIds = deps.bots().map(bot => `${bot.name} = ${bot.id}`).join("\n");
    if (botIds) form.append(el("pre", "wb-pre", botIds));
    form.append(button("btn primary", "保存飞书配置", function () {
      let mapping;
      try { mapping = JSON.parse(identities.value); } catch { toast("身份映射必须是有效 JSON 数组", true); return; }
      if (!Array.isArray(mapping)) { toast("身份映射必须是数组", true); return; }
      const callbackPort = Number(port.value);
      if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) { toast("回调端口需为 1 到 65535 的整数", true); return; }
      const body = { appId: fields.appId.value.trim(), port: callbackPort, identities: mapping };
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
    actions.append(row("启用渠道", data.enabled ? "关闭会真的停止接收端口。" : "启用需要配置齐全；未配置时后端返回的错误会原样显示。",
      button(data.enabled ? "btn ghost danger" : "btn primary", data.enabled ? "停用" : "启用", function () {
        const enabled = !data.enabled;
        if (enabled) announce("正在请求启用飞书渠道");
        return busy(this, api("/api/channels/feishu", { method: "PUT", body: { enabled } })
          .then(result => { toast(result.startError ? `接收器未启动：${result.startError.message}` : enabled ? "已启用飞书渠道" : "已停用飞书渠道", !!result.startError); deps.rerenderPanel?.(); })
          .catch((error) => toast(error.message, true)), "处理中…");
      })));
    const live = checkbox(false, () => { });
    const checks = el("div", "bt-set-card");
    actions.append(row("自检", "默认静态自检；勾选 live 才会请求鉴权端点（可能连不上真实飞书）。", el("div", "bt-actions", live, button("btn ghost", "运行自检", function () {
      return busy(this, api("/api/channels/feishu/test", { method: "POST", body: { live: live.checked } }).then((result) => {
        checks.replaceChildren();
        checks.append(kv("结果", result.ok ? "通过" : "未通过"));
        for (const check of result.checks || []) checks.append(kv(check.name, `${check.ok ? "✓" : "✗"} ${check.detail || ""}`));
      }).catch((error) => toast(`自检失败：${error.message}`, true)), "检测中…");
    }))));
    root.append(section("渠道操作", actions), checks);
    if (receiver.loopbackOnly && !receiver.remoteHint) root.append(el("div", "bt-note", "接收器仅监听回环地址，本页面不提供公网或隧道按钮。"));
    if (receiver.remoteHint) root.append(el("div", "bt-note", `远端接入：${receiver.remoteHint}`));
    return root;
  }

  async function skillsPanel(bot) {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/skills`);
    if (!data) { root.append(pendingNote("技能", `/api/bots/${bot.id}/skills`)); return root; }
    const discovered = data.discovered || [];
    const selected = new Set(discovered.filter((s) => s.selected).map((s) => s.name));
    const box = el("div", "bt-set-card");
    box.append(el("div", "bt-set-hint", `原生来源：${data.nativeSource || "get_available_commands + Bot 私有 skill 目录"}。勾选写入 Bot.skills 作为原生过滤，不复制 skill registry。`));
    if (!discovered.length) box.append(el("div", "bt-empty", "Bot 私有项目目录（<work>/.omp/skills）里还没有发现技能。"));
    for (const skill of discovered) {
      const label = el("label", "wb-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = selected.has(skill.name);
      input.onchange = async () => {
        input.checked ? selected.add(skill.name) : selected.delete(skill.name);
        const next = selected.size === discovered.length ? null : [...selected];
        input.disabled = true;
        try {
          await api(`/api/bots/${encodeURIComponent(bot.id)}/skills`, { method: "PUT", body: { skills: next } });
          toast("技能过滤已更新；runtime 需要重建后生效");
        } catch (error) {
          toast(`保存失败：${error.message}`, true);
          input.checked = !input.checked;
          input.checked ? selected.add(skill.name) : selected.delete(skill.name);
        } finally { input.disabled = false; }
      };
      const text = el("span");
      text.append(document.createTextNode(`${skill.name}${skill.description ? ` · ${skill.description}` : ""}`));
      text.append(el("span", "bt-note", ` [${skill.source || "?"}${skill.enabled === false ? " · 目录内已禁用" : ""}]`));
      label.append(input, text);
      box.append(label);
    }
    if (data.filter?.length) box.append(el("div", "bt-note", `当前原生过滤：${data.filter.join(", ")}`));
    else box.append(el("div", "bt-note", "当前没有过滤（等同全部生效）。"));
    root.append(section("技能过滤", box));
    if (data.commands) {
      const commands = el("div", "bt-set-card");
      commands.append(el("pre", "wb-pre", data.commands.join("\n")));
      root.append(section(`原生命令（${data.commands.length}）`, commands));
    }
    root.append(el("div", "bt-note", data.note || "真实装载仍由 OMP 原生流程完成。"));
    return root;
  }

  async function mcpPanel(bot) {
    const root = el("div", "wb-panel-body");
    const data = await apiOptional(`/api/bots/${encodeURIComponent(bot.id)}/mcp`);
    if (!data) { root.append(pendingNote("MCP 配置", `/api/bots/${encodeURIComponent(bot.id)}/mcp`)); return root; }
    const status = el("div", "bt-set-card");
    status.append(kv("作用域", data.scope), kv("文件", data.path), kv("存在", String(!!data.exists)), kv("回显密钥", String(!!data.secretsReturned)));
    if (data.error) status.append(kv("解析错误", data.error));
    if (data.note) status.append(el("div", "bt-note", data.note));
    root.append(section("原生 mcp.json", status));

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
    if (data.enabledServers?.length || data.disabledServers?.length) {
      servers.append(el("div", "bt-note", `enabledServers: ${(data.enabledServers || []).join(", ") || "—"} / disabledServers: ${(data.disabledServers || []).join(", ") || "—"}`));
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
    type.onchange = sync;
    sync();
    const form = el("div", "wb-form");
    form.append(row("类型", null, type), row("名称", null, name), row("命令", "stdio 必填", command), row("参数", null, args), row("URL", "http/sse 必填", url), row("环境/请求头", null, secrets));
    form.append(el("div", "bt-note", "写入 Bot 私有 .omp/mcp.json，不改全局配置；保存后该 Bot 的原生进程会重启以生效。本接口不会回显任何已存密钥。"));
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

  async function memoryPanel(bot) {
    const root = el("div", "wb-panel-body");
    let data = null;
    let unavailable = null;
    try {
      data = await api(`/api/bots/${encodeURIComponent(bot.id)}/memory`);
    } catch (error) {
      if (error.status === 409 && error.data?.memory) unavailable = error.data.memory;
      else if (error.status === 404) { root.append(pendingNote("记忆", `/api/bots/${bot.id}/memory`)); return root; }
      else throw error;
    }
    const status = unavailable || data;
    const facts = el("div", "bt-set-card");
    facts.append(kv("后端", status.backend || "native-local"));
    facts.append(kv("可用", status.available ? "是" : "否"));
    facts.append(kv("开关", status.enabled ? "已开启" : "未开启"));
    facts.append(kv("记忆根", status.rootSource ? `${status.root}（${status.rootSource}）` : status.root));
    facts.append(kv("隔离", status.isolation ? JSON.stringify(status.isolation) : "未知"));
    for (const file of Object.keys(status.files || {})) {
      const info = status.files[file];
      facts.append(kv(file, `${info.exists ? "存在" : "不存在"} · ${fmtSize(info.bytes)}`));
    }
    facts.append(kv("原生 clear", status.nativeClear || "disabled"));
    if (status.nativeClearReason) facts.append(el("div", "bt-note", status.nativeClearReason));
    root.append(section("状态", facts));

    if (unavailable) {
      const reasons = el("div", "bt-set-card");
      for (const reason of unavailable.reasons || []) reasons.append(el("div", "bt-set-row", reason));
      root.append(section("缺少的前置项", reasons));
      const how = el("div", "bt-set-card");
      for (const line of unavailable.howTo || []) how.append(el("div", "bt-set-row", line));
      how.append(el("div", "bt-note", "本页面不会替你修改全局认证，也不会用共享 agentDir 跑本地记忆整理。"));
      root.append(section("如何启用", how));
      const probe = el("div", "bt-set-card");
      probe.append(row("路径自检", "用原生 reader 验证记忆目录与 OMP 解析一致（会临时写读一个标记文件）。", button("btn ghost", "运行自检", function () {
        return busy(this, api(`/api/bots/${encodeURIComponent(bot.id)}/memory/probe`).then((out) => {
          const result = out.probe || out;
          probe.replaceChildren(kv("结果", result.ok ? "一致" : "不一致"), kv("目录", result.dir), kv("来源", result.source), kv("错误", result.error));
        }).catch((error) => toast(`自检失败：${error.message}`, true)), "检测中…");
      })));
      root.append(section("路径自检", probe));
      return root;
    }

    const files = Object.keys(data.content || {});
    const editor = el("div", "wb-form");
    const fileSelect = select(files.map((file) => [file, file]), files[0] || "MEMORY.md");
    const area = el("textarea", "bt-textarea wb-memory-edit");
    area.rows = 12;
    const paint = () => { area.value = data.content?.[fileSelect.value] ?? ""; };
    fileSelect.onchange = paint;
    paint();
    editor.append(row("文件", "只管理 Bot 私有目录里的 MEMORY.md 与 learned.md。", fileSelect), area);
    editor.append(el("div", "bt-actions",
      button("btn primary", "保存", function () {
        return busy(this, api(`/api/bots/${encodeURIComponent(bot.id)}/memory`, { method: "PUT", body: { file: fileSelect.value, content: area.value } })
          .then((next) => { data = { ...data, ...next }; toast("记忆已保存"); }), "保存中…");
      }),
      button("btn ghost danger", "清空两个文件", function () {
        if (!confirm("清空该 Bot 的原生作用域记忆文件？（会先备份到 checkpoints/memory-backups，原始资料不受影响）")) return;
        return busy(this, api(`/api/bots/${encodeURIComponent(bot.id)}/memory/clear`, { method: "POST", body: {} })
          .then((next) => { data = { ...data, content: { "MEMORY.md": "", "learned.md": "" } }; paint(); toast(`已清空 ${(next.cleared || []).length} 个文件`); }), "清空中…");
      })));
    root.append(section("内容", editor));
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
    kind.onchange = sync;
    sync();
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

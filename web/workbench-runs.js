/*
 * Run lifecycle, SSE consumption and native incremental rendering.
 * One transport for both REST submits and the event stream; live transcript rows are
 * mutated in place so a token never rebuilds the chat log.
 */
import { el, button, svgIcon, toast, announce, api, renderMarkdown, runStateLabel, isLiveRun, fmtClock, fmtDuration } from "./workbench-core.js";
import { parseNativeFrame, mergeChildStats, childStatBits, childStatusRank } from "./workbench-native.js";

const ATTENTION = new Set(["waiting_input", "waiting_approval"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "reconciliation_required"]);

class LiveRun {
  constructor(run, deps) {
    this.deps = deps;
    this.run = run;
    this.thinking = "";
    this.parts = [];
    this.toolNodes = new Map();
    this.subagentNodes = new Map();
    this.current = null;
    this.node = null;
    this.artifactHost = null;
    this.closed = false;
  }

  ensureNode() {
    if (this.node) return this.node;
    const run = this.run;
    const row = el("div", "bt-group-msg wb-run");
    row.dataset.runId = run.id;
    row.dataset.botId = run.botId || "";
    const name = el("span", "bt-group-name");
    const bot = this.deps.botFor(run.botId);
    name.append(document.createTextNode(`${bot?.name || "Bot"} · `));
    this.statusNode = el("span", "wb-run-state", runStateLabel(run.state));
    name.append(this.statusNode);
    row.append(name);
    const stack = el("div", "bt-astack");
    stack.dataset.lead = "";
    const line = el("div", "bt-msg-line");
    const lead = el("span", "bt-lead");
    if (bot) lead.append(this.deps.botMark(bot, 22, true, false));
    this.textHost = el("div", "wb-parts");
    line.append(lead, this.textHost);
    stack.append(line);
    this.stream = el("div", "wb-stream");
    this.artifacts = el("div", "wb-artifacts");
    const tools = el("div", "bt-tools");
    this.stopButton = button("bt-tool", null, () => this.requestStop());
    this.stopButton.setAttribute("aria-label", "停止这次运行");
    this.stopButton.title = "停止这次运行";
    this.stopButton.append(svgIcon(["M7 7h10v10H7z"], "0 0 24 24", { width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" }));
    tools.append(this.stopButton);
    stack.append(this.stream, this.artifacts, tools);
    row.append(stack);
    this.node = row;
    if (this.run.kind === "room") {
      // Rooms keep the existing round renderer; the run row only carries status.
      this.stopButton.remove();
    }
    return row;
  }

  setState(state) {
    this.run.state = state;
    if (this.statusNode) {
      this.statusNode.textContent = runStateLabel(state);
      this.statusNode.dataset.state = state;
    }
    if (this.node) this.node.dataset.state = state;
    if (this.stopButton) {
      this.stopButton.disabled = state === "cancelling";
      if (state === "cancelling") this.stopButton.textContent = "停止中…";
    }
    if (TERMINAL.has(state)) {
      if (this.stopButton) this.stopButton.remove();
      this.collapseThinking();
    }
  }

  collapseThinking() {
    if (this.think && this.thinking) {
      this.think.open = false;
      this.think.querySelector("summary").textContent = "思考过程（已完成）";
    }
  }

  /** Concatenated streamed assistant text, used to keep the reply when history lags. */
  text() {
    return this.parts.filter((part) => part.kind === "text").map((part) => part.buffer).join("\n\n").trim();
  }

  note(text) {
    this.ensureNode();
    const line = el("div", "wb-note wb-user-note", `你：${text}`);
    this.stream.append(line);
    this.keepPinned();
  }

  atBottom() {
    const log = this.deps.chatLog();
    return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  }

  keepPinned() {
    if (!this.pinned) return;
    const log = this.deps.chatLog();
    if (log) log.scrollTop = log.scrollHeight;
  }

  part(kind) {
    if (this.current && this.current.kind === kind && !this.current.done) return this.current;
    const part = { kind, buffer: "", done: false, node: null, scheduled: false };
    if (kind === "thinking") {
      if (!this.think) {
        this.think = el("details", "bt-think");
        this.think.open = true;
        this.thinkText = el("div", "bt-think-text");
        this.think.append(el("summary", null, "思考过程"), this.thinkText);
        this.textHost.append(this.think);
      }
      part.node = this.thinkText;
    } else if (kind === "text") {
      part.node = el("div", "bt-bubble wb-bubble");
      this.textHost.append(part.node);
    } else {
      part.node = el("div", "wb-note");
      this.textHost.append(part.node);
    }
    this.parts.push(part);
    this.current = part;
    return part;
  }

  endPart(kind) {
    if (this.current && this.current.kind === kind) {
      this.flush(this.current);
      this.current.done = true;
      this.current = null;
    }
  }

  schedule(part) {
    if (part.scheduled) return;
    part.scheduled = true;
    queueMicrotask(() => {
      part.scheduled = false;
      this.flush(part);
    });
  }

  flush(part) {
    if (!part.node) return;
    if (part.kind === "text") {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.containsNode(part.node, true)) return;
      renderMarkdown(part.node, part.buffer);
    } else if (part.kind === "thinking") {
      part.node.textContent = this.thinking;
    } else {
      part.node.textContent = part.buffer;
    }
    this.keepPinned();
  }

  pushText(kind, text) {
    const part = this.part(kind);
    part.buffer += text;
    if (kind === "thinking") {
      this.thinking += text;
      this.schedule(part);
      return;
    }
    this.schedule(part);
  }

  tool(frame) {
    const key = frame.id || `pending:${frame.name || ""}`;
    let node = this.toolNodes.get(key);
    if (!node) {
      node = this.toolRow(frame);
      this.toolNodes.set(key, node);
      this.stream.append(node.root);
    }
    if (frame.id && key !== frame.id) { this.toolNodes.delete(key); this.toolNodes.set(frame.id, node); }
    if (frame.name) node.name.textContent = frame.name;
    node.state.textContent = frame.phase === "start" ? "运行中" : frame.phase === "end" ? (frame.isError ? "失败" : "完成") : "进行中";
    node.root.dataset.state = frame.isError ? "error" : frame.phase;
    const detail = frame.error ?? frame.result ?? frame.args;
    if (detail !== undefined) {
      node.body.hidden = false;
      node.body.textContent = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    }
    this.keepPinned();
  }

  toolRow(frame) {
    const root = el("div", "wb-tool");
    const head = el("button", "wb-tool-head");
    head.type = "button";
    head.setAttribute("aria-expanded", "false");
    head.append(svgIcon(["M14.7 6.3a4 4 0 1 0 3 3L21 6l-3-3-3.3 3.3Z", "M14 10 4 20"], "0 0 24 24", { width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" }));
    const name = el("span", "wb-tool-name", frame.name || "工具");
    const state = el("span", "wb-tool-state", "运行中");
    head.append(name, state);
    const body = el("pre", "wb-tool-body");
    body.hidden = true;
    head.onclick = () => { body.hidden = !body.hidden; head.setAttribute("aria-expanded", String(!body.hidden)); };
    root.append(head, body);
    return { root, name, state, body };
  }

  /** Feed the native task/wait child arrays into the same row renderer used for children. */
  childTasks(children) {
    for (const child of children) if (child && (child.id || child.label)) this.subagent(child);
  }

  subagent(child) {
    const key = child.id || child.label || `anon-${this.subagentNodes.size}`;
    let node = this.subagentNodes.get(key);
    if (!node) {
      const root = el("div", "wb-subagent");
      const name = el("span", "wb-subagent-name");
      const state = el("span", "wb-subagent-state");
      const bar = el("div", "wb-subagent-bar");
      const fill = el("div", "wb-subagent-fill");
      bar.append(fill);
      bar.hidden = true;
      const meta = el("div", "wb-subagent-meta");
      const detail = el("div", "wb-note");
      const result = el("details", "wb-raw wb-subagent-result");
      result.hidden = true;
      result.append(el("summary", null, "子任务结果"));
      const resultText = el("pre", "wb-pre");
      result.append(resultText);
      root.append(name, state, bar, meta, detail, result);
      const record = { root, name, state, bar, fill, meta, detail, result, resultText, rank: -1, stats: {} };
      this.subagentNodes.set(key, record);
      this.stream.append(root);
      node = record;
    }
    const rank = childStatusRank(child.status);
    if (rank >= node.rank) {
      node.rank = rank;
      const duration = child.durationMs ?? node.stats.durationMs;
      node.state.textContent = [child.status || "进行中", child.agent ? `· ${child.agent}` : "", duration ? `· ${fmtDuration(duration)}` : ""]
        .filter(Boolean).join(" ");
      node.root.dataset.state = String(child.status || "");
    }
    // Later frames (e.g. the wait snapshot) omit stats the progress frames carried; keep the last known values.
    node.stats = mergeChildStats(node.stats, child);
    node.name.textContent = child.label || child.id || "子任务";
    const bits = childStatBits(node.stats);
    node.meta.textContent = bits.join(" · ");
    node.meta.hidden = bits.length === 0;
    const noise = (value) => !value || value === "[depth-limit]";
    const detail = !noise(child.recentOutput) ? child.recentOutput : !noise(child.recentTools) ? child.recentTools : !noise(child.detail) ? child.detail : "";
    node.detail.textContent = detail ? String(detail) : "";
    node.detail.hidden = !detail;
    if (child.progress != null) {
      const pct = Number(child.progress);
      node.bar.hidden = false;
      node.fill.style.width = Number.isFinite(pct) ? `${pct > 1 ? pct : pct * 100}%` : "0%";
    }
    if (child.resultText) {
      node.result.hidden = false;
      node.resultText.textContent = String(child.resultText);
    }
    this.keepPinned();
  }

  todo(frame) {
    if (frame.cleared) {
      if (this.todoNode) this.todoNode.remove();
      this.todoNode = null;
      return;
    }
    const todos = Array.isArray(frame.todos) ? frame.todos : null;
    if (!this.todoNode) {
      this.todoNode = el("div", "wb-todo");
      this.stream.append(this.todoNode);
    }
    this.todoNode.replaceChildren(el("div", "wb-todo-title", "任务清单"));
    if (!todos) {
      this.todoNode.append(el("div", "wb-note", JSON.stringify(frame.raw ?? frame.todos ?? {})));
      return;
    }
    for (const item of todos) {
      const text = typeof item === "string" ? item : item.text || item.title || item.content || JSON.stringify(item);
      const done = typeof item === "object" && (item.done === true || item.status === "completed" || item.checked === true);
      const line = el("div", "wb-todo-item" + (done ? " done" : ""), text);
      this.todoNode.append(line);
    }
  }

  goal(frame) {
    if (!this.goalNode) {
      this.goalNode = el("div", "wb-goal");
      this.stream.append(this.goalNode);
    }
    const goal = frame.goal || {};
    const text = pick(goal, "text objective title description content") || (typeof goal === "string" ? goal : "");
    this.goalNode.replaceChildren(el("div", "wb-todo-title", "目标"));
    if (text) this.goalNode.append(el("div", "wb-note", String(text)));
    const budget = pick(goal, "token_budget tokenBudget budget") ?? pick(goal, "tokensUsed tokens");
    if (budget != null) this.goalNode.append(el("div", "wb-note", `预算 ${JSON.stringify(budget)}`));
  }

  artifact(artifact) {
    const host = this.artifacts || (this.node && this.node.querySelector(".wb-artifacts"));
    if (!host) return;
    const card = el("div", "bt-connector wb-artifact");
    const head = el("div", "bt-connector-head");
    const mark = el("span", "bt-connector-mark");
    mark.append(svgIcon(["M6 2h8l4 4v16H6z", "M14 2v4h4"], "0 0 24 24", { width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round" }));
    const text = el("div", "bt-connector-text");
    text.append(el("div", "bt-connector-name", artifact.name || artifact.path || "成果"));
    text.append(el("div", "bt-connector-status", [artifact.mime, artifact.size != null ? `${artifact.size} B` : null].filter(Boolean).join(" · ") || "已登记成果"));
    head.append(mark, text);
    card.append(head);
    if (artifact.id) {
      const actions = el("div", "bt-actions");
      const link = el("a", "btn ghost", "下载");
      link.href = `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
      link.setAttribute("download", "");
      const view = button("btn ghost", "预览", () => {
        const pane = el("div", "wb-preview");
        const frame = el("iframe", "wb-preview-frame");
        frame.src = `/api/artifacts/${encodeURIComponent(artifact.id)}/preview`;
        frame.setAttribute("sandbox", "");
        frame.title = `${artifact.name || "成果"} 预览`;
        const close = button("btn ghost", "关闭预览", () => pane.remove());
        pane.append(frame, close);
        card.append(pane);
      });
      actions.append(link, view);
      card.append(actions);
    }
    host.append(card);
    this.keepPinned();
  }

  async requestStop() {
    try {
      const { run } = await this.deps.cancel(this.run.id);
      if (run) this.setState(run.state || "cancelling");
      announce("已接受取消请求，等待原生确认停止");
      toast("已接受取消请求，正在等待原生确认");
    } catch (error) {
      toast(`取消失败：${error.message}`, true);
    }
  }

  dispose() {
    this.closed = true;
    if (this.node) this.node.remove();
  }
}

export function createRunClient(deps) {
  const runs = new Map();
  const live = new Map();
  const approvals = new Map();
  let lastSeq = 0;
  let seqCursor = 0;
  const listeners = new Set();

  const notify = (what) => { for (const fn of listeners) { try { fn(what); } catch { /* listener errors stay local */ } } };
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  const record = (run) => {
    if (!run || !run.id) return null;
    const existing = runs.get(run.id);
    runs.set(run.id, { ...existing, ...run });
    return runs.get(run.id);
  };

  const liveFor = (run) => {
    let node = live.get(run.id);
    if (!node) {
      node = new LiveRun(record(run), deps);
      live.set(run.id, node);
    }
    return node;
  };

  function handleNative(runId, frame) {
    const parsed = parseNativeFrame(frame);
    if (!parsed) return;
    const node = live.get(runId);
    if (!node) return;
    node.pinned = node.atBottom();
    if (parsed.kind === "text_delta") node.pushText("text", parsed.text);
    else if (parsed.kind === "thinking_delta") node.pushText("thinking", parsed.text);
    else if (parsed.kind === "block_end") node.endPart(parsed.block);
    else if (parsed.kind === "tool") {
      node.tool(parsed);
      if (Array.isArray(parsed.children) && parsed.children.length) node.childTasks(parsed.children);
    } else if (parsed.kind === "subagent") {
      node.subagent({ id: parsed.id, label: parsed.name, agent: parsed.phase, status: parsed.status, progress: parsed.progress, detail: parsed.detail });
    } else if (parsed.kind === "todo") node.todo(parsed);
    else if (parsed.kind === "goal") node.goal(parsed);
  }

  function upsertApproval(record) {
    if (!record || !record.id) return;
    approvals.set(record.id, { ...approvals.get(record.id), ...record });
    deps.onApprovalsChanged?.(pending());
    notify("approval");
  }

  function applyRun(run) {
    if (!run || !run.id) return;
    const known = runs.get(run.id);
    const wasTerminal = known?.state;
    record(run);
    const node = live.get(run.id);
    if (node) {
      node.run = runs.get(run.id);
      if (run.state) node.setState(run.state);
    }
    if (TERMINAL.has(run.state) && node) {
      node.collapseThinking();
      node.stopButton?.remove();
      if (wasTerminal !== run.state) deps.onRunFinished?.(runs.get(run.id));
    }
    notify("run");
  }

  function handleEvent(event) {
    if (!event || typeof event.type !== "string") return;
    if (Number.isInteger(event.seq)) {
      if (event.seq <= seqCursor) return; // dedup across reconnect
      if (event.seq > seqCursor + 1) deps.onGap?.(seqCursor, event.seq);
      seqCursor = event.seq;
      lastSeq = event.seq;
    }
    switch (event.type) {
      case "run_created":
      case "run_updated":
      case "run_finished":
        applyRun(event.run);
        break;
      case "native_event":
        if (event.runId) handleNative(event.runId, event.event);
        break;
      case "ui_request":
        upsertApproval(event.approval);
        break;
      case "ui_resolved":
        if (event.approval?.id) {
          approvals.set(event.approval.id, event.approval);
          deps.onApprovalsChanged?.(pending());
          notify("approval");
        }
        break;
      case "artifact_added":
        if (event.artifact) {
          deps.onArtifact?.(event.artifact);
          const node = event.runId ? live.get(event.runId) : null;
          if (node) node.artifact(event.artifact);
        }
        break;
      default:
        break;
    }
  }

  const pending = () => [...approvals.values()].filter((a) => a.status === "pending");

  async function start(input) {
    const { run } = await api("/api/runs", { method: "POST", body: input });
    record(run);
    deps.onRunStarted?.(run);
    notify("run");
    return run;
  }

  async function cancel(id) {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
    if (result.run) applyRun(result.run);
    else {
      const run = runs.get(id);
      if (run) applyRun({ ...run, state: "cancelling" });
    }
    return result;
  }

  async function steer(id, text, behavior = "steer") {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/steer`, { method: "POST", body: { text, behavior } });
    if (result.run) applyRun(result.run);
    return result;
  }

  async function respond(id, response) {
    const result = await api(`/api/approvals/${encodeURIComponent(id)}/respond`, { method: "POST", body: response });
    if (result.approval) {
      approvals.set(id, result.approval);
      deps.onApprovalsChanged?.(pending());
      notify("approval");
    }
    return result;
  }

  const HISTORY_LIMIT = 5000;
  const HISTORY_MAX_PAGES = 40;

  async function historyPage(since, runId) {
    const query = new URLSearchParams({ since: String(since), limit: String(HISTORY_LIMIT) });
    if (runId) query.set("runId", runId);
    return api(`/api/events/history?${query}`);
  }

  /** Walk the retained ledger window from `since` in capped pages; reports any remaining gap. */
  async function walkHistory(since, onEvent, runId) {
    let cursor = Number(since) || 0;
    let applied = 0;
    for (let page = 0; ; page += 1) {
      const result = await historyPage(cursor, runId);
      const events = result.events || [];
      if (Number.isInteger(result.lastSeq)) lastSeq = result.lastSeq;
      for (const event of events) { onEvent(event); applied += 1; }
      const maxSeq = events.reduce((max, item) => (Number.isInteger(item.seq) ? Math.max(max, item.seq) : max), cursor);
      const drained = events.length < HISTORY_LIMIT
        || maxSeq <= cursor
        || (!runId && Number.isInteger(result.lastSeq) && maxSeq >= result.lastSeq);
      if (drained) return { applied, cursor: maxSeq };
      if (page + 1 >= HISTORY_MAX_PAGES) {
        deps.onGap?.(maxSeq, Number.isInteger(result.lastSeq) ? result.lastSeq : maxSeq + 1);
        return { applied, cursor: maxSeq };
      }
      cursor = maxSeq;
    }
  }

  /** Replay persisted events after a reconnect using the ledger cursor, paging the retained window. */
  async function replenish(since = seqCursor) {
    const { applied } = await walkHistory(since, handleEvent);
    if (applied) deps.onReplayed?.();
    return applied;
  }

  function restore(snapshot) {
    for (const run of snapshot.activeRuns || []) record(run);
    for (const approval of snapshot.pendingApprovals || []) upsertApproval(approval);
    if (Number.isInteger(snapshot.lastSeq)) {
      seqCursor = snapshot.lastSeq;
      lastSeq = snapshot.lastSeq;
    }
    notify("run");
  }

  /** Replay the ledger projection for restored active runs so a refresh keeps streamed text. */
  async function rehydrate() {
    const active = [...runs.values()].filter((run) => isLiveRun(run.state));
    if (!active.length) return 0;
    let applied = 0;
    for (const run of active) {
      liveFor(run);
      const { applied: frames } = await walkHistory(0, (event) => {
        if (event?.type === "native_event" && event.runId === run.id) handleNative(run.id, event.event);
      }, run.id);
      applied += frames;
    }
    return applied;
  }

  const runsFor = (target) => [...runs.values()].filter((run) => {
    if (!target) return false;
    if (target.kind === "bot") return run.botId === target.id && run.kind !== "delegation";
    return run.roomId === target.id;
  });

  const activeFor = (target) => runsFor(target).filter((run) => isLiveRun(run.state));

  const transcriptRuns = (target) => {
    if (!target || target.kind !== "bot") return [];
    return runsFor(target).filter((run) => isLiveRun(run.state));
  };

  function appendLive(log, target) {
    for (const run of transcriptRuns(target)) {
      const node = liveFor(run);
      node.ensureNode();
      log.append(node.node);
    }
  }

  function statusText(target) {
    const active = activeFor(target);
    if (!active.length) return "";
    if (active.some((run) => run.state === "cancelling")) return "正在停止…";
    if (active.some((run) => ATTENTION.has(run.state))) return "等待你的处理";
    return "执行中…";
  }

  function note(runId, text) {
    const node = live.get(runId);
    if (node) node.note(text);
  }

  return {
    on, handleEvent, restore, replenish, rehydrate, start, cancel, steer, respond, note,
    record, applyRun, upsertApproval, pending, runsFor, activeFor, transcriptRuns, appendLive, statusText,
    all: () => [...runs.values()],
    get: (id) => runs.get(id) || null,
    liveNode: (id) => live.get(id) || null,
    dropLive: (id) => { live.delete(id); },
    get lastSeq() { return lastSeq; },
  };
}

/** Approval dock: renders native select/confirm/input/editor/ask cards for one conversation. */
export function createApprovalDock(deps) {
  const { client } = deps;
  let selectedTarget = null;

  const isExpired = (record) => Number(record.expiresAt) > 0 && Number(record.expiresAt) <= Date.now();

  function optionLabel(record, index, value) {
    const details = record.optionDetails;
    if (Array.isArray(details)) {
      const entry = details[index];
      if (entry && typeof entry === "object") return { text: entry.label || value, desc: entry.description || entry.detail || "" };
      if (typeof entry === "string" && entry !== value) return { text: value, desc: entry };
    }
    return { text: value, desc: "" };
  }

  function card(record) {
    const expired = isExpired(record);
    const root = el("div", "bt-q bt-q-raised wb-approval");
    root.dataset.approvalId = record.id;
    root.dataset.method = record.method || "";
    root.setAttribute("role", "group");
    const head = el("div", "bt-q-head");
    const text = el("div", "bt-q-text");
    text.append(el("div", "bt-q-title", record.title || "原生请求"));
    const meta = [record.method, record.botId ? `Bot ${record.botId}` : null, record.scope, record.expiresAt ? `到期 ${fmtClock(record.expiresAt)}` : null].filter(Boolean).join(" · ");
    if (meta) text.append(el("div", "bt-q-detail", meta));
    head.append(text);
    root.append(head);
    if (record.message) {
      const body = el("div", "bt-q-body wb-approval-message");
      renderMarkdown(body, record.message);
      root.append(body);
    }
    if (expired) {
      root.dataset.state = "expired";
      root.append(el("div", "bt-q-detail", "该请求已过期，不能代替你作答。"));
      return root;
    }

    const submit = async (response) => {
      root.setAttribute("aria-busy", "true");
      for (const control of root.querySelectorAll("button, input, textarea, select")) control.disabled = true;
      try {
        await client.respond(record.id, response);
        announce("已提交原生响应");
      } catch (error) {
        if (error.status === 409) {
          root.dataset.state = "expired";
          root.append(el("div", "bt-q-detail", "请求已过期或运行已结束，未提交。"));
          toast("该请求已过期或运行已结束", true);
        } else {
          for (const control of root.querySelectorAll("button, input, textarea, select")) control.disabled = false;
          root.setAttribute("aria-busy", "false");
          toast(`提交失败：${error.message}`, true);
        }
      }
    };

    if (record.method === "select") {
      const options = Array.isArray(record.options) ? record.options : [];
      const list = el("div", "bt-q-list");
      let chosen = null;
      const buttons = options.map((value, index) => {
        const { text: label, desc } = optionLabel(record, index, String(value));
        const opt = button("bt-q-opt", null, () => {
          chosen = value;
          for (const node of buttons) node.setAttribute("aria-pressed", String(node === opt));
          submitButton.disabled = false;
          submitButton.focus();
        });
        opt.setAttribute("aria-pressed", "false");
        opt.dataset.value = String(value);
        const key = el("span", "bt-key", String(index + 1));
        const body = el("span", "bt-q-body");
        body.append(el("span", "bt-q-label", label));
        if (desc) body.append(el("span", "bt-q-desc", desc));
        opt.append(key, body);
        list.append(opt);
        return opt;
      });
      root.append(list);
      const foot = el("div", "bt-q-foot");
      const submitButton = button("bt-q-submit", "提交选择", () => { if (chosen != null) void submit({ value: chosen }); });
      submitButton.disabled = true;
      const cancel = button("bt-q-btn", "取消", () => void submit({ cancelled: true }));
      foot.append(cancel, submitButton);
      root.append(foot);
    } else if (record.method === "confirm") {
      const foot = el("div", "bt-q-foot");
      const cancel = button("bt-q-btn", "取消", () => void submit({ cancelled: true }));
      const yes = button("bt-q-submit", "确认", () => void submit({ confirmed: true }));
      const no = button("bt-q-btn", "拒绝", () => void submit({ confirmed: false }));
      foot.append(cancel, no, yes);
      root.append(foot);
    } else if (record.method === "input" || record.method === "editor") {
      const field = el("div", "bt-q-custom");
      const wrap = el("div", "bt-q-field");
      const input = record.method === "editor" ? el("textarea", "bt-q-input") : el("input", "bt-q-input");
      if (record.method === "editor") input.rows = 6;
      else input.type = "text";
      input.placeholder = record.placeholder || "输入内容";
      input.setAttribute("aria-label", record.title || "原生输入");
      wrap.append(input);
      field.append(wrap);
      root.append(field);
      const foot = el("div", "bt-q-foot");
      foot.append(button("bt-q-btn", "取消", () => void submit({ cancelled: true })));
      foot.append(button("bt-q-submit", "提交", () => void submit({ value: input.value })));
      root.append(foot);
    } else if (record.method === "ask" && Array.isArray(record.questions)) {
      const answers = [];
      record.questions.forEach((question, qIndex) => {
        const block = el("div", "bt-q-body");
        block.append(el("div", "bt-q-label", question.header || question.question || `问题 ${qIndex + 1}`));
        const options = question.options || [];
        answers.push({ header: question.header || question.question || "", value: options.length ? null : "" });
        if (options.length) {
          const list = el("div", "bt-q-list");
          const nodes = options.map((opt, index) => {
            const value = typeof opt === "string" ? opt : opt.label || opt.value;
            const desc = typeof opt === "object" ? opt.description || opt.detail || "" : "";
            const node = button("bt-q-opt", null, () => {
              if (question.multi) {
                const set = answers[qIndex].value instanceof Set ? answers[qIndex].value : new Set();
                set.has(value) ? set.delete(value) : set.add(value);
                answers[qIndex].value = set;
                node.setAttribute("aria-pressed", String(set.has(value)));
              } else {
                answers[qIndex].value = value;
                for (const peer of nodes) peer.setAttribute("aria-pressed", String(peer === node));
              }
            });
            node.setAttribute("aria-pressed", "false");
            const body = el("span", "bt-q-body");
            body.append(el("span", "bt-q-label", value));
            if (desc) body.append(el("span", "bt-q-desc", desc));
            if (question.multi) node.append(el("span", "bt-key", index + 1 + ""), body);
            else node.append(el("span", "bt-key", String(index + 1)), body);
            list.append(node);
            return node;
          });
          block.append(list);
        } else {
          const field = el("div", "bt-q-custom");
          const wrap = el("div", "bt-q-field");
          const input = el("textarea", "bt-q-input");
          input.rows = 2;
          input.setAttribute("aria-label", question.header || `问题 ${qIndex + 1}`);
          input.oninput = () => { answers[qIndex].value = input.value; };
          wrap.append(input);
          field.append(wrap);
          block.append(field);
        }
        root.append(block);
      });
      const foot = el("div", "bt-q-foot");
      foot.append(button("bt-q-btn", "取消", () => void submit({ cancelled: true })));
      foot.append(button("bt-q-submit", "提交回答", () => {
        const payload = answers.map((answer) => ({
          header: answer.header,
          value: answer.value instanceof Set ? [...answer.value] : answer.value,
        }));
        void submit({ answers: payload });
      }));
      root.append(foot);
    } else if (record.method === "show_message") {
      root.append(el("div", "bt-q-detail", "该请求仅展示信息，无需作答。"));
      root.append(el("div", "bt-q-foot", null));
    } else {
      root.append(el("div", "bt-q-detail", `暂不支持的原生请求：${record.method || "未知"}。请用原生 CLI 处理。`));
      return root;
    }
    return root;
  }

  let announced = -1;
  function render(container, target = selectedTarget) {
    selectedTarget = target;
    if (!container) return;
    const all = client.pending();
    const mine = all.filter((record) => {
      if (!target || target.kind !== "bot") return !record.botId;
      return !record.botId || record.botId === target.id;
    });
    container.replaceChildren();
    container.classList.toggle("hidden", mine.length === 0);
    if (!mine.length) {
      if (announced > 0) announced = 0;
      return;
    }
    const title = el("div", "wb-dock-title");
    title.append(el("span", "wb-dock-label", "需要你处理"));
    title.append(el("span", "wb-count", String(mine.length)));
    container.append(title);
    for (const record of mine) container.append(card(record));
    if (mine.length !== announced) {
      announced = mine.length;
      announce(`有 ${mine.length} 个原生请求等待处理`);
    }
  }

  return { render, card, setTarget: (target) => { selectedTarget = target; }, pending: () => client.pending() };
}

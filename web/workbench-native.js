/*
 * Pure native-frame decoder: maps OMP rpc-ui frames onto the renderer's part model.
 * No DOM imports on purpose so it stays unit-testable in plain Node.
 * Field names follow docs/rpc.md (assistantMessageEvent = {type,delta}) with a tolerant
 * fallback for the OMP AgentSessionEvent payloads whose exact keys are not frozen yet.
 */
const LIVE_TYPES = new Set([
  "text_delta", "thinking_delta", "toolcall_delta",
  "text_end", "thinking_end", "toolcall_end",
  "text_start", "thinking_start", "start",
]);

const pick = (obj, keys) => {
  for (const key of keys.split(" ")) if (obj && obj[key] != null) return obj[key];
  return undefined;
};

/**
 * OMP 18.10 async-task mode has no subagent_* frames. Child progress arrives inside tool
 * frames: task → partialResult/result.details.progress[]; wait → details.jobs[].
 */
function childFromProgress(entry) {
  return {
    id: pick(entry, "id label jobId agentUrlId"),
    label: pick(entry, "label id agentUrlId"),
    agent: pick(entry, "agent type agentSource"),
    status: pick(entry, "status state"),
    durationMs: pick(entry, "durationMs"),
    toolCount: pick(entry, "toolCount"),
    requests: pick(entry, "requests"),
    tokens: pick(entry, "tokens"),
    cost: pick(entry, "cost"),
    currentTool: pick(entry, "currentTool"),
    recentTools: pick(entry, "recentTools"),
    recentOutput: pick(entry, "recentOutput"),
    contextTokens: pick(entry, "contextTokens"),
    contextWindow: pick(entry, "contextWindow"),
    resolvedModel: pick(entry, "resolvedModel resolvedModelIdentity"),
    resolvedModelIdentity: pick(entry, "resolvedModelIdentity"),
    resolvedThinkingLevel: pick(entry, "resolvedThinkingLevel"),
    resolvedModelIsFallback: entry.resolvedModelIsFallback === true,
    resultText: pick(entry, "resultText"),
  };
}

function childFromJob(job) {
  return {
    id: pick(job, "id label agentUrlId"),
    label: pick(job, "label id agentUrlId"),
    agent: pick(job, "type agent"),
    status: pick(job, "status state"),
    durationMs: pick(job, "durationMs"),
    tokens: pick(job, "tokens"),
    cost: pick(job, "cost"),
    progress: pick(job, "progress percent"),
    resolvedModel: pick(job, "resolvedModel resolvedModelIdentity"),
    resolvedModelIdentity: pick(job, "resolvedModelIdentity"),
    resolvedThinkingLevel: pick(job, "resolvedThinkingLevel"),
    resolvedModelIsFallback: job.resolvedModelIsFallback === true,
    resultText: pick(job, "resultText"),
  };
}

/** Pull the child/job arrays out of a tool frame's details, if it carries any. */
function taskChildren(frame) {
  for (const source of [frame.partialResult, frame.result]) {
    const details = source && typeof source === "object" ? source.details : null;
    if (!details || typeof details !== "object") continue;
    if (Array.isArray(details.progress)) {
      return { children: details.progress.map(childFromProgress), async: details.async ?? null };
    }
    if (Array.isArray(details.jobs)) {
      return { children: details.jobs.map(childFromJob), async: details.async ?? null };
    }
  }
  return null;
}

/** Stats a child row can show; later frames (wait snapshots) omit several of them. */
export const CHILD_STAT_KEYS = [
  "resolvedModel", "resolvedModelIdentity", "resolvedThinkingLevel", "tokens", "cost",
  "toolCount", "requests", "contextTokens", "contextWindow", "durationMs", "currentTool",
];

/** Merge a later child frame onto the stats already known for that child. */
export function mergeChildStats(previous, child) {
  const stats = { ...previous };
  for (const key of CHILD_STAT_KEYS) if (child?.[key] != null) stats[key] = child[key];
  if (child?.resolvedModelIsFallback === true) stats.resolvedModelIsFallback = true;
  return stats;
}

/** Human-readable stat bits for a child row; empty when the frame carried nothing. */
export function childStatBits(stats) {
  const bits = [];
  if (stats?.resolvedModelIdentity || stats?.resolvedModel) {
    bits.push(`模型 ${stats.resolvedModelIdentity || stats.resolvedModel}${stats.resolvedModelIsFallback === true ? "（回退）" : ""}`);
  }
  if (stats?.resolvedThinkingLevel) bits.push(`thinking ${stats.resolvedThinkingLevel}`);
  if (stats?.tokens != null) bits.push(`tokens ${stats.tokens}`);
  if (Number(stats?.cost) > 0) bits.push(`费用 ${Number(stats.cost).toFixed(4)}`);
  if (stats?.toolCount != null) bits.push(`工具 ${stats.toolCount}`);
  if (stats?.requests != null) bits.push(`请求 ${stats.requests}`);
  if (stats?.contextTokens != null && stats?.contextWindow != null) bits.push(`上下文 ${stats.contextTokens}/${stats.contextWindow}`);
  if (stats?.currentTool) bits.push(`当前 ${stats.currentTool}`);
  return bits;
}

/** Child status rank: a settled child is never downgraded by a late running update. */
export function childStatusRank(status) {
  const value = String(status || "").toLowerCase();
  if (["completed", "done", "success", "succeeded", "failed", "error", "aborted", "cancelled", "canceled", "timeout"].includes(value)) return 3;
  if (["running", "in_progress", "streaming"].includes(value)) return 2;
  if (["pending", "queued", "starting"].includes(value)) return 1;
  return 0;
}

const PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned", "blocked"]);

/**
 * OMP 原生 todo 工具每次改动都在结果 details.phases 里带上完整计划。
 * 从一条已解析的工具帧里取出计划；不是 todo 的成功结束帧、只是查看、或形状不对，返回 null。
 */
export function planFromTool(parsed) {
  if (!parsed || parsed.kind !== "tool" || parsed.phase !== "end" || parsed.isError) return null;
  if (parsed.name !== "todo") return null;
  const details = parsed.result && typeof parsed.result === "object" ? parsed.result.details : null;
  if (!details || details.op === "view" || !Array.isArray(details.phases)) return null;
  const phases = [];
  for (const phase of details.phases) {
    if (!phase || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    const tasks = [];
    for (const task of phase.tasks) {
      if (!task || typeof task.content !== "string" || !PLAN_STATUSES.has(task.status)) return null;
      tasks.push(typeof task.blocker === "string" && task.blocker ? { content: task.content, status: task.status, blocker: task.blocker } : { content: task.content, status: task.status });
    }
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

/** Parse one native frame into a renderer input; null means "not a display frame". */
export function parseNativeFrame(frame) {
  if (!frame || typeof frame.type !== "string") return null;
  const type = frame.type;
  if (type === "message_update") {
    const delta = frame.assistantMessageEvent || frame;
    const kind = pick(delta, "type");
    if (!LIVE_TYPES.has(kind)) return { kind: "unknown", raw: frame };
    const text = pick(delta, "delta text textDelta") ?? "";
    if (kind === "text_delta") return { kind: "text_delta", text };
    if (kind === "thinking_delta") return { kind: "thinking_delta", text };
    if (kind === "text_end" || kind === "thinking_end") return { kind: "block_end", block: kind === "text_end" ? "text" : "thinking" };
    if (kind === "toolcall_delta") {
      return { kind: "toolcall_delta", id: pick(delta, "toolCallId id") ?? pick(frame, "messageId"), name: pick(delta, "toolName name toolCallName") };
    }
    return { kind: "unknown", raw: frame };
  }
  if (type.startsWith("tool_execution_") || type === "tool_stream_update") {
    const phase = type === "tool_execution_start" ? "start" : type === "tool_execution_end" ? "end" : "update";
    const tasks = taskChildren(frame) || {};
    return {
      kind: "tool",
      phase,
      id: pick(frame, "toolCallId toolCallID callId id"),
      name: pick(frame, "toolName name tool"),
      args: pick(frame, "args input arguments parameters partialInput"),
      result: pick(frame, "result output content"),
      isError: frame.isError === true || !!frame.error,
      error: pick(frame, "error errorMessage"),
      children: tasks.children ?? null,
      async: tasks.async ?? null,
    };
  }
  if (type.startsWith("subagent_")) {
    return {
      kind: "subagent",
      phase: type.replace("subagent_", ""),
      id: pick(frame, "subagentId id agentId"),
      name: pick(frame, "subagentName name agent label"),
      status: pick(frame, "status state"),
      progress: pick(frame, "progress percent percentage"),
      detail: pick(frame, "detail message text summary"),
    };
  }
  if (type === "todo_reminder" || type === "todo_auto_clear") {
    return { kind: "todo", cleared: type === "todo_auto_clear", todos: pick(frame, "todos items todoPhases phases") };
  }
  if (type === "goal_updated") return { kind: "goal", goal: frame.goal ?? frame };
  return null;
}

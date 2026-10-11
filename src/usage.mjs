// usage.mjs — 跨 bot 用量汇总。
// 数据来源是每个 runtime 的 get_session_stats（omp 原生），字段按本机实测形状解析。

// omp get_session_stats 的真实形状（本机 omp 18.8.9 实测）：
//   { tokens: { input, output, reasoning, cacheRead, cacheWrite, total },
//     cost, userMessages, assistantMessages, toolCalls, contextUsage: {tokens,contextWindow,percent}, ... }
export function normalizeStats(stats) {
  if (!stats || typeof stats !== "object") return { raw: stats ?? null };
  const tk = stats.tokens && typeof stats.tokens === "object" ? stats.tokens : {};
  const num = (v) => (typeof v === "number" ? v : 0);
  const tokensIn = num(tk.input);
  const tokensOut = num(tk.output);
  const totalTokens = num(tk.total) || tokensIn + tokensOut;
  const cost = num(stats.cost);
  // 一次「请求」= 一条用户消息触发的一个回合。
  const requests = num(stats.userMessages);
  const ctx = stats.contextUsage && typeof stats.contextUsage === "object" ? stats.contextUsage : {};
  return {
    tokensIn,
    tokensOut,
    reasoning: num(tk.reasoning),
    totalTokens,
    cost,
    requests,
    toolCalls: num(stats.toolCalls),
    contextPercent: typeof ctx.percent === "number" ? ctx.percent : 0,
    raw: stats,
  };
}

/**
 * 汇总一个 Orchestrator 当前所有 runtime 的用量。
 * @param {import("./orchestrator.mjs").Orchestrator} orch
 * @returns {Promise<{perRuntime:Array, totals:object}>}
 */
export async function collectUsage(orch) {
  const perRuntime = [];
  const totals = { tokensIn: 0, tokensOut: 0, totalTokens: 0, cost: 0, requests: 0 };

  for (const [key, rt] of orch.runtimes) {
    const stats = await rt.getStats();
    const n = normalizeStats(stats);
    const [botId, scope] = key.split("::");
    const bot = orch.getBot(botId);
    perRuntime.push({
      botId,
      botName: bot?.name ?? botId,
      scope,
      model: bot?.model || "(default)",
      ...n,
    });
    totals.tokensIn += n.tokensIn ?? 0;
    totals.tokensOut += n.tokensOut ?? 0;
    totals.totalTokens += n.totalTokens ?? 0;
    totals.cost += n.cost ?? 0;
    totals.requests += n.requests ?? 0;
  }

  return { perRuntime, totals };
}

/** 把用量渲染成一张对齐的文本表。 */
export function renderUsageTable({ perRuntime, totals }) {
  if (!perRuntime.length) return "（尚无 runtime，无用量数据）";
  const cols = [
    ["bot", (r) => r.botName],
    ["scope", (r) => r.scope],
    ["model", (r) => r.model],
    ["reqs", (r) => String(r.requests ?? 0)],
    ["tokIn", (r) => String(r.tokensIn ?? 0)],
    ["tokOut", (r) => String(r.tokensOut ?? 0)],
    ["tokTotal", (r) => String(r.totalTokens ?? 0)],
    ["cost", (r) => (typeof r.cost === "number" ? r.cost.toFixed(4) : String(r.cost ?? 0))],
  ];
  const rows = [cols.map(([h]) => h), ...perRuntime.map((r) => cols.map(([, f]) => f(r)))];
  rows.push([
    "TOTAL",
    "",
    "",
    String(totals.requests),
    String(totals.tokensIn),
    String(totals.tokensOut),
    String(totals.totalTokens),
    totals.cost.toFixed(4),
  ]);
  const widths = cols.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r, ri) =>
      r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd() + (ri === 0 || ri === rows.length - 2 ? "\n" + widths.map((w) => "-".repeat(w)).join("  ") : ""),
    )
    .join("\n");
}

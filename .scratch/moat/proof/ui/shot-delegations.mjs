// 01 工作台：任务页「助手之间派的活」区块截图 + 状态文字检查。记录直接写进真实台账（不跑模型）。
// 运行：PLAYWRIGHT=<playwright 的 index.mjs> node omp-bot/.scratch/moat/proof/ui/shot-delegations.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright"); // 不是项目依赖，按本机位置传进来
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "shot-dlg-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home });
const a = orch.addBot({ name: "小总", role: "统筹", isMain: true });
const b = orch.addBot({ name: "小研", role: "查资料" });
const c = orch.addBot({ name: "阿码", role: "写代码" });
const t0 = Date.now() - 60_000;
const base = (id, from, to, message, extra) => ({ id, fromBotId: from.id, fromName: from.name, targetBotId: to.id, targetName: to.name, message, parentRunId: null, depth: 1, createdAt: t0, ...extra });
orch.ledger.put("delegations", base("dlg_queued", a, c, "把登录页的报错修掉", { state: "queued", delivery: null }));
orch.ledger.put("delegations", base("dlg_running", a, b, "查一下竞品这周的更新", { state: "running", childRunId: "run_child_1", startedAt: t0 + 1000 }));
orch.ledger.put("delegations", base("dlg_done", a, b, "写一份周报", { state: "returned", delivery: "delivered", childRunId: "run_child_2", wakeRunId: "run_wake_2", result: { state: "completed", reply: "周报写好了，放在 work/weekly.md", error: null }, returnedAt: t0 + 5000, deliveredAt: t0 + 5200 }));
orch.ledger.put("delegations", base("dlg_intr", a, c, "跑一遍回归测试", { state: "returned", delivery: "pending", childRunId: "run_child_3", result: { state: "interrupted", reply: null, error: null }, returnedAt: t0 + 7000 }));
orch.ledger.put("delegations", base("dlg_drop", a, c, "整理客户名单", { state: "returned", delivery: "dropped", dropReason: "visibility_revoked", childRunId: "run_child_4", result: { state: "completed", reply: "名单在 crm.csv", error: null }, returnedAt: t0 + 9000 }));

const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
const checks = [];
const errors = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && p !== "/api/models") errors.push(`${r.status()} ${p}`); });
  await page.goto(`${url}/#${token}`);
  await page.click("#btn-activity");
  await page.waitForSelector(".wb-delegation-list:not(.hidden)", { timeout: 10_000 });
  const label = await page.textContent(".wb-delegation-list .wb-dock-label");
  check("区块标题带数量", label === "助手之间派的活（5）", label);
  const states = await page.$$eval(".wb-delegation-list .wb-run-tile", (els) => els.map((e) => `${e.dataset.delegationId}=${e.querySelector(".wb-run-state").textContent}`));
  const want = { dlg_queued: "排队中", dlg_running: "在做", dlg_done: "做完了，已交回", dlg_intr: "重启中断了，等着交回", dlg_drop: "做完了，没交回" };
  for (const [id, text] of Object.entries(want)) check(`${id} 显示「${text}」`, states.includes(`${id}=${text}`), states.join(" | "));
  await page.locator(".wb-delegation-list").screenshot({ path: join(HERE, "delegations.png") });
  await page.click('.wb-run-tile[data-delegation-id="dlg_drop"] button');
  await page.waitForTimeout(400);
  const drawer = await page.textContent("body");
  check("详情写出没交回的原因", drawer.includes("两个助手已不在同一工作区"));
  check("详情保留结果供用户查看", drawer.includes("名单在 crm.csv"));
  await page.screenshot({ path: join(HERE, "delegation-detail.png") });
  check("没有页面错误或失败请求", errors.length === 0, errors.join("; "));
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
writeFileSync(join(HERE, "report.json"), JSON.stringify({ checks, errors }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);

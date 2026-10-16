// 07 工作台：派活详情显示验收标准。记录直接写进真实台账（不跑模型）。
// 运行：cd /data && PLAYWRIGHT=<playwright 的 index.mjs> node omp-bot/.scratch/moat/proof/ui/shot-handoff.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright"); // 不是项目依赖，按本机位置传进来
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "shot-handoff-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home });
const a = orch.addBot({ name: "小总", role: "统筹", isMain: true });
const b = orch.addBot({ name: "小研", role: "查资料" });
const t0 = Date.now() - 60_000;
const brief = "任务：写本周竞品周报。\n背景：周五例会要用。\n相关文件：work/competitors.md 是上周的版本。\n约束：只调研，不要改别的文件。";
const common = { fromBotId: a.id, fromName: a.name, targetBotId: b.id, targetName: b.name, parentRunId: null, depth: 1, createdAt: t0 };
orch.ledger.put("delegations", { id: "dlg_acc", ...common, message: brief, acceptance: ["周报在 work/weekly.md", "列出三条风险，每条带出处"], state: "returned", delivery: "delivered", childRunId: "run_c1", wakeRunId: "run_w1", result: { state: "completed", reply: "写好了，三条风险都带了出处", error: null }, returnedAt: t0 + 5000, deliveredAt: t0 + 5200 });
orch.ledger.put("delegations", { id: "dlg_plain", ...common, message: "查一下竞品这周的更新", state: "running", childRunId: "run_c2", startedAt: t0 + 1000 });

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
  await page.click('.wb-run-tile[data-delegation-id="dlg_acc"] button');
  await page.waitForTimeout(400);
  const body = await page.textContent("body");
  check("详情有验收标准一节", body.includes("验收标准"));
  const items = await page.$$eval(".wb-checklist > li", (els) => els.map((e) => e.textContent));
  check("逐条列出验收标准", items.join("|") === "周报在 work/weekly.md|列出三条风险，每条带出处", items.join("|"));
  check("简报原文照常显示", body.includes("约束：只调研，不要改别的文件。"));
  await page.screenshot({ path: join(HERE, "handoff-detail.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.click('.wb-run-tile[data-delegation-id="dlg_plain"] button');
  await page.waitForTimeout(400);
  const detail = await page.$$eval(".wb-detail", (els) => els.map((e) => e.textContent).join("|"));
  check("没带验收标准的不显示这一节", detail.includes("查一下竞品这周的更新") && !detail.includes("验收标准"), detail.slice(0, 120));
  check("没有页面错误或失败请求", errors.length === 0, errors.join("; "));
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
writeFileSync(join(HERE, "report-handoff.json"), JSON.stringify({ checks, errors }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);

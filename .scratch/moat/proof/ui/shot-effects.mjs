// 02 工作台：任务详情「外部动作」截图 + 文字检查。Run 和动作记录直接写进真实台账（不跑模型）。
// 运行：PLAYWRIGHT=<playwright 的 index.mjs> node omp-bot/.scratch/moat/proof/ui/shot-effects.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright"); // 不是项目依赖，按本机位置传进来
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "shot-eff-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home });
const bot = orch.addBot({ name: "阿码", role: "写代码", isMain: true });
const run = orch.ledger.createRun({ kind: "chat", botId: bot.id, scope: "private", text: "装好依赖再发布 build.zip" });
orch.ledger.updateRun(run.id, {
  state: "reconciliation_required",
  recovery: { status: "side_effect_unknown", reason: "in_flight_at_reconcile", at: Date.now() },
  sideEffects: [
    { id: "computer_shell#1", tool: "computer_shell", kind: "shell", status: "done", outcome: "ok" },
    { id: "computer_publish_file#1", tool: "computer_publish_file", kind: "publish", status: "done", outcome: "error", error: "目标不存在" },
    { id: "computer_install_packages#1", tool: "computer_install_packages", kind: "install_packages", status: "unknown", outcome: "unknown" },
  ],
});

const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
const checks = [];
const errors = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && p !== "/api/models") errors.push(`${r.status()} ${p}`); });
  await page.goto(`${url}/#${token}`);
  await page.click("#btn-activity");
  await page.waitForSelector(`.wb-run-tile[data-run-id="${run.id}"]`, { timeout: 10_000 });
  await page.click(`.wb-run-tile[data-run-id="${run.id}"] button`);
  await page.waitForSelector(".wb-effect-list", { timeout: 5_000 });
  const rows = await page.$$eval(".wb-effect-list > *", (els) => els.map((e) => `${e.dataset.effectStatus}|${e.textContent}`));
  check("三笔动作都列出", rows.length === 3, rows.join(" / "));
  check("未知那笔写明要人工核对", rows.some((r) => r.startsWith("unknown|") && r.includes("computer_install_packages") && r.includes("结果未知，要人工核对")));
  check("明确失败那笔写出原因", rows.some((r) => r.includes("做完了，报错：目标不存在")));
  await page.screenshot({ path: join(HERE, "effects-detail.png") });
  // 这台机器没有 omp，原生会话接口会 500。详情要照样出来，只在技术信息那块报读取失败。
  check("原生会话读不出来时只那一块报错", (await page.textContent("#drawer-body")).includes("读取失败"));
  const unexpected = errors.filter((e) => !/^500 \/api\/bots\/[^/]+\/native\//.test(e));
  check("除原生会话外没有页面错误或失败请求", unexpected.length === 0, unexpected.join("; "));
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
writeFileSync(join(HERE, "report-effects.json"), JSON.stringify({ checks, errors }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);

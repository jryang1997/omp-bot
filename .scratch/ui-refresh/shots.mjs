// UI 重构的全页面截图：真实服务 + 假运行时（不跑模型），造一组接近日常的数据，逐个视图截图。
// 用法：cd /data && PLAYWRIGHT=/vercel/sandbox/node_modules/playwright/index.mjs node omp-bot/.scratch/ui-refresh/shots.mjs <输出目录名>
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(HERE, process.argv[2] || "before");
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../src/server.mjs", import.meta.url).href);
const { FakeRuntime } = await import(new URL("../../test/_harness.mjs", import.meta.url).href);

const runtimes = new Map();
const home = mkdtempSync(join(tmpdir(), "ui-shots-"));
const { url, token, orch, close } = await startServer({
  port: 0, host: "127.0.0.1", home,
  runtimeFactory: (o) => { const r = new FakeRuntime(o); runtimes.set(o.bot?.id ?? o.botId, r); return r; },
});
const main = orch.addBot({ name: "小总", role: "统筹", isMain: true });
const res = orch.addBot({ name: "小研", role: "查资料" });
const dev = orch.addBot({ name: "阿码", role: "写代码" });
const say = async (bot, text, reply) => {
  const rt = await orch.runtimeFor(bot.id, "private");
  rt.queue.push({ kind: "complete", text: reply });
  return orch.waitRun(orch.startRun({ botId: bot.id, text }).id);
};
await say(main, "帮我看看这周竞品有什么更新", "好的，我让小研去查了，大概十分钟后给你结果。\n\n这周值得注意的有三件事：\n\n1. **Grok Bot** 上线了多 Bot 互相交接\n2. **Paseo** 发布了 handoff 技能\n3. **dots** 开放了企业档\n\n要我整理成周报吗？");
await say(main, "整理成周报，周五前给我", "收到。周报会放在 `work/weekly.md`，周五下午五点前交给你。");
await say(dev, "把登录页的报错修掉", "修好了：表单提交时没带 CSRF token，补上后本地回归通过。改动在 `web/login.js`。");
const t0 = Date.now() - 60_000;
const common = (from, to) => ({ fromBotId: from.id, fromName: from.name, targetBotId: to.id, targetName: to.name, parentRunId: null, depth: 1, createdAt: t0 });
orch.ledger.put("delegations", { id: "dlg_acc", ...common(main, res), message: "任务：写本周竞品周报。\n背景：周五例会要用。\n相关文件：work/competitors.md 是上周的版本。\n约束：只调研，不要改别的文件。", acceptance: ["周报在 work/weekly.md", "列出三条风险，每条带出处"], state: "returned", delivery: "delivered", childRunId: "run_c1", wakeRunId: "run_w1", result: { state: "completed", reply: "写好了，三条风险都带了出处", error: null }, startedAt: t0 + 800, returnedAt: t0 + 5000, deliveredAt: t0 + 5200 });
orch.ledger.put("delegations", { id: "dlg_run", ...common(main, dev), message: "跑一遍回归测试", state: "running", childRunId: "run_c2", startedAt: t0 + 1000 });
const fx = orch.ledger.createRun({ kind: "chat", botId: dev.id, scope: "private", text: "装好依赖再发布 build.zip" });
orch.ledger.updateRun(fx.id, { state: "reconciliation_required", recovery: { status: "side_effect_unknown", reason: "in_flight_at_reconcile", at: Date.now() }, sideEffects: [
  { id: "computer_shell#1", tool: "computer_shell", kind: "shell", status: "done", outcome: "ok" },
  { id: "computer_install_packages#1", tool: "computer_install_packages", kind: "install_packages", status: "unknown", outcome: "unknown" },
] });
try { orch.proposeTeamFact?.({ botId: res.id, fact: "周报每周五下午五点前交", source: "私聊里用户说的" }); } catch {}

const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
const errors = [];
const shot = async (page, name) => { await page.waitForTimeout(450); await page.screenshot({ path: join(OUT, `${name}.png`) }); console.log("shot", name); };
const safe = async (name, fn) => { try { await fn(); } catch (e) { console.log("SKIP", name, e.message.split("\n")[0]); } };
async function session(viewport, dark, prefix) {
  const ctx = await browser.newContext({ viewport, colorScheme: dark ? "dark" : "light", deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${prefix} ${e.message}`));
  await page.goto(`${url}/#${token}`);
  await page.waitForTimeout(800);
  if (dark) await safe("theme", async () => { const isDark = await page.evaluate(() => document.body.hasAttribute("data-ds-dark-theme")); if (!isDark) await page.click("#btn-theme"); });
  await safe("chat", async () => { await page.getByText("小总", { exact: true }).first().click(); await shot(page, `${prefix}01-chat`); });
  if (viewport.width < 600) {
    // 手机上侧栏收起，直接点按钮的 DOM 进任务页。
    await safe("m-tasks", async () => { await page.evaluate(() => document.getElementById("btn-activity").click()); await page.waitForSelector(".wb-delegation-list:not(.hidden)", { timeout: 8000 }); await shot(page, `${prefix}02-tasks`); });
    await safe("m-run", async () => { await page.click(`.wb-run-tile[data-run-id="${fx.id}"] button`); await shot(page, `${prefix}03-run-detail`); });
    await ctx.close(); return;
  }
  await safe("settings", async () => { await page.click("#btn-settings"); await shot(page, `${prefix}06-settings`); await page.click("#drawer-close"); });
  await safe("computer", async () => { await page.click("#btn-computer"); await shot(page, `${prefix}07-computer`); await page.click("#drawer-close"); });
  await safe("perm", async () => { await page.click("#btn-permissions"); await shot(page, `${prefix}08-permissions`); await page.keyboard.press("Escape"); await page.click("#drawer-close").catch(() => {}); await page.click("#modal-close").catch(() => {}); });
  await safe("tasks", async () => { await page.click("#btn-activity"); await page.waitForSelector(".wb-delegation-list:not(.hidden)", { timeout: 8000 }); await shot(page, `${prefix}02-tasks`); });
  await safe("run", async () => { await page.click(`.wb-run-tile[data-run-id="${fx.id}"] button`); await shot(page, `${prefix}03-run-detail`); await page.click("#drawer-close"); });
  await safe("dlg", async () => { await page.click('.wb-run-tile[data-delegation-id="dlg_acc"] button'); await shot(page, `${prefix}04-delegation-detail`); await page.click("#drawer-close"); });
  await safe("usage", async () => { await page.click("#btn-usage"); await shot(page, `${prefix}05-usage`); });
  await ctx.close();
}
try {
  await session({ width: 1440, height: 900 }, false, "");
  await session({ width: 1440, height: 900 }, true, "dark-");
  await session({ width: 390, height: 844 }, false, "m-");
} finally {
  await browser.close();
  await close();
}
console.log("errors:", errors.length ? errors.join(" | ") : "none");
process.exit(0);

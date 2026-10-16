// 任务页紧凑行的行为检查：页签数量和列表对得上、整行可点、键盘能开、停止不误开详情、行够矮。
// 用法：cd /data && PLAYWRIGHT=/vercel/sandbox/node_modules/playwright/index.mjs node omp-bot/.scratch/ui-refresh/tasks-check.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../src/server.mjs", import.meta.url).href);
const { FakeRuntime } = await import(new URL("../../test/_harness.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "ui-tasks-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home, runtimeFactory: (o) => new FakeRuntime(o) });
const main = orch.addBot({ name: "小总", role: "统筹", isMain: true });
const res = orch.addBot({ name: "小研", role: "查资料" });
const dev = orch.addBot({ name: "阿码", role: "写代码" });
const done = orch.ledger.createRun({ kind: "chat", botId: main.id, scope: "private", text: "整理成周报" });
orch.ledger.updateRun(done.id, { state: "completed", reply: "好了" });
const failed = orch.ledger.createRun({ kind: "chat", botId: dev.id, scope: "private", text: "装好依赖再发布" });
orch.ledger.updateRun(failed.id, { state: "failed", error: "网络断了" });
const live = orch.ledger.createRun({ kind: "chat", botId: dev.id, scope: "private", text: "跑一遍回归\n测试" });
orch.ledger.updateRun(live.id, { state: "running" });
const t0 = Date.now() - 60_000;
orch.ledger.put("delegations", { id: "dlg_a", fromBotId: main.id, fromName: "小总", targetBotId: res.id, targetName: "小研", depth: 1, createdAt: t0, message: "写周报", state: "returned", delivery: "delivered", result: { state: "completed", reply: "写好了" } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`); };
const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}/#${token}`);
  await page.click("#btn-activity");
  await page.waitForSelector(".wb-delegation-list:not(.hidden)", { timeout: 10_000 });
  const drawerOpen = () => page.evaluate(() => !document.getElementById("drawer").classList.contains("hidden"));
  const title = () => page.textContent("#drawer-title");

  for (const id of ["active", "completed", "failed"]) {
    await page.click(`.bt-tab[data-filter="${id}"]`);
    const count = Number(await page.textContent(`.wb-tab-count[data-metric="${id}"]`));
    const rows = await page.locator(".wb-run-list > .wb-row").count();
    check(`「${id}」页签数量和列表一致`, count === rows && rows > 0, `${count} vs ${rows}`);
  }
  check("数量为 0 的页签不显示数字", await page.locator('.wb-tab-count[data-metric="attention"]').isHidden());
  await page.click('.bt-tab[data-filter="all"]');
  check("列表里没有「详情」链接", !(await page.evaluate(() => [...document.querySelectorAll(".wb-run-list, .wb-delegation-list")].map((n) => n.innerText).join(""))).includes("详情"));
  const text = await page.textContent(`.wb-row[data-run-id="${live.id}"] .wb-run-text`);
  check("多行内容压成一行", text === "跑一遍回归 测试", text);
  const box = await page.locator(`.wb-row[data-run-id="${done.id}"]`).boundingBox();
  check("行高不超过 64px", box.height <= 64, String(box.height));

  await page.click(`.wb-row[data-run-id="${failed.id}"] .wb-run-text`);
  await page.waitForTimeout(300);
  check("点行里的文字就打开详情", (await drawerOpen()) && (await title()) === "阿码的任务", await title());
  await page.click("#drawer-close");
  await page.waitForTimeout(300);

  await page.focus(`.wb-row[data-run-id="${done.id}"] .wb-row-main`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check("键盘回车也能打开", (await drawerOpen()) && (await title()) === "小总的任务", await title());
  await page.click("#drawer-close");
  await page.waitForTimeout(300);

  check("只有进行中的行有停止", (await page.locator(".wb-row-stop").count()) === 1);
  await page.click(`.wb-row[data-run-id="${live.id}"] .wb-row-stop`);
  await page.waitForTimeout(300);
  check("点停止不会打开详情", !(await drawerOpen()));

  await page.click('.wb-row[data-delegation-id="dlg_a"] .wb-row-main');
  await page.waitForTimeout(300);
  check("派活行打开后标题写谁派给谁", (await title()) === "小总 → 小研", await title());
  check("没有页面错误", errors.length === 0, errors.join("; "));
} finally {
  await browser.close();
  await close();
}
console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);

// 10 电脑面板的「旧电脑」行：复制进度、出错重试、删除前确认。后端用替身，HTTP 接口和前端是真的。
// 运行：PLAYWRIGHT=<playwright 的 index.mjs> CHROME=<chromium> node .scratch/team-rebuild/proof/old/shot-old-panel.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);
const { computerIdFor } = await import(new URL("../../../../src/domain.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "shot-old-panel-"));
const calls = [];
let old = [];
const stopped = { state: "stopped", display: null, error: null, vm: { state: "stopped" }, seat: { ready: false } };
const backend = {
  imageFile: null,
  async status() { return stopped; },
  async create() { return stopped; },
  async start() { return stopped; },
  async stop() { return stopped; },
  async screenshot() { throw new Error("no screen"); },
  oldComputers() { return old.map((x) => ({ ...x })); },
  async retryOld(id) { calls.push(`retry ${id}`); old = old.map((x) => (x.id === id ? { ...x, state: "copying", step: "打包", error: null } : x)); return this.oldComputers(); },
  async removeOld(id) { calls.push(`remove ${id}`); old = old.filter((x) => x.id !== id); return this.oldComputers(); },
  async close() {},
};
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home, computerBackend: backend });
const bot = orch.addBot({ name: "阿码", role: "写代码" });
orch.updateBot(bot.id, { permission: "full", confirmPermission: true });
const cid = computerIdFor(bot.id);
old = [
  { id: cid, botId: bot.id, state: "error", step: null, error: { code: "computer_guest_rpc_failed", message: "打包：旧电脑打包失败（退出码 2）：tar: /work: No space left on device" }, copiedAt: null, files: null, bytes: null },
  { id: "pc_gone", botId: null, state: "orphan", step: null, error: null, copiedAt: null, files: null, bytes: null },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const report = { checks: [], errors: [], calls };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await ctx.newPage();
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); void (dialogs.length === 1 ? d.dismiss() : d.accept()); });
page.on("pageerror", (e) => report.errors.push(e.message));
page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && !["/api/models", "/api/computer/screen"].includes(p) && !p.endsWith("/screen")) report.errors.push(`${r.status()} ${p}`); });
const oldText = () => page.locator(".wb-old").first().innerText();
try {
  await page.goto(`${url}/#${token}`);
  await page.getByText("阿码", { exact: true }).first().click();
  await page.click("#btn-settings");
  await page.getByText("看这位助手的桌面画面", { exact: false }).first().click();
  await page.waitForSelector(".wb-old .wb-old-item", { timeout: 10_000 });
  let text = await oldText();
  check("有旧电脑时显示「旧电脑」行，出错的写明哪一步错了", /复制出错：打包：旧电脑打包失败/.test(text), text.split("\n")[0]);
  check("助手已删的旧电脑也列出来", /pc_gone：它的助手已经删了，文件没有复制/.test(text));
  await page.locator(".wb-old").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(HERE, "panel-old-error.png") });

  await page.getByRole("button", { name: "重试复制" }).click();
  await page.waitForFunction(() => document.querySelector(".wb-old")?.innerText.includes("正在复制：打包"), null, { timeout: 10_000 });
  check("点「重试复制」后显示进度，复制中没有删除按钮", calls.includes(`retry ${cid}`) && (await page.locator(".wb-old-item").first().getByRole("button", { name: "删除旧电脑" }).count()) === 0);

  old = old.map((x) => (x.id === cid ? { ...x, state: "done", step: null, copiedAt: new Date().toISOString(), files: 42 } : x));
  await page.waitForFunction(() => document.querySelector(".wb-old")?.innerText.includes("已复制到 ~/old-computer/（42 个文件"), null, { timeout: 10_000 });
  check("轮询到复制完成：已复制到 ~/old-computer/，带文件数和时间", true);
  await page.screenshot({ path: join(HERE, "panel-old-done.png") });

  const del = page.locator(".wb-old-item").first().getByRole("button", { name: "删除旧电脑" });
  await del.click();
  await page.waitForTimeout(300);
  check("删除前要确认，取消就不删", dialogs.length === 1 && /不能恢复/.test(dialogs[0]) && /已经复制到 ~\/old-computer\/ 的文件不受影响/.test(dialogs[0]) && !calls.some((c) => c.startsWith("remove")), dialogs[0] ?? "");
  await del.click();
  await page.waitForFunction(() => !document.querySelector(".wb-old")?.innerText.includes("已复制到"), null, { timeout: 10_000 });
  check("确认后删除", calls.includes(`remove ${cid}`));
  const orphanDel = page.locator(".wb-old-item").first().getByRole("button", { name: "删除旧电脑" });
  await orphanDel.click();
  await page.waitForFunction(() => document.querySelector(".bt-set-row:has(.wb-old)")?.hidden === true, null, { timeout: 10_000 });
  check("没复制的旧电脑删除时提醒文件还没复制；都删完「旧电脑」行隐藏", /还没有复制进共享电脑/.test(dialogs[2] ?? "") && calls.includes("remove pc_gone"), dialogs[2] ?? "");
  check("页面没有报错和失败请求", report.errors.length === 0, report.errors.join("; "));
} catch (e) {
  check("脚本跑完", false, String(e?.message ?? e));
} finally {
  writeFileSync(join(HERE, "panel-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await page.close();
  await browser.close();
  await close();
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`${report.checks.length - failed}/${report.checks.length} PASS`);
  process.exit(failed ? 1 : 0);
}

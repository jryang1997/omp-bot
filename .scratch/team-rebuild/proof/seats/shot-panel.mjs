// 07 电脑面板：座席文案、共享电脑状态和规格行。后端用替身，规格接口是真的。
// 运行：PLAYWRIGHT=<playwright 的 index.mjs> CHROME=<chromium> node .scratch/team-rebuild/proof/seats/shot-panel.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "shot-seat-panel-"));
const states = new Map();
const backend = {
  imageFile: null,
  async status(id) {
    return states.get(id) ?? { state: "stopped", display: null, error: null, vm: { state: "stopped" }, seat: { ready: false } };
  },
  async create(id) {
    states.set(id, { state: "running", display: { width: 1280, height: 800 }, error: null, vm: { state: "running" }, seat: { ready: true } });
    return states.get(id);
  },
  async start(id) { return this.create(id); },
  async stop(id) {
    states.set(id, { state: "stopped", display: null, error: null, vm: { state: "running" }, seat: { ready: false } });
    return states.get(id);
  },
  async screenshot() { return { data: readFileSync(join(HERE, "seat-a.png")), mimeType: "image/png", width: 1280, height: 800 }; },
  async close() {},
};
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home, computerBackend: backend });
const bot = orch.addBot({ name: "阿码", role: "写代码" });
orch.updateBot(bot.id, { permission: "full", confirmPermission: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const report = { checks: [], errors: [] };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => report.errors.push(e.message));
page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && p !== "/api/models") report.errors.push(`${r.status()} ${p}`); });
try {
  await page.goto(`${url}/#${token}`);
  await page.getByText("阿码", { exact: true }).first().click();
  await page.click("#btn-settings");
  await page.getByText("看这位助手的桌面画面", { exact: false }).first().click();
  await page.waitForSelector(".wb-computer", { timeout: 10_000 });
  await page.waitForTimeout(800);
  const drawer = page.locator(".wb-computer");
  let text = await drawer.innerText();
  check("未绑定时说明是共享电脑上的座席", /共享电脑上给本 Bot 开一个座席/.test(text));
  check("规格行显示默认值和下次开机生效", /共享电脑规格/.test(text) && /GiB 动态磁盘/.test(text) && /下次开机生效/.test(text), text.match(/现在是[^。]+。/)?.[0] ?? "");
  await drawer.screenshot({ path: join(HERE, "panel-unbound.png") });

  await page.getByRole("button", { name: "绑定电脑" }).click();
  await page.waitForFunction(() => document.querySelector(".wb-computer")?.innerText.includes("共享电脑的座席"), null, { timeout: 10_000 });
  text = await drawer.innerText();
  check("绑定后状态行有座席和共享电脑状态", /Linux 共享电脑的座席/.test(text) && /共享电脑\s*运行中/.test(text));

  const mem = page.locator('select[aria-label="共享电脑内存"]');
  const options = await mem.locator("option").allInnerTexts();
  check("内存可选 4 到 16 GiB", options[0] === "4 GiB 内存" && options.at(-1) === "16 GiB 内存", `${options.length} 档`);
  await mem.selectOption("12");
  await page.getByRole("button", { name: "保存规格" }).click();
  await page.waitForFunction(() => document.querySelector(".wb-computer")?.innerText.includes("12 GiB 内存、"), null, { timeout: 10_000 });
  const saved = JSON.parse(readFileSync(join(home, "computers", "shared-machine.json"), "utf8"));
  check("保存规格写进 shared-machine.json", saved.memoryGb === 12, JSON.stringify(saved));
  await drawer.screenshot({ path: join(HERE, "panel-bound.png") });

  await page.getByRole("button", { name: "停止" }).click();
  await page.waitForFunction(() => document.querySelector(".wb-computer")?.innerText.includes("座席已停止，共享电脑还开着"), null, { timeout: 10_000 });
  check("停一个座席时提示共享电脑还开着", true);
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

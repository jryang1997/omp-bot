// 09 登录屏面板：在 Bot 的电脑面板点「登录网站」，自动打开登录屏，点屏幕送输入，点「完成」发布。
// 后端用替身（座席层另有 login-e2e.mjs 跑真的），HTTP 接口和前端是真的。
// 运行：PLAYWRIGHT=<playwright 的 index.mjs> CHROME=<chromium> node .scratch/team-rebuild/proof/login/shot-login-panel.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "shot-login-panel-"));
const states = new Map();
const calls = [];
const stopped = { state: "stopped", display: null, error: null, vm: { state: "running" }, seat: { ready: false } };
const running = { state: "running", display: { width: 1280, height: 800 }, error: null, vm: { state: "running" }, seat: { ready: true } };
const backend = {
  imageFile: null,
  async status(id) { return states.get(id) ?? stopped; },
  async create(id) { states.set(id, running); return running; },
  async start(id) { return this.create(id); },
  async stop(id) { calls.push(`stop:${id}`); states.set(id, stopped); return stopped; },
  async openLogin() { calls.push("openLogin"); states.set("login", running); return running; },
  async publishLogin() { calls.push("publishLogin"); states.set("login", stopped); return { publishedAt: "2025-10-16T04:12:00.000Z", status: stopped }; },
  async input(id, action) { calls.push(`input:${id}:${action.action}`); },
  async screenshot() { return { data: readFileSync(join(HERE, "login-screen.png")), mimeType: "image/png", width: 1280, height: 800 }; },
  async close() {},
};
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home, computerBackend: backend });
const bot = orch.addBot({ name: "阿码", role: "写代码" });
orch.updateBot(bot.id, { permission: "full", confirmPermission: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const report = { checks: [], errors: [], calls };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => report.errors.push(e.message));
page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && p !== "/api/models") report.errors.push(`${r.status()} ${p}`); });
try {
  await page.goto(`${url}/#${token}`);
  await page.getByText("阿码", { exact: true }).first().click();
  await page.click("#btn-settings");
  await page.getByText("看这位助手的桌面画面", { exact: false }).first().click();
  await page.waitForSelector(".wb-computer", { timeout: 10_000 });
  const drawer = page.locator(".wb-computer").first();
  check("Bot 面板有「网站登录」行", /网站登录所有 Bot 共用/.test(await drawer.innerText()));

  await page.getByRole("button", { name: "登录网站" }).click();
  const view = page.locator(".wb-computer-login .wb-computer");
  await page.waitForFunction(() => document.querySelector(".wb-computer-login")?.innerText.includes("你在操作"), null, { timeout: 10_000 });
  check("点「登录网站」就打开登录屏，不用再点一次", calls.includes("openLogin"), calls.join(","));
  const text = await view.innerText();
  check("登录屏只有打开、完成、关闭不保存", /完成/.test(text) && /关闭不保存/.test(text) && !/绑定电脑/.test(text) && !/共享电脑规格/.test(text));
  check("登录屏说明只同步 cookie，开着就是用户在操作，不用接管", /只同步 cookie/.test(text) && /你在操作/.test(text) && /直接在画面上点击/.test(text) && !/接管后才能/.test(text));
  const img = view.locator("img").first();
  await img.waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".wb-computer-login img")].some((i) => i.naturalWidth > 0), null, { timeout: 10_000 });
  check("登录屏显示实时画面", true);
  await img.click({ position: { x: 300, y: 40 } });
  await page.waitForFunction(() => true);
  for (let i = 0; i < 30 && !calls.includes("input:login:click"); i += 1) await page.waitForTimeout(100);
  check("点登录屏的画面会把输入送到登录屏", calls.includes("input:login:click"), calls.filter((c) => c.startsWith("input")).join(","));
  await view.scrollIntoViewIfNeeded();
  const over = await page.evaluate(() => { const h = document.querySelector(".wb-computer-login"); return h ? h.scrollWidth - h.clientWidth : -1; });
  check("登录屏视图不横向溢出", over <= 1, `溢出 ${over}px`);
  await page.screenshot({ path: join(HERE, "panel-login-open.png") });

  await view.getByRole("button", { name: "完成" }).click();
  await page.waitForFunction(() => /已发布|发布于|登录已/.test(document.querySelector(".wb-computer-login")?.innerText ?? ""), null, { timeout: 10_000 }).catch(() => {});
  const after = await view.innerText();
  const saved = JSON.parse(readFileSync(join(home, "computers", "login.json"), "utf8"));
  check("点「完成」发布并写 login.json", calls.includes("publishLogin") && saved.publishedAt === "2025-10-16T04:12:00.000Z" && /已停止/.test(after) && !/还没有发布过/.test(after), after.match(/上次发布\s*\S+/)?.[0] ?? "");
  await page.screenshot({ path: join(HERE, "panel-login-done.png") });

  await page.getByRole("button", { name: "收起登录屏" }).click();
  check("收起后登录屏视图移除", (await page.locator(".wb-computer-login .wb-computer").count()) === 0);
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

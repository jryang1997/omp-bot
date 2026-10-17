// 新 logo 的界面核对 + README 首页截图：起真服务、真浏览器。
// 跑法：cd /data/omp-bot && node .scratch/logo/shot.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startServer } from "../../src/server.mjs";
const { chromium } = createRequire(process.env.PW_FROM || "/vercel/sandbox/")("playwright");

const home = mkdtempSync(join(tmpdir(), "ompbot-logo-shot-"));
const { url, token, close } = await startServer({ port: 0, host: "127.0.0.1", home });
const api = async (path, method = "GET", body) => (await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json();
let fails = 0;
const check = (name, ok, ev = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ev ? ` ${ev}` : ""}`); };

const main = (await api("/api/bots", "POST", { name: "小助", role: "主持", isMain: true })).bot;
const ids = [main.id];
for (const [name, role] of [["阿查", "查资料"], ["周周", "写周报"], ["小码", "写代码"]]) ids.push((await api("/api/bots", "POST", { name, role })).bot.id);
await api("/api/rooms", "POST", { name: "周会小组", members: ids });

const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`${url}/#${token}`);
  await page.waitForSelector(".omp-avatar-face img");
  await page.waitForTimeout(600);
  const imgs = await page.$$eval(".brand-icon, .welcome-symbol img", (els) => els.map((i) => ({ src: i.getAttribute("src"), ok: i.complete && i.naturalWidth > 0 })));
  check("侧栏用单人版且画出来了", imgs[0]?.src === "assets/app-mark.svg" && imgs[0].ok, JSON.stringify(imgs[0]));
  check("欢迎页用群像且画出来了", imgs[1]?.src === "assets/app-icon.svg" && imgs[1].ok, JSON.stringify(imgs[1]));
  const fav = await page.$eval('link[rel="icon"]', (l) => l.href);
  check("favicon 能取到", (await fetch(fav)).ok, fav.replace(url, ""));
  check("没有页面报错", errors.length === 0, errors.join("; "));
  await page.screenshot({ path: "docs/images/screenshot.png" });
  await page.locator(".brand-icon").screenshot({ path: ".scratch/logo/brand.png" });
} finally {
  await browser.close(); await close();
}
process.exit(fails ? 1 : 0);

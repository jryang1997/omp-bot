// 设置抽屉检查：「更多设置」只在设置页底部和子页出现，子页之间能切换；说明都在一句话左右；看不到 Bot、座席这类词。
// 用法：cd /data && PLAYWRIGHT=/vercel/sandbox/node_modules/playwright/index.mjs node omp-bot/.scratch/ui-refresh/settings-check.mjs
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../src/server.mjs", import.meta.url).href);
const { FakeRuntime } = await import(new URL("../../test/_harness.mjs", import.meta.url).href);
const home = mkdtempSync(join(tmpdir(), "ui-settings-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home, runtimeFactory: (o) => new FakeRuntime(o) });
orch.addBot({ name: "小总", role: "统筹", isMain: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`); };
const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}/#${token}`);
  await page.getByText("小总", { exact: true }).first().click();
  await page.click("#btn-settings");
  await page.waitForSelector("#drawer-body .wb-panel-body");
  const order = await page.evaluate(() => [...document.querySelectorAll("#drawer-body details.ui-disclosure > summary")].map((n) => n.textContent));
  check("设置页里「更多设置」在「记录维护」前面", order.indexOf("更多设置") >= 0 && order.indexOf("更多设置") < order.indexOf("记录维护"), order.join(","));
  const firstAfterTabs = await page.evaluate(() => document.querySelector("#drawer-body > .bt-tabs").nextElementSibling.className);
  check("页签下面紧跟内容，不是折叠条", firstAfterTabs.includes("wb-panel-body"), firstAfterTabs);

  const words = [];
  for (const tab of ["设置", "使用权限", "电脑", "计划"]) {
    await page.click(`#drawer-body > .bt-tabs .bt-tab:has-text("${tab}")`);
    await page.waitForTimeout(500);
    const hasMore = await page.evaluate(() => [...document.querySelectorAll("#drawer-body summary")].some((n) => n.textContent === "更多设置"));
    if (tab !== "设置") check(`「${tab}」页没有「更多设置」`, !hasMore);
    const info = await page.evaluate(() => {
      const visible = (n) => n.getClientRects().length && !n.closest("details:not([open])");
      const hints = [...document.querySelectorAll("#drawer-body .bt-set-hint, #drawer-body .ui-intro, #drawer-body .hint")].filter(visible).map((n) => n.textContent.trim());
      return { hints, text: document.getElementById("drawer-body").innerText };
    });
    const long = info.hints.filter((h) => h.length > 40);
    check(`「${tab}」页说明都不超过 40 字`, long.length === 0, long.join(" | "));
    for (const w of ["Bot", "座席", "vCPU 上限", "原生"]) if (info.text.includes(w)) words.push(`${tab}:${w}`);
  }
  check("看得见的文字里没有 Bot、座席、原生这类词", words.length === 0, words.join(","));

  await page.click('#drawer-body > .bt-tabs .bt-tab:has-text("设置")');
  await page.waitForTimeout(300);
  await page.click('#drawer-body summary:has-text("更多设置")');
  await page.click('#drawer-body .ui-disclosure .bt-set-row:has-text("技能")');
  await page.waitForTimeout(500);
  const sub = await page.evaluate(() => {
    const more = [...document.querySelectorAll("#drawer-body > details.ui-disclosure")].find((n) => n.querySelector("summary").textContent === "更多设置");
    return { last: document.getElementById("drawer-body").lastElementChild === more, current: more?.querySelector('[aria-current="page"]')?.textContent || "" };
  });
  check("子页里「更多设置」放在最后，并标出当前页", sub.last && sub.current.startsWith("技能"), JSON.stringify(sub));
  await page.click('#drawer-body .ui-disclosure .bt-set-row:has-text("记忆")');
  await page.waitForTimeout(500);
  check("子页之间能直接切换", await page.evaluate(() => document.querySelector('#drawer-body [aria-current="page"]')?.textContent.startsWith("记忆")));
  check("没有页面错误", errors.length === 0, errors.join("; "));
  // 没渲染到的状态（比如助手正在用电脑）也算：扫一遍前端源码里给人看的字符串。
  const webDir = new URL("../../web/", import.meta.url);
  const hits = [];
  for (const file of readdirSync(webDir).filter((f) => f.endsWith(".js"))) {
    readFileSync(new URL(file, webDir), "utf8").split("\n").forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (/[\u4e00-\u9fff]\s?Bot|Bot\s?[\u4e00-\u9fff]/u.test(code.replace(/OMP Bot/g, ""))) hits.push(`${file}:${i + 1}`);
    });
  }
  check("前端源码里给人看的字符串不叫 Bot", hits.length === 0, hits.join(", "));
} finally {
  await browser.close();
  await close();
}
console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);

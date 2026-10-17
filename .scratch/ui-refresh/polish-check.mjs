// 第 6 步检查：手机上任务页签不被截掉；设置里的开关是右侧开关；电脑规格下拉框是圆角输入框；暗色下文字够清楚。
// 用法：cd /data && PLAYWRIGHT=/vercel/sandbox/node_modules/playwright/index.mjs node omp-bot/.scratch/ui-refresh/polish-check.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../src/server.mjs", import.meta.url).href);
const { FakeRuntime } = await import(new URL("../../test/_harness.mjs", import.meta.url).href);
const home = mkdtempSync(join(tmpdir(), "ui-polish-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home, runtimeFactory: (o) => new FakeRuntime(o) });
const main = orch.addBot({ name: "小总", role: "统筹", isMain: true });
const rt = await orch.runtimeFor(main.id, "private");
rt.queue.push({ kind: "complete", text: "好" }, { kind: "error", message: "坏了" });
await orch.waitRun(orch.startRun({ botId: main.id, text: "一" }).id);
await orch.waitRun(orch.startRun({ botId: main.id, text: "二" }).id).catch(() => {});

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`); };
// 相对亮度对比度（WCAG），颜色取 computed rgb。
const contrast = (a, b) => {
  const lum = (c) => { const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
try {
  const mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await mobile.goto(`${url}/#${token}`);
  await mobile.waitForSelector("#btn-activity", { state: "attached" });
  await mobile.evaluate(() => document.getElementById("btn-activity").click());
  await mobile.waitForSelector(".wb-task-bar .bt-tab");
  const tabs = await mobile.evaluate(() => {
    const bar = document.querySelector(".wb-task-bar > .bt-tabs").getBoundingClientRect();
    return [...document.querySelectorAll(".wb-task-bar .bt-tab")].map((t) => { const r = t.getBoundingClientRect(); return { text: t.innerText.replace(/\s+/g, ""), inside: r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5 && r.right <= innerWidth }; });
  });
  check("手机：五个页签都完整露出来", tabs.length === 5 && tabs.every((t) => t.inside), JSON.stringify(tabs));
  await mobile.close();

  for (const scheme of ["light", "dark"]) {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}/#${token}`);
    await page.getByText("小总", { exact: true }).first().click();
    await page.click("#btn-settings");
    await page.waitForSelector("#drawer-body .wb-panel-body");
    await page.click('#drawer-body > .bt-tabs .bt-tab:has-text("使用权限")');
    await page.waitForSelector('#drawer-body input[type=checkbox]');
    const sw = await page.evaluate(() => {
      const input = document.querySelector("#drawer-body .bt-set-control > input[type=checkbox]");
      const row = input.closest(".bt-set-row");
      const title = row.querySelector(".bt-set-copy").getBoundingClientRect();
      const r = input.getBoundingClientRect();
      return { appearance: getComputedStyle(input).appearance, w: Math.round(r.width), h: Math.round(r.height), sameRow: r.top < title.bottom && r.left > title.right - 1, right: Math.round(row.getBoundingClientRect().right - r.right) };
    });
    check(`${scheme}：记忆开关是右侧的开关`, sw.appearance === "none" && sw.w === 40 && sw.h === 24 && sw.sameRow && sw.right < 24, JSON.stringify(sw));
    const before = await page.$eval("#drawer-body .bt-set-control > input[type=checkbox]", (n) => getComputedStyle(n).backgroundColor);
    await page.$eval("#drawer-body .bt-set-control > input[type=checkbox]", (n) => { n.checked = true; });
    await page.waitForTimeout(300);
    const after = await page.$eval("#drawer-body .bt-set-control > input[type=checkbox]", (n) => getComputedStyle(n).backgroundColor);
    check(`${scheme}：开关打开后换成强调色`, before !== after, `${before} → ${after}`);

    await page.click('#drawer-body > .bt-tabs .bt-tab:has-text("电脑")');
    await page.waitForTimeout(600);
    const selects = await page.evaluate(() => [...document.querySelectorAll("#drawer-body select[aria-label^='共享电脑']")].map((s) => ({ radius: parseFloat(getComputedStyle(s).borderRadius), h: Math.round(s.getBoundingClientRect().height) })));
    if (selects.length) check(`${scheme}：电脑规格下拉框是圆角输入框`, selects.every((s) => s.radius >= 8 && s.h >= 32), JSON.stringify(selects));
    else console.log(`skip: ${scheme} 没有共享电脑规格，下拉框不出现`);

    const low = await page.evaluate(() => {
      const bg = (n) => { for (let p = n; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c)) return c; } return "rgb(255,255,255)"; };
      return [...document.querySelectorAll("#drawer-body .bt-set-hint, #drawer-body .bt-set-copy > div:first-child, #chat-log .bt-time-sep, #head-sub")]
        .filter((n) => n.getClientRects().length && n.textContent.trim() && !n.closest("details:not([open])"))
        .map((n) => ({ t: n.textContent.trim().slice(0, 10), fg: getComputedStyle(n).color, bg: bg(n) }));
    });
    const bad = low.map((x) => ({ ...x, c: contrast(x.fg, x.bg) })).filter((x) => x.c < 4.5);
    check(`${scheme}：说明文字对比度都到 4.5`, low.length > 3 && bad.length === 0, JSON.stringify(bad.map((x) => [x.t, x.c.toFixed(2)])));
    check(`${scheme}：没有页面错误`, errors.length === 0, errors.join("; "));
    await page.close();
  }
} finally {
  await browser.close();
  await close();
}
console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);

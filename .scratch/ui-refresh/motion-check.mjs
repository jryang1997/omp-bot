// 动效检查：打开抽屉/弹窗/提示后立刻取样（应在过渡中途），稳定后再取样（应到终点）；减少动效时不该有位移。
// 用法：cd /data && PLAYWRIGHT=/vercel/sandbox/node_modules/playwright/index.mjs node omp-bot/.scratch/ui-refresh/motion-check.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../src/server.mjs", import.meta.url).href);
const home = mkdtempSync(join(tmpdir(), "ui-motion-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home });
orch.addBot({ name: "小总", role: "统筹", isMain: true });
const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
const checks = [];
const check = (name, ok, detail = "") => { checks.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
const sample = (page, sel) => page.$eval(sel, (e) => { const c = getComputedStyle(e); return { o: Number(c.opacity), t: c.transform }; });
const moving = (s) => s.o < 0.999 || (s.t !== "none" && s.t !== "matrix(1, 0, 0, 1, 0, 0)");
const still = (s) => s.o > 0.999 && (s.t === "none" || s.t === "matrix(1, 0, 0, 1, 0, 0)");
const translated = (s) => /matrix\(1, 0, 0, 1, (?!0, 0\))/.test(s.t);
try {
  for (const reduced of [false, true]) {
    const tag = reduced ? "减少动效" : "正常";
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: reduced ? "reduce" : "no-preference" });
    const page = await ctx.newPage();
    await page.goto(`${url}/#${token}`);
    await page.getByText("小总", { exact: true }).first().click();
    await page.waitForTimeout(400);
    await page.click("#btn-settings");
    const d0 = await sample(page, "#drawer");
    await page.waitForTimeout(500);
    const d1 = await sample(page, "#drawer");
    check(`${tag}：抽屉打开时在过渡中`, moving(d0), JSON.stringify(d0));
    check(`${tag}：抽屉最后停稳`, still(d1), JSON.stringify(d1));
    if (reduced) check(`${tag}：抽屉不位移`, !translated(d0), d0.t);
    else check(`${tag}：抽屉从右侧滑入`, translated(d0), d0.t);
    await page.click("#drawer-close");
    await page.click("#btn-new");
    const m0 = await sample(page, "#new-menu");
    await page.waitForTimeout(400);
    const m1 = await sample(page, "#new-menu");
    check(`${tag}：新建菜单展开有过渡`, moving(m0), JSON.stringify(m0));
    check(`${tag}：新建菜单停稳`, still(m1), JSON.stringify(m1));
    await page.keyboard.press("Escape");
    await page.evaluate(() => import("./workbench-core.js").then((m) => m.toast("保存好了")));
    const t0 = await sample(page, ".toast");
    await page.waitForTimeout(400);
    const t1 = await sample(page, ".toast");
    check(`${tag}：提示进场有过渡`, moving(t0), JSON.stringify(t0));
    check(`${tag}：提示停稳`, still(t1), JSON.stringify(t1));
    await page.waitForTimeout(3200);
    check(`${tag}：提示到时淡出并移除`, (await page.$$(".toast")).length === 0);
    await ctx.close();
  }
} finally {
  await browser.close();
  await close();
}
process.exit(checks.every(Boolean) ? 0 : 1);

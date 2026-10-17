// 对话区检查：日期写今天、新消息才有进场动效、头部按钮一行不重叠、减少动效时只淡入。
// 用法：cd /data && PLAYWRIGHT=/vercel/sandbox/node_modules/playwright/index.mjs node omp-bot/.scratch/ui-refresh/chat-check.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../src/server.mjs", import.meta.url).href);
const { FakeRuntime } = await import(new URL("../../test/_harness.mjs", import.meta.url).href);
const home = mkdtempSync(join(tmpdir(), "ui-chat-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home, runtimeFactory: (o) => new FakeRuntime(o) });
const main = orch.addBot({ name: "小总", role: "统筹", isMain: true });
const rt = await orch.runtimeFor(main.id, "private");
rt.queue.push({ kind: "complete", text: "第一条回复" });
await orch.waitRun(orch.startRun({ botId: main.id, text: "第一条" }).id);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`); };
const overlap = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
try {
  for (const [label, viewport] of [["桌面", { width: 1440, height: 900 }], ["手机", { width: 390, height: 844 }]]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(`${url}/#${token}`);
    await page.waitForTimeout(600);
    if (viewport.width > 600) await page.getByText("小总", { exact: true }).first().click();
    else await page.evaluate(() => [...document.querySelectorAll(".bt-row")].find((n) => n.textContent.includes("小总"))?.click());
    await page.waitForSelector("#chat-log .bt-time-sep", { timeout: 8000 });
    const boxes = await page.evaluate(() => Object.fromEntries(["head-title", "btn-permissions", "btn-computer", "btn-settings"].map((id) => [id, document.getElementById(id).getBoundingClientRect().toJSON()])));
    const pairs = [["head-title", "btn-permissions"], ["head-title", "btn-computer"], ["btn-permissions", "btn-computer"], ["btn-computer", "btn-settings"], ["btn-permissions", "btn-settings"]];
    const bad = pairs.filter(([a, b]) => overlap(boxes[a], boxes[b]));
    check(`${label}：头部按钮互不重叠`, bad.length === 0, JSON.stringify(bad));
    if (viewport.width > 600) check("桌面：权限标签和电脑、设置在同一行", Math.abs(boxes["btn-permissions"].y + boxes["btn-permissions"].height / 2 - (boxes["btn-settings"].y + boxes["btn-settings"].height / 2)) < 2);
    await page.close();
  }

  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${url}/#${token}`);
  await page.getByText("小总", { exact: true }).first().click();
  await page.waitForSelector("#chat-log .bt-time-sep");
  check("日期分隔写「今天」", (await page.textContent("#chat-log .bt-time-sep")) === "今天", await page.textContent("#chat-log .bt-time-sep"));
  check("打开会话时旧消息不做进场动效", (await page.locator("#chat-log .is-new").count()) === 0);
  check("权限标签带档位", (await page.getAttribute("#btn-permissions", "data-level")) === "ask");
  rt.queue.push({ kind: "complete", text: "第二条回复" });
  await page.fill("#input", "第二条");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("chat-log").innerText.includes("第二条回复"), null, { timeout: 8000 }).catch(async (e) => {
    console.log("DEBUG chat-log:", JSON.stringify(await page.textContent("#chat-log")), "errors:", errors.join("; "));
    console.log("DEBUG runs:", JSON.stringify(orch.listRuns().map((r) => [r.text?.slice?.(0, 6), r.state, r.error?.message || r.error])));
    await page.waitForTimeout(3000);
    console.log("DEBUG later:", JSON.stringify(await page.textContent("#chat-log")), JSON.stringify(orch.listRuns().map((r) => r.state)));
    throw e;
  });
  await page.waitForTimeout(200);
  const fresh = await page.$$eval("#chat-log .is-new", (els) => els.map((e) => e.innerText.trim().slice(0, 12)));
  const old = await page.$$eval("#chat-log .bt-urow:not(.is-new)", (els) => els.map((e) => e.innerText.trim()));
  check("新来的消息有进场动效", fresh.some((t) => t.includes("第二条")), fresh.join(" | "));
  check("旧消息不跟着动", old.some((t) => t.includes("第一条")) && !fresh.some((t) => t.includes("第一条")), `${old.join("|")} / ${fresh.join("|")}`);
  const tr = await page.$eval("#chat-log .is-new", (e) => getComputedStyle(e).transitionProperty);
  check("进场只动 opacity 和 transform", tr === "opacity, transform", tr);
  check("没有页面错误", errors.length === 0, errors.join("; "));
  await page.close();

  const reduced = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })).newPage();
  await reduced.goto(`${url}/#${token}`);
  await reduced.getByText("小总", { exact: true }).first().click();
  await reduced.waitForSelector("#chat-log .bt-time-sep");
  const prop = await reduced.evaluate(() => { const n = document.createElement("div"); n.className = "is-new"; document.getElementById("chat-log").append(n); const p = getComputedStyle(n).transitionProperty; n.remove(); return p; });
  check("减少动效：只淡入", prop === "opacity", prop);
  await reduced.close();
} finally {
  await browser.close();
  await close();
}
console.log(`${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);

// 捏脸头像的真实界面截图：起真服务、真浏览器，点出新建表单和形象编辑器。
// 跑法：cd /data/gaps && node .scratch/team-rebuild/proof/notion-avatar/shot.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startServer } from "../../../../src/server.mjs";
// playwright 不是本项目依赖，用沙箱里预装的那份。
const { chromium } = createRequire(process.env.PW_FROM || "/vercel/sandbox/")("playwright");

const out = new URL(".", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "ompbot-na-shot-"));
const { url, token, close } = await startServer({ port: 0, host: "127.0.0.1", home });
const api = async (path, method = "GET", body) => {
  const res = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  return res.json();
};
const results = [];
const check = (name, ok, ev = "") => { results.push({ name, ok, ev }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ev ? ` ${ev}` : ""}`); };

const main = (await api("/api/bots", "POST", { name: "Ada", role: "主持", isMain: true })).bot;
const b1 = (await api("/api/bots", "POST", { name: "Bob", role: "查资料" })).bot;
const b2 = (await api("/api/bots", "POST", { name: "Cy", role: "写周报" })).bot;
await api("/api/rooms", "POST", { name: "工作组", members: [main.id, b1.id, b2.id] });

const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
try {
  await page.goto(`${url}/#${token}`);
  await page.waitForSelector(".omp-avatar-face img");
  await page.waitForTimeout(500);
  const faces = await page.$$eval(".omp-avatar-face img", (imgs) => imgs.map((i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.src.slice(0, 26) })));
  check("侧栏头像都画出来了", faces.length >= 4 && faces.every((f) => f.ok && f.src.startsWith("data:image/svg+xml")), `${faces.length} 张`);
  check("页面里没有吉祥物元素", (await page.$$("omp-mascot")).length === 0);
  await page.screenshot({ path: join(out, "sidebar.png") });

  // 新建助手：表单里有形象折叠区，翻一下发型、换底色，创建后存下
  await page.click("#btn-new");
  await page.click("#new-bot");
  const modal = page.locator("#modal-body");
  await modal.locator("summary", { hasText: "形象" }).click();
  await modal.locator("input").first().fill("Dee");
  const before = await modal.locator(".omp-avatar-stage img").getAttribute("src");
  await modal.locator('[data-key="part:hair:next"]').click();
  const after = await modal.locator(".omp-avatar-stage img").getAttribute("src");
  check("新建表单翻发型，预览跟着变", before !== after);
  await modal.locator('[data-key="color:pink"]').click();
  check("新建表单没有图片上传", (await modal.getByText("上传图片").count()) === 0);
  check("新建表单不给普通助手主蓝", (await modal.locator(`[data-key="color:#4D6BFE"]`).count()) === 0);
  await page.screenshot({ path: join(out, "new-bot.png") });
  const hairShown = await modal.locator(".omp-avatar-part", { hasText: "发型" }).locator(".omp-avatar-part-value").textContent();
  await modal.getByRole("button", { name: "创建" }).click();
  await page.waitForTimeout(800);
  const dee = (await api("/api/bots")).bots.find((b) => b.name === "Dee");
  check("创建后形象存进花名册", dee?.avatar?.color === "pink" && `${dee.avatar.parts.hair + 1}/59` === hairShown.trim(), JSON.stringify({ color: dee?.avatar?.color, hair: dee?.avatar?.parts?.hair, shown: hairShown }));

  // 主助手的形象可以改
  await page.locator(".bt-row, [data-id]", { hasText: "Ada" }).first().click().catch(() => page.getByText("Ada", { exact: true }).first().click());
  await page.click("#btn-settings");
  const drawer = page.locator("#drawer");
  await drawer.locator("summary", { hasText: "形象" }).click();
  check("主助手有可用的形象编辑器", (await drawer.locator('[data-key="part:eyes:next"]').count()) === 1 && (await drawer.getByText("保存形象").count()) === 1);
  check("主助手可以选主蓝", (await drawer.locator(`[data-key="color:#4D6BFE"]`).count()) === 1);
  await drawer.locator('[data-key="part:glasses:next"]').click();
  await drawer.locator('[data-key="color:teal"]').click();
  await drawer.locator(".omp-avatar-editor").screenshot({ path: join(out, "main-editor.png") });
  await drawer.getByText("保存形象").click();
  await page.waitForTimeout(800);
  const ada = (await api("/api/bots")).bots.find((b) => b.id === main.id);
  check("主助手改形象保存成功", ada.avatar.color === "teal" && ada.avatar.parts.glasses === (main.avatar.parts.glasses + 1) % 15, JSON.stringify({ color: ada.avatar.color, glasses: ada.avatar.parts.glasses }));
  await page.screenshot({ path: join(out, "main-detail.png") });

  // 晃动样式：is-moving 生效，减少动态效果时停
  const anim = await page.evaluate(() => {
    const node = document.querySelector(".omp-avatar");
    node.classList.add("is-moving");
    const name = getComputedStyle(node.firstElementChild).animationName;
    node.classList.remove("is-moving");
    return name;
  });
  check("运行中的头像会晃", anim === "omp-avatar-sway", anim);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const still = await page.evaluate(() => {
    const node = document.querySelector(".omp-avatar");
    node.classList.add("is-moving");
    const name = getComputedStyle(node.firstElementChild).animationName;
    node.classList.remove("is-moving");
    return name;
  });
  check("减少动态效果时不晃", still === "none", still);
  check("没有页面报错", errors.length === 0, errors.join(" | "));
} finally {
  writeFileSync(join(out, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
  await page.close();
  await browser.close();
  await close();
  rmSync(home, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);

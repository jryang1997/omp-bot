// 11 吉祥物头像：侧边栏、群头像、详情页和编辑界面的截图，加上状态映射、静止和减少动态效果的检查。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 运行：PLAYWRIGHT=<playwright 的 index.mjs> CHROME=<chromium 可执行文件> node .scratch/team-rebuild/proof/avatar/shot-avatar.mjs
// 截图和 report.json 写在本目录。Playwright 不是项目依赖，按本机位置传进来。
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);

const OUT = process.env.OUT || join(HERE, "avatar");
const home = mkdtempSync(join(tmpdir(), "shot-avatar-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home });
const add = (name, role, avatar, extra = {}) => {
  const bot = orch.addBot({ name, role, ...extra });
  return avatar ? orch.updateBot(bot.id, { avatar }) : bot;
};
const main = add("小总", "统筹", null, { isMain: true });
const think = add("小研", "查资料");
const work = add("阿码", "写代码", { body: "blob" });
const alert = add("审审", "审稿", { body: "shield", color: "orange" });
const sad = add("跑跑", "跑脚本", { body: "drop" });
const happy = add("小完", "写周报", { body: "hexagon", color: "pink" });
const proud = add("静静", "固定表情", { body: "capsule", color: "teal", expression: "proud" });
const pic = add("图图", "图片圆形");
const picA = orch.features.attachments.create({ botId: pic.id, filename: "face.png", mime: "image/png", dataBase64: readFileSync(join(HERE, "face.png")).toString("base64") });
orch.updateBot(pic.id, { avatar: { url: `/api/attachments/${picA.id}/preview`, crop: "circle" } });
const sq = add("方方", "图片圆角放大");
const sqA = orch.features.attachments.create({ botId: sq.id, filename: "scene.png", mime: "image/png", dataBase64: readFileSync(join(HERE, "scene.png")).toString("base64") });
orch.updateBot(sq.id, { avatar: { url: `/api/attachments/${sqA.id}/preview`, crop: "rounded", zoom: 2, focusX: 0.7, focusY: 0.4 } });
const idle = add("老王", "老 bot，默认形象");
orch.createRoom?.({ name: "产品群", members: [think.id, work.id, alert.id] });
const duo = orch.createRoom({ name: "两人组", members: [happy.id, proud.id] });
orch.createRoom?.({ name: "全员", members: [think.id, work.id, alert.id, sad.id, happy.id, pic.id] });

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const report = { checks: [], errors: [] };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };

async function open(ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...ctxOpts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => report.errors.push(e.message));
  // /api/models 在没有 omp 的沙箱里是 502；被删的附件图片 404 是第 4 段故意的。其余失败请求都算问题。
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && path !== "/api/models" && path !== `/api/attachments/${picA.id}/preview`) report.errors.push(`${r.status()} ${path}`);
  });
  await page.goto(`${url}/#${token}`);
  await page.waitForSelector("omp-mascot", { timeout: 10_000 });
  await page.waitForTimeout(800);
  return { ctx, page };
}
const now = () => Date.now();
const run = (id, botId, state, extra = {}) => ({ id, botId, kind: "chat", scope: "private", state, createdAt: now(), updatedAt: now(), ...extra });
// 用真实 SSE 推运行事件：服务端 emit 和正式运行走同一条广播。
function driveStates() {
  orch.emit("run_created", { run: run("run_t", think.id, "running") });
  orch.emit("run_created", { run: run("run_w", work.id, "running") });
  orch.emit("native_event", { runId: "run_w", event: { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } } });
  orch.emit("run_created", { run: run("run_a", alert.id, "waiting_approval") });
  orch.emit("run_created", { run: run("run_s", sad.id, "running") });
  orch.emit("run_finished", { run: run("run_s", sad.id, "failed", { error: "脚本退出码 1" }) });
  orch.emit("run_created", { run: run("run_h", happy.id, "running") });
  orch.emit("run_finished", { run: run("run_h", happy.id, "completed") });
}
const sidebarStates = (page) => page.$$eval("#side-list .bt-row", (rows) => rows.map((row) => {
  const m = row.querySelector("omp-mascot");
  return {
    name: row.querySelector(".bt-row-title")?.textContent,
    state: m?.getAttribute("state") ?? null,
    paused: m ? m.hasAttribute("paused") : null,
    fps: m?.getAttribute("fps") ?? null,
    img: !!row.querySelector(".omp-avatar-pic img"),
    seats: row.querySelectorAll(".bt-cluster omp-mascot, .bt-cluster img").length,
    unread: !!row.querySelector(".wb-unread"),
  };
}));

// ---- 1. 静止状态：没人在工作时全部暂停，默认形象和 Main Bot 固定形象 ----
{
  const { ctx, page } = await open();
  const rows = await sidebarStates(page);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  check("没人在工作时侧边栏头像全部静止", rows.filter((r) => r.state !== null).every((r) => r.paused), JSON.stringify(rows.filter((r) => !r.paused)));
  check("36px 头像限 30 帧", rows.filter((r) => r.state !== null).every((r) => r.fps === "30"));
  check("固定表情的 bot 空闲时显示固定表情", by["静静"]?.state === "proud", by["静静"]?.state);
  check("上传图片的 bot 显示图片", by["图图"]?.img && by["方方"]?.img);
  check("群头像按座位放吉祥物或图片", by["产品群"]?.seats === 3 && by["两人组"]?.seats === 2 && by["全员"]?.seats === 3, `${by["产品群"]?.seats}/${by["两人组"]?.seats}/${by["全员"]?.seats}`);
  const looks = await page.$$eval("#side-list .bt-row", (rows) => rows.map((row) => { const m = row.querySelector(":scope > .omp-avatar omp-mascot"); return m && [row.querySelector(".bt-row-title").textContent, m.getAttribute("body"), m.getAttribute("color")]; }).filter(Boolean));
  const look = Object.fromEntries(looks.map(([n, b, c]) => [n, [b, c]]));
  check("Main Bot 是 star 加专用蓝", look["小总"]?.[0] === "star" && look["小总"]?.[1] === "#4D6BFE", JSON.stringify(look["小总"]));
  check("老 bot 默认 cursor 身体和按 id 分的颜色", look["老王"]?.[0] === "cursor" && look["老王"]?.[1] === orch.getBot(idle.id).avatar.color, JSON.stringify(look["老王"]));
  await page.screenshot({ path: `${OUT}-idle.png` });
  await ctx.close();
}

// ---- 2. 运行状态映射：思考、工具、等审批、出错、刚完成 ----
{
  const { ctx, page } = await open();
  // 把选中的会话切到 Main Bot，其他 bot 完成时算未读
  await page.getByText("小总", { exact: true }).first().click();
  await page.waitForTimeout(300);
  driveStates();
  await page.waitForTimeout(900);
  const rows = await sidebarStates(page);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  check("思考中 thinking 且在动", by["小研"]?.state === "thinking" && !by["小研"].paused, JSON.stringify(by["小研"]));
  check("调用工具 working 且在动", by["阿码"]?.state === "working" && !by["阿码"].paused, JSON.stringify(by["阿码"]));
  check("等审批 alerting 且在动", by["审审"]?.state === "alerting" && !by["审审"].paused, JSON.stringify(by["审审"]));
  check("出错 sad", by["跑跑"]?.state === "sad", JSON.stringify(by["跑跑"]));
  check("刚完成 happy", by["小完"]?.state === "happy" && !by["小完"].paused, JSON.stringify(by["小完"]));
  check("完成的私聊没在看时有未读标记", by["小完"]?.unread === true);
  check("没事的 bot 仍然静止", by["老王"]?.paused === true);
  const seats = () => page.$$eval(`#side-list .bt-row[data-room-id="${duo.id}"] omp-mascot`, (ms) => ms.map((m) => m.hasAttribute("paused")));
  // 两人组的第一个座位是刚完成、有未读的小完，自己就在动；第二个座位静静没事，静止。
  check("群没动静时，没事的成员座位静止，有事的成员座位跟着自己动", JSON.stringify(await seats()) === "[false,true]", JSON.stringify(await seats()));
  orch.emit("room_bot_post", { roomId: duo.id, bot: "小完", text: "周报写好了" });
  await page.waitForTimeout(500);
  const duoRow = await page.$eval(`#side-list .bt-row[data-room-id="${duo.id}"]`, (row) => !!row.querySelector(".wb-unread"));
  check("群里有新消息没在看时，群头像的座位动起来并有未读标记", duoRow && (await seats()).every((p) => !p), JSON.stringify(await seats()));
  await page.screenshot({ path: `${OUT}-states.png` });
  // 固定表情：工作中换成 working，结束回到固定表情
  orch.emit("run_created", { run: run("run_p", proud.id, "running") });
  await page.waitForTimeout(500);
  const busy = (await sidebarStates(page)).find((r) => r.name === "静静");
  check("固定表情的 bot 工作中切到 working", busy?.state === "working" && !busy.paused, JSON.stringify(busy));
  orch.emit("run_finished", { run: run("run_p", proud.id, "cancelled") });
  await page.waitForTimeout(500);
  check("固定表情的 bot 结束后回到固定表情", (await sidebarStates(page)).find((r) => r.name === "静静")?.state === "proud");
  // 开心一下再回 idle；未读的还在动，看过以后静止
  await page.waitForTimeout(4600);
  const later = Object.fromEntries((await sidebarStates(page)).map((r) => [r.name, r]));
  check("happy 过几秒回到 idle", later["小完"]?.state === "idle", later["小完"]?.state);
  check("有未读的头像还在动", later["小完"]?.paused === false);
  check("刚发生事件的窗口过了，出错的头像停下", later["跑跑"]?.paused === true && later["跑跑"]?.state === "sad", JSON.stringify(later["跑跑"]));
  await page.getByText("小完", { exact: true }).first().click();
  await page.waitForTimeout(400);
  const seen = (await sidebarStates(page)).find((r) => r.name === "小完");
  check("打开看过以后未读消失、头像静止", seen?.unread === false && seen?.paused === true, JSON.stringify(seen));
  orch.emit("run_finished", { run: run("run_t", think.id, "completed") });
  orch.emit("run_finished", { run: run("run_w", work.id, "completed") });
  orch.emit("run_finished", { run: run("run_a", alert.id, "completed") });
  await ctx.close();
}

// ---- 3. 减少动态效果：身体不晃 ----
{
  const { ctx, page } = await open({ reducedMotion: "reduce" });
  orch.emit("run_created", { run: run("run_rm", work.id, "running") });
  orch.emit("native_event", { runId: "run_rm", event: { type: "tool_execution_start", toolCallId: "call_rm", toolName: "bash" } });
  await page.waitForTimeout(600);
  const sample = () => page.$eval(`#side-list .bt-row[data-bot-id="${work.id}"] omp-mascot`, (m) => m.shadowRoot.querySelector('[data-p="body"]').getAttribute("transform"));
  const a = await sample(); await page.waitForTimeout(350); const b = await sample();
  const state = await page.$eval(`#side-list .bt-row[data-bot-id="${work.id}"] omp-mascot`, (m) => [m.getAttribute("state"), m.hasAttribute("paused")]);
  check("减少动态效果时工作中的头像身体不动", state[0] === "working" && !state[1] && !a && !b, JSON.stringify({ state, a, b }));
  orch.emit("run_finished", { run: run("run_rm", work.id, "completed") });
  await ctx.close();
}
{
  const { ctx, page } = await open();
  orch.emit("run_created", { run: run("run_mv", work.id, "running") });
  orch.emit("native_event", { runId: "run_mv", event: { type: "tool_execution_start", toolCallId: "call_mv", toolName: "bash" } });
  await page.waitForTimeout(600);
  const sample = () => page.$eval(`#side-list .bt-row[data-bot-id="${work.id}"] omp-mascot`, (m) => m.shadowRoot.querySelector('[data-p="body"]').getAttribute("transform"));
  const a = await sample(); await page.waitForTimeout(350); const b = await sample();
  check("对照：正常动态效果下工作中的头像身体在动", a !== b, JSON.stringify({ a, b }));
  orch.emit("run_finished", { run: run("run_mv", work.id, "completed") });
  await ctx.close();
}

// ---- 4. 详情页和编辑界面 ----
{
  const { ctx, page } = await open();
  await page.getByText("阿码", { exact: true }).first().click();
  await page.waitForTimeout(300);
  await page.click("#btn-settings");
  await page.waitForTimeout(500);
  await page.locator("#drawer summary", { hasText: "形象" }).click();
  await page.waitForTimeout(500);
  const editor = page.locator("#drawer .omp-avatar-editor");
  const groups = await editor.locator(".omp-avatar-legend").allInnerTexts();
  check("编辑界面有身体、颜色、表情、图片、裁切、缩放", ["身体", "颜色", "表情", "图片", "裁切", "缩放"].every((g) => groups.includes(g)), groups.join("、"));
  const counts = await editor.evaluate((root) => [...root.querySelectorAll(".omp-avatar-choices")].map((row) => row.children.length));
  check("10 种身体、10 种颜色、跟着状态加 10 种表情、4 种裁切", JSON.stringify([counts[0], counts[1], counts[2], counts[4]]) === "[10,10,11,4]", JSON.stringify(counts));
  check("没图片时图片裁切和缩放不可用", await editor.locator('[data-key="crop:circle"]').isDisabled() && await editor.locator('input[type="range"]').isDisabled());
  await editor.locator('[data-key="body:star"]').click();
  await editor.locator('[data-key="color:purple"]').click();
  await editor.locator('[data-key="face:curious"]').click();
  check("点选项后焦点留在刚点的选项上", await page.evaluate(() => document.activeElement?.dataset?.key) === "face:curious");
  await page.locator("#drawer").screenshot({ path: `${OUT}-editor.png` });
  await editor.getByRole("button", { name: "保存形象" }).click();
  await page.waitForTimeout(800);
  const saved = orch.getBot(work.id).avatar;
  check("保存后写进花名册", saved.body === "star" && saved.color === "purple" && saved.expression === "curious", JSON.stringify(saved));
  // 上传图片 → 自动切到圆形裁切，缩放可用
  await page.locator("#drawer summary", { hasText: "形象" }).click().catch(() => {});
  await page.waitForTimeout(300);
  const ed = page.locator("#drawer .omp-avatar-editor");
  if (!(await ed.isVisible())) await page.locator("#drawer summary", { hasText: "形象" }).click();
  await ed.locator('input[type="file"]').setInputFiles(join(HERE, "face.png"));
  await page.waitForTimeout(800);
  check("上传后默认圆形裁切，缩放可用", (await ed.locator('[data-key="crop:circle"]').getAttribute("aria-pressed")) === "true" && !(await ed.locator('input[type="range"]').isDisabled()));
  await ed.locator('[data-key="crop:rounded"]').click();
  await ed.locator('input[type="range"]').fill("1.6");
  const stage = ed.locator(".omp-avatar-stage");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  await page.locator("#drawer").screenshot({ path: `${OUT}-editor-picture.png` });
  await ed.getByRole("button", { name: "保存形象" }).click();
  await page.waitForTimeout(800);
  const pictured = orch.getBot(work.id).avatar;
  check("图片头像带裁切、缩放和焦点保存", pictured.crop === "rounded" && pictured.zoom === 1.6 && pictured.focusX < 0.5 && /^\/api\/attachments\/att_[a-z0-9_]+\/preview$/.test(pictured.url), JSON.stringify(pictured));
  await page.screenshot({ path: `${OUT}-detail.png` });
  // Main Bot：没有编辑区，只有一句说明
  await page.getByText("小总", { exact: true }).first().click();
  await page.waitForTimeout(300);
  await page.click("#btn-settings");
  await page.waitForTimeout(500);
  const mainText = await page.locator("#drawer").innerText();
  check("Main Bot 详情页没有形象编辑，只说明固定", mainText.includes("主助手的形象是固定的") && (await page.locator("#drawer .omp-avatar-choices").count()) === 0);
  await page.screenshot({ path: `${OUT}-main.png` });
  // 群聊详情页的群头像
  await page.getByText("产品群", { exact: true }).first().click();
  await page.waitForTimeout(300);
  await page.click("#btn-settings");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}-room.png` });
  // 图片被删后退回吉祥物
  orch.features.attachments.remove(picA.id);
  await page.reload();
  await page.waitForSelector("omp-mascot");
  await page.waitForTimeout(800);
  const fallback = await page.$eval(`#side-list .bt-row[data-bot-id="${pic.id}"]`, (row) => [!!row.querySelector("omp-mascot"), !!row.querySelector("img")]);
  check("图片附件被删后头像退回吉祥物", fallback[0] && !fallback[1], JSON.stringify(fallback));
  await ctx.close();
}

// ---- 5. 深色和窄屏 ----
{
  const { ctx, page } = await open({ colorScheme: "dark", viewport: { width: 1280, height: 900 } });
  await page.getByText("产品群", { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}-dark.png` });
  await ctx.close();
}

check("页面没有脚本错误和意外的失败请求", report.errors.length === 0, report.errors.join(" | "));
writeFileSync(`${OUT}-report.json`, JSON.stringify(report, null, 2));
await browser.close();
await close();
rmSync(home, { recursive: true, force: true });
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`\n${report.checks.length - failed}/${report.checks.length} PASS`);
process.exit(failed ? 1 : 0);

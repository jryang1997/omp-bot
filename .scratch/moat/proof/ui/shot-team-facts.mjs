// 04 工作台：团队事实待确认区块截图 + 交互检查。提议直接通过编排器写进真实台账和 team 目录（不跑模型）。
// 运行：PLAYWRIGHT=<playwright 的 index.mjs> node omp-bot/.scratch/moat/proof/ui/shot-team-facts.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright"); // 不是项目依赖，按本机位置传进来
const { startServer } = await import(new URL("../../../../src/server.mjs", import.meta.url).href);

const home = mkdtempSync(join(tmpdir(), "shot-facts-"));
const { url, token, orch, close } = await startServer({ port: 0, host: "127.0.0.1", home });
const main = orch.addBot({ name: "小总", role: "统筹", isMain: true });
const a = orch.addBot({ name: "小研", role: "查资料" });
const b = orch.addBot({ name: "阿码", role: "写代码" });
const USER = { kind: "user" };
orch.addTeamFact({ fact: "发版在周三", source: "用户定的", by: USER });
orch.addTeamFact({ fact: "设计稿放在 workspace/design", source: "用户在群里说的", by: USER });
const p1 = orch.proposeTeamFact(a, { fact: "发版改到周四", source: "产品群 10 月 15 日通知", replaces: "发版在周三" }).proposal;
const p2 = orch.proposeTeamFact(b, { fact: "发版改到周五", source: "用户私聊", replaces: "发版在周三" }).proposal;
orch.proposeTeamFact(b, { fact: "测试账号在 1Password 的「测试」库", source: "用户私聊" });
const agents = () => readFileSync(join(home, "team", "AGENTS.md"), "utf8");

const browser = await chromium.launch({ executablePath: "/usr/local/bin/chromium" });
const checks = [];
const errors = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`); };
const tileText = (page, id) => page.textContent(`.wb-run-tile[data-proposal-id="${id}"]`);
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  // 第二个接受会 409（这正是要测的），其余 4xx/5xx 都算错。
  page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && p !== "/api/models" && !(r.status() === 409 && p.endsWith(`/${p2.id}/accept`))) errors.push(`${r.status()} ${p}`); });
  await page.goto(`${url}/#${token}`);
  await page.click("#btn-activity");
  await page.waitForSelector(".wb-fact-list:not(.hidden)", { timeout: 10_000 });
  const label = await page.textContent(".wb-fact-list .wb-dock-label");
  check("区块标题写出待确认条数", label.includes("团队事实待确认（3）"), label);
  const t1 = await tileText(page, p1.id);
  check("替换提议写出旧的和新的", t1.includes("把「发版在周三」改成「发版改到周四」"), t1);
  check("提议写出来源", t1.includes("来源：产品群 10 月 15 日通知"));
  await page.locator(".wb-fact-list").screenshot({ path: join(HERE, "team-facts.png") });

  await page.click(`.wb-run-tile[data-proposal-id="${p1.id}"] button:has-text("接受")`);
  await page.waitForFunction((id) => !document.querySelector(`.wb-run-tile[data-proposal-id="${id}"]`), p1.id, { timeout: 5_000 });
  check("接受后写进团队共识", agents().includes("- 发版改到周四（来源：产品群 10 月 15 日通知）") && !agents().includes("发版在周三"));

  await page.click(`.wb-run-tile[data-proposal-id="${p2.id}"] button:has-text("接受")`);
  await page.waitForSelector(`.wb-run-tile[data-proposal-id="${p2.id}"][data-state="conflict"]`, { timeout: 5_000 });
  const t2 = await tileText(page, p2.id);
  check("后接受的同一条被拒，提示重提", t2.includes("旧事实已变，要重提") && t2.includes("请按团队事实块的最新内容重提"), t2);
  check("撞车的那条没写进文件", !agents().includes("发版改到周五"));

  page.once("dialog", (d) => void d.accept("设计稿放在 workspace/design-v2"));
  await page.click(".wb-fact-current summary");
  await page.click('.wb-fact-current .bt-set-row:has-text("设计稿放在 workspace/design") button:has-text("纠正")');
  await page.waitForFunction(() => document.querySelector(".wb-fact-current")?.textContent.includes("design-v2"), null, { timeout: 5_000 });
  check("纠正后事实列表保持展开", await page.$eval(".wb-fact-current", (d) => d.open));
  check("纠正后文件里只剩新说法", agents().includes("设计稿放在 workspace/design-v2") && !/设计稿放在 workspace\/design（/.test(agents()));
  let again = null;
  try { orch.proposeTeamFact(a, { fact: "设计稿放在 workspace/design", source: "旧聊天" }); } catch (e) { again = e; }
  check("纠正过的旧说法再提被拒", again?.code === "fact_corrected", again?.message);
  await page.screenshot({ path: join(HERE, "team-facts-after.png") });
  check("除预期的 409 外没有页面错误或失败请求", errors.length === 0, errors.join("; "));
  await ctx.close();
} finally {
  await browser.close();
  await close();
}
writeFileSync(join(HERE, "report-team-facts.json"), JSON.stringify({ checks, errors }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);

// 02 号票原型。沙盒替身，三个 profile 代表登录屏、bot-a、bot-b。需要 site.mjs 在跑，以 root 权限的 sudo 可用。
// 运行：node proof.mjs
// Playwright 用沙盒预装的那份，路径可用 PLAYWRIGHT 覆盖。
const { chromium } = await import(process.env.PLAYWRIGHT ?? '/vercel/sandbox/node_modules/playwright/index.mjs');
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = '/tmp/login-proof';
const STORE = path.join(ROOT, 'store');
const SYNC = path.resolve(new URL('.', import.meta.url).pathname, '../../../guest/omp-login-sync');
const SITE = 'http://127.0.0.1:18090';
const OTHER = 'http://localhost:18090';
const prof = name => path.join(ROOT, name);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

async function open(name) {
  return chromium.launchPersistentContext(prof(name), { executablePath: '/usr/local/bin/chromium', headless: true, args: ['--password-store=basic', '--no-sandbox'] });
}
async function visit(ctx, url) {
  const page = await ctx.newPage();
  await page.goto(url);
  const who = await page.textContent('#who');
  await page.close();
  return who;
}
async function once(name, url) { const ctx = await open(name); const who = await visit(ctx, url); await ctx.close(); return who; }
const py = (...args) => execFileSync('python3', [SYNC, ...args], { encoding: 'utf8' }).trim();
const out = { ticket: '02-shared-browser-login', chromium: execFileSync('/usr/local/bin/chromium', ['--version'], { encoding: 'utf8' }).trim(), at: new Date().toISOString(), steps: {} };

// bot-a 事先在另一个站点有自己的登录，同步后不能被冲掉
out.steps.botAOwnLogin = await once('bot-a', `${OTHER}/login?user=bot-a-own`);
// 用户在登录屏登录一次
out.steps.userLogsInOnLoginScreen = await once('login', `${SITE}/login?user=alice`);
out.steps.publish = py('publish', '--from', prof('login'), '--store', STORE);
out.steps.syncA = py('sync', '--profile', prof('bot-a'), '--store', STORE);
out.steps.syncB = py('sync', '--profile', prof('bot-b'), '--store', STORE);
out.steps.syncAAgain = py('sync', '--profile', prof('bot-a'), '--store', STORE);

// 两个 bot 同时开浏览器
const [a, b] = await Promise.all([open('bot-a'), open('bot-b')]);
out.steps.parallel = await Promise.all([visit(a, `${SITE}/`), visit(b, `${SITE}/`)]);
out.steps.botAOwnLoginKept = await visit(a, `${OTHER}/`);
// 浏览器开着时同步要跳过，不能改正在用的库
fs.writeFileSync(path.join(STORE, 'version'), String(BigInt(fs.readFileSync(path.join(STORE, 'version'), 'utf8')) + 1n));
out.steps.syncWhileRunning = py('sync', '--profile', prof('bot-b'), '--store', STORE);
await Promise.all([a.close(), b.close()]);

// 关掉再开，登录还在
out.steps.afterRestart = [await once('bot-a', `${SITE}/`), await once('bot-b', `${SITE}/`)];

// bot-a 只在本地清 cookie，bot-b 不受影响
{ const ctx = await open('bot-a'); await ctx.clearCookies(); await ctx.close(); }
out.steps.localClearInA = [await once('bot-a', `${SITE}/`), await once('bot-b', `${SITE}/`)];

// bot-b 点了网站的退出，服务端吊销会话，所有共用这个会话的 bot 都掉线
out.steps.serverLogoutInB = await once('bot-b', `${SITE}/logout`);
out.steps.afterServerLogout = [await once('bot-a', `${SITE}/`), await once('bot-b', `${SITE}/`)];
// 用户重新登录一次，发布后两个 bot 下次开浏览器都恢复
await once('login', `${SITE}/login?user=alice`);
py('publish', '--from', prof('login'), '--store', STORE);
py('sync', '--profile', prof('bot-a'), '--store', STORE);
py('sync', '--profile', prof('bot-b'), '--store', STORE);
out.steps.afterRelogin = [await once('bot-a', `${SITE}/`), await once('bot-b', `${SITE}/`)];

fs.writeFileSync(new URL('./proof.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
process.exit(0);

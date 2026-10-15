// run.mjs：20 个头像同时动时的 CPU。上游 React 版与原生版对照，每组 12 秒。
// 量两个数：页面主线程忙碌比例（CDP Performance.TaskDuration），浏览器全部进程的 CPU（/proc，占一个核的百分比）。
import { chromium } from '/vercel/sandbox/node_modules/playwright/index.mjs';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(body);
}).listen(18091);
const me = process.getuid();
const HZ = 100;
function chromeTicks() {
  let t = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const st = readFileSync(`/proc/${pid}/status`, 'utf8');
      if (!new RegExp(`^Uid:\\s+${me}\\b`, 'm').test(st)) continue;
      if (!/^Name:\s+chrome/m.test(st)) continue;
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      t += Number(f[11]) + Number(f[12]);
    } catch {}
  }
  return t;
}
const cases = [];
for (const impl of ['react', 'native']) for (const state of ['idle', 'working']) cases.push({ impl, state });
cases.push({ impl: 'react', state: 'working', reduced: true }, { impl: 'native', state: 'working', reduced: true });
cases.push({ impl: 'react', state: 'working', offscreen: true }, { impl: 'native', state: 'working', offscreen: true });
cases.push({ impl: 'native', state: 'working', fps: 30 }, { impl: 'native', state: 'working', paused: true });
if (process.env.ONLY_NEW) cases.splice(0, cases.length - 2);
const SECONDS = Number(process.env.SECONDS_ ?? 12);
const results = [];
for (const c of cases) {
  const ctx = await chromium.launchPersistentContext(`/tmp/mascot-bench-${Date.now()}`, {
    headless: true, executablePath: '/vercel/sandbox/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    viewport: { width: 1280, height: 800 }, reducedMotion: c.reduced ? 'reduce' : 'no-preference', args: ['--disable-gpu'],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(`http://127.0.0.1:18091/bench/bench.html?impl=${c.impl}&n=20&size=36&state=${c.state}${c.offscreen ? '&offscreen=1' : ''}${c.fps ? `&fps=${c.fps}` : ''}${c.paused ? '&paused=1' : ''}`);
  await page.waitForFunction(() => window.ready === true);
  await page.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const a = await metric(), ta = chromeTicks(), t0 = Date.now();
  const fps = await page.evaluate(ms => new Promise(ok => { let n = 0; const end = performance.now() + ms; const f = now => { n++; now < end ? requestAnimationFrame(f) : ok(n / (ms / 1000)); }; requestAnimationFrame(f); }), SECONDS * 1000);
  const b = await metric(), tb = chromeTicks(), wall = (Date.now() - t0) / 1000;
  results.push({ ...c, n: 20, size: 36, mainThreadBusyPct: +(100 * (b.TaskDuration - a.TaskDuration) / wall).toFixed(1), scriptPct: +(100 * (b.ScriptDuration - a.ScriptDuration) / wall).toFixed(1), browserCpuPctOfOneCore: +(100 * (tb - ta) / HZ / wall).toFixed(1), rafFps: Math.round(fps) });
  console.log(JSON.stringify(results.at(-1)));
  await ctx.close();
}
writeFileSync(path.join(ROOT, 'bench', process.env.ONLY_NEW ? 'result-extra.json' : 'result.json'), JSON.stringify({ at: new Date().toISOString(), chrome: '153 headless, --disable-gpu, 2 vCPU sandbox', results }, null, 2));
server.close(); process.exit(0);

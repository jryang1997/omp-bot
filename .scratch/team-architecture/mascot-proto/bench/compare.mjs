// compare.mjs：截 compare.html，逐个格子比较上游和原生版的像素。
import { chromium } from '/vercel/sandbox/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let body; try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(body);
}).listen(18093);
const browser = await chromium.launch({ executablePath: '/vercel/sandbox/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const page = await browser.newPage({ viewport: { width: 920, height: 220 }, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:18093/bench/compare.html');
await page.waitForFunction(() => window.ready === true);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(ROOT, 'bench', 'compare.png') });
await browser.close(); server.close(); process.exit(0);

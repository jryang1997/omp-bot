// shot.mjs：截演示页，再和上游截图并排拼一张对比图。
import { chromium } from '/vercel/sandbox/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const ROOT = path.resolve(new URL('.', import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let body; try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'text/html' }); res.end(body);
}).listen(18092);
const browser = await chromium.launch({ executablePath: '/vercel/sandbox/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://127.0.0.1:18092/demo.html');
await page.waitForTimeout(1800);
await page.screenshot({ path: path.join(ROOT, 'demo.png') });
const count = await page.evaluate(() => document.querySelectorAll('omp-mascot').length);
const drawn = await page.evaluate(() => [...document.querySelectorAll('omp-mascot')].filter(m => m.shadowRoot?.querySelector('[data-p="eye0"]')?.getAttribute('d')).length);
console.log(JSON.stringify({ count, drawn, errors }));
await browser.close(); server.close(); process.exit(0);

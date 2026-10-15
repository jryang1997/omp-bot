// drive.mjs：模拟 bot 用电脑。每个座席每 INTERVAL 毫秒截一张图、按一次 PageDown，持续 SECONDS 秒。
// 运行：SDK_DIR=/data/omp-bot SEATS=bot-1:3321,bot-2:3322 node drive.mjs
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const sdk = await import(pathToFileURL(`${process.env.SDK_DIR}/node_modules/@trycua/cua/dist/index.js`).href);
const runtime = sdk.embedded();
const SECONDS = Number(process.env.SECONDS_ ?? 30), INTERVAL = Number(process.env.INTERVAL ?? 3000);
const seats = await Promise.all(process.env.SEATS.split(',').map(async s => {
  const [user, port] = s.split(':');
  const token = execFileSync('sudo', ['-n', 'cat', `/home/${user}/.spacesd/token`], { encoding: 'utf8' }).trim();
  return { user, client: await runtime.spacesd(`http://127.0.0.1:${port}`, token), ms: [], bytes: 0 };
}));
const key = k => JSON.stringify({ target: { displayId: 'primary', delivery: 'DELIVERY_FOREGROUND' }, hotkey: { keys: [{ named: k }] } });
const end = Date.now() + SECONDS * 1000;
await Promise.all(seats.map(async seat => {
  let i = 0;
  while (Date.now() < end) {
    const t = Date.now();
    const shot = await seat.client.screenshot({ format: sdk.ImageFormat.Png }, { signal: AbortSignal.timeout(15000) });
    seat.ms.push(Date.now() - t); seat.bytes += Buffer.from(shot.image).length;
    await seat.client.keyboardJson(key(i++ % 6 < 3 ? 'KEY_PAGE_DOWN' : 'KEY_PAGE_UP'), { signal: AbortSignal.timeout(15000) });
    await new Promise(r => setTimeout(r, Math.max(0, INTERVAL - (Date.now() - t))));
  }
}));
const p = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
console.log(JSON.stringify(Object.fromEntries(seats.map(s => [s.user, { shots: s.ms.length, p50: p(s.ms, 0.5), p95: p(s.ms, 0.95), avgKiB: Math.round(s.bytes / s.ms.length / 1024) }]))));
process.exit(0);

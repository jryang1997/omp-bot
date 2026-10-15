// 01 号票补充证明：每块屏一个官方 cua-spacesd 实例，用项目现有的 @trycua/cua 0.4.1 调用方式并发操作。
// 运行：SDK_DIR=<装了 @trycua/cua@0.4.1 的目录> node sdk-proof.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const sdk = await import(pathToFileURL(`${process.env.SDK_DIR}/node_modules/@trycua/cua/dist/index.js`).href);
const BOTS = [
  { user: 'bot-a', port: 3311, cdp: 9311, word: '甲屏🙂' },
  { user: 'bot-b', port: 3312, cdp: 9312, word: '乙屏🚀' },
];
const ROUNDS = Number(process.env.ROUNDS ?? 10);
const runtime = sdk.embedded();
const opts = () => ({ signal: AbortSignal.timeout(15000) });

async function cdpEval(port, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.startsWith('file:///workspace/page.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  const reply = new Promise(ok => { ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) ok(d); }; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  const d = await reply; ws.close();
  return d.result.result.value;
}

for (const bot of BOTS) {
  const token = execFileSync('sudo', ['-n', 'cat', `/home/${bot.user}/.spacesd/token`], { encoding: 'utf8' }).trim();
  bot.client = await runtime.spacesd(`http://127.0.0.1:${bot.port}`, token);
  await cdpEval(bot.cdp, 'document.getElementById("t").value = ""; window.clicks = 0');
}

async function drive(bot) {
  const ms = [];
  const windows = JSON.parse(await bot.client.callJson('WindowsService/ListWindows', '{}', opts())).windows ?? [];
  bot.windows = windows.map(w => ({ title: w.title, focused: !!w.focused, app: w.app?.name ?? w.app?.appId }));
  for (let i = 1; i <= ROUNDS; i++) {
    const t = Date.now();
    await bot.client.click(200 + 50 * i, 500, opts());
    await bot.client.keyboardJson(JSON.stringify({ target: { displayId: 'primary', delivery: 'DELIVERY_FOREGROUND' }, hotkey: { keys: [{ named: 'KEY_CONTROL' }, { named: 'KEY_END' }] } }), opts());
    // 与 computer-backend.mjs 的 type 分支相同：先写剪贴板，再发 Ctrl+V。
    await bot.client.setClipboard(`${bot.word}${i} ${bot.user}-${i}\n`, opts());
    await bot.client.keyboardJson(JSON.stringify({ target: { displayId: 'primary', delivery: 'DELIVERY_FOREGROUND' }, hotkey: { keys: [{ named: 'KEY_CONTROL' }, { named: 'KEY_V' }] } }), opts());
    // 等浏览器真正读完剪贴板再进下一轮。不等的话下一次 setClipboard 会抢在粘贴之前，见 Answer 的旁支发现。
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const n = await cdpEval(bot.cdp, 'document.getElementById("t").value.split("\\n").filter(Boolean).length');
      if (n >= i) break;
      await new Promise(r => setTimeout(r, 10));
    }
    ms.push(Date.now() - t);
  }
  return ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)];
}

const p50 = await Promise.all(BOTS.map(drive));
await new Promise(r => setTimeout(r, 500));
const result = { ticket: '01-per-bot-screens', check: 'one official cua-spacesd 0.5.3 per screen, driven by @trycua/cua 0.4.1 like src/computer-backend.mjs', at: new Date().toISOString(), rounds: ROUNDS, bots: [] };
for (const [k, bot] of BOTS.entries()) {
  const { value, clicks } = JSON.parse(await cdpEval(bot.cdp, 'JSON.stringify({ value: document.getElementById("t").value, clicks: window.clicks })'));
  const other = BOTS.find(b => b !== bot);
  const lines = value.split('\n').filter(Boolean);
  const expected = Array.from({ length: ROUNDS }, (_, j) => `${bot.word}${j + 1} ${bot.user}-${j + 1}`);
  const shot = await bot.client.screenshot({ format: sdk.ImageFormat.Png }, opts());
  writeFileSync(new URL(`sdk-shot-${bot.user}.png`, import.meta.url), Buffer.from(shot.image));
  result.bots.push({ user: bot.user, port: bot.port, clicks, lines: lines.length, exactOrder: JSON.stringify(lines) === JSON.stringify(expected), foreignTokens: value.includes(other.word), screenshot: { width: shot.width, height: shot.height, bytes: Buffer.from(shot.image).length }, windows: bot.windows, p50StepMs: p50[k] });
}
// 交叉：拿 bot-a 的令牌连 bot-b 的实例，期望拒绝。
try {
  const tokenA = execFileSync('sudo', ['-n', 'cat', '/home/bot-a/.spacesd/token'], { encoding: 'utf8' }).trim();
  const wrong = await runtime.spacesd('http://127.0.0.1:3312', tokenA);
  await wrong.screenshot({ format: sdk.ImageFormat.Png }, opts());
  result.wrongTokenBlocked = false;
} catch (error) { result.wrongTokenBlocked = true; result.wrongTokenError = String(error?.message ?? error).slice(0, 160); }
result.pass = result.bots.every(b => b.exactOrder && !b.foreignTokens && b.clicks === ROUNDS) && result.wrongTokenBlocked;
writeFileSync(new URL('sdk-proof.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 1));
process.exit(0);

// 01 号票证明：同一台 Linux 里两块独立屏幕，两个 bot 同时点击、粘贴中文、打字，互不串屏。
// 依赖 setup.sh 与 start-screen.sh 已运行。以有 sudo 的用户运行：node proof.mjs
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
const run = promisify(execFile);
const BOTS = [
  { user: 'bot-a', display: ':11', port: 9311, word: '甲方案🙂' },
  { user: 'bot-b', display: ':12', port: 9312, word: '乙方案🚀' },
];
const ROUNDS = Number(process.env.ROUNDS ?? 15);

function asBot(bot, script, { display = bot.display, xauth = `/home/${bot.user}/.Xauthority`, input } = {}) {
  const p = run('sudo', ['-n', '-u', bot.user, '-H', 'env', `DISPLAY=${display}`, `XAUTHORITY=${xauth}`, 'bash', '-c', script],
    { encoding: 'buffer', maxBuffer: 64 << 20 });
  if (input !== undefined) { p.child.stdin.end(input); }
  return p.then(r => ({ ok: true, out: r.stdout, err: r.stderr.toString() }), e => ({ ok: false, out: e.stdout ?? Buffer.alloc(0), err: (e.stderr ?? '').toString() }));
}

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

async function drive(bot) {
  const t0 = Date.now(); const steps = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const token = `${bot.word}${i}`;
    const s = Date.now();
    // 每轮换点击位置，避免浏览器把连续点击当成双击或三击选中整行；点完把光标移到末尾。
    const click = await asBot(bot, `xdotool mousemove ${200 + 50 * i} 500 click 1 && xdotool key --clearmodifiers ctrl+End`);
    // 中文和 emoji 走剪贴板粘贴，与现有 computer_input 的做法一致。
    const clip = await asBot(bot, 'xclip -selection clipboard -i >/dev/null 2>&1', { input: token });
    const paste = await asBot(bot, 'xdotool key --clearmodifiers ctrl+v');
    const type = await asBot(bot, `xdotool type --delay 3 ' ${bot.user}-${i}' && xdotool key Return`);
    steps.push({ i, ms: Date.now() - s, ok: click.ok && clip.ok && paste.ok && type.ok });
  }
  return { user: bot.user, totalMs: Date.now() - t0, steps };
}

const result = { ticket: '01-per-bot-screens', at: new Date().toISOString(), rounds: ROUNDS, environment: 'sandbox stand-in: Amazon Linux 2023, Xvfb 21.1, xdotool, xclip, Chrome for Testing 153; 与 Cua 客机镜像使用同一组工具（xvfb、xdotool、xclip、imagemagick、chromium）' };

// 1) 两个 bot 并发操作各自屏幕
const runs = await Promise.all(BOTS.map(drive));
await new Promise(r => setTimeout(r, 500));
result.concurrent = [];
for (const bot of BOTS) {
  const state = await cdpEval(bot.port, 'JSON.stringify({ value: document.getElementById("t").value, clicks: window.clicks })');
  const { value, clicks } = JSON.parse(state);
  const other = BOTS.find(b => b !== bot);
  const lines = value.split('\n').filter(Boolean);
  const expected = Array.from({ length: ROUNDS }, (_, k) => `${bot.word}${k + 1} ${bot.user}-${k + 1}`);
  result.concurrent.push({
    user: bot.user, display: bot.display, clicks, lines: lines.length,
    exactOrder: JSON.stringify(lines) === JSON.stringify(expected),
    foreignTokens: value.includes(other.word) || value.includes(`${other.user}-`),
    sample: lines.slice(0, 2),
    p50StepMs: runs.find(r => r.user === bot.user).steps.map(s => s.ms).sort((a, b) => a - b)[Math.floor(ROUNDS / 2)],
  });
}

// 2) 截图各自屏幕
result.screenshots = [];
for (const bot of BOTS) {
  const shot = await asBot(bot, 'import -display "$DISPLAY" -window root png:-');
  const file = `shot-${bot.user}.png`;
  if (shot.ok) writeFileSync(new URL(file, import.meta.url), shot.out);
  result.screenshots.push({ user: bot.user, ok: shot.ok, bytes: shot.out.length, file });
}

// 3) 越界尝试，期望全部失败
const [a, b] = BOTS;
const cross = {};
cross.otherScreenWithOwnCookie = await asBot(a, 'xdotool getmouselocation', { display: b.display });
cross.readOtherXauthority = await asBot(a, `cat /home/${b.user}/.Xauthority`);
cross.listOtherHome = await asBot(a, `ls /home/${b.user}`);
await asBot(a, 'printf A-clipboard | xclip -selection clipboard -i >/dev/null 2>&1');
const bClip = await asBot(b, 'xclip -selection clipboard -o 2>/dev/null || true');
cross.clipboardLeak = bClip.out.toString().includes('A-clipboard');
result.crossAccess = {
  otherScreenWithOwnCookie: { blocked: !cross.otherScreenWithOwnCookie.ok, err: cross.otherScreenWithOwnCookie.err.trim().split('\n')[0] },
  readOtherXauthority: { blocked: !cross.readOtherXauthority.ok, err: cross.readOtherXauthority.err.trim() },
  listOtherHome: { blocked: !cross.listOtherHome.ok, err: cross.listOtherHome.err.trim() },
  clipboardLeak: cross.clipboardLeak,
};
// 已知缺口：浏览器调试端口监听 127.0.0.1，同机任何用户都能连。
const cdpFromA = await asBot(a, `curl -s -m 2 http://127.0.0.1:${b.port}/json/version`);
result.crossAccess.otherBrowserDebugPort = { blocked: !(cdpFromA.ok && cdpFromA.out.toString().includes('Browser')) };

// 4) 共享 /workspace
await asBot(a, 'echo "from a" > /workspace/note-a.txt');
const bAppend = await asBot(b, 'echo "from b" >> /workspace/note-a.txt && cat /workspace/note-a.txt && stat -c "%U:%G %a" /workspace/note-a.txt');
result.workspace = { bCanAppendAFile: bAppend.ok, content: bAppend.out.toString().trim().split('\n') };

// 5) 资源
const ps = await run('bash', ['-c', "ps -eo user:12,rss,comm --no-headers | awk '$1 ~ /^bot-/ {r[$1\" \"($3 ~ /Xvfb/ ? \"Xvfb\" : \"browser\")]+=$2} END {for (k in r) print k, r[k]}'"]);
result.rssKiB = Object.fromEntries(ps.stdout.trim().split('\n').map(l => { const [u, k, v] = l.split(' '); return [`${u} ${k}`, Number(v)]; }));

result.pass = result.concurrent.every(c => c.exactOrder && !c.foreignTokens && c.clicks === ROUNDS)
  && result.screenshots.every(s => s.ok)
  && result.crossAccess.otherScreenWithOwnCookie.blocked && result.crossAccess.readOtherXauthority.blocked
  && result.crossAccess.listOtherHome.blocked && !result.crossAccess.clipboardLeak && result.workspace.bCanAppendAFile;
writeFileSync(new URL('proof.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 1));
process.exit(0);

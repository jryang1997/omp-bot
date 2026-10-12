import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'ompbot-desktop-proof-'));
const records = [];
let client;
let nextId = 0;
const pending = new Map();
const child = spawn(process.env.OMPBOT_DESKTOP_EXE || join(root, 'node_modules/electron/dist/electron.exe'), process.env.OMPBOT_DESKTOP_EXE ? ['--inspect=0'] : [root, '--inspect=0'], {
  cwd: root, env: { ...process.env, OMPBOT_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.once('exit', () => { exited = true; });
const endpoint = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('Electron main inspector did not become ready')), 30000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited before inspector: ' + code)); });
  child.stderr.on('data', chunk => {
    buffer = (buffer + chunk.toString()).slice(-16000);
    const match = buffer.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
    if (match) { clearTimeout(timer); resolve(match[0]); }
  });
});
child.stdout.resume();
async function main(expression) {
  const id = ++nextId;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Electron evaluation timed out')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description ?? ''));
  return result.result?.value;
}
const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
const windowExpression = `(${electron}).BrowserWindow.getAllWindows()[0]`;
async function page(code) {
  return main(`${windowExpression}.webContents.executeJavaScript(${JSON.stringify(code)})`);
}
async function api(path, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  return page(`(async()=>{const r=await fetch(${JSON.stringify(path)},${JSON.stringify(options)});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;})()`);
}
async function until(check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Desktop state did not become ready');
}
try {
  client = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { client.addEventListener('open', resolve, { once: true }); client.addEventListener('error', reject, { once: true }); });
  client.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
  });
  await until(async () => {
    const loaded = await main(`Boolean(${windowExpression} && ${windowExpression}.webContents.getURL().startsWith('http://') && !${windowExpression}.webContents.isLoading())`);
    if (!loaded) return false;
    try { const state = await api('/api/state'); return Array.isArray(state.bots); } catch { return false; }
  });
  const { bot } = await api('/api/bots', { name: 'DesktopBackgroundProof', role: 'Temporary local native QA', model: 'magpie/commandcode-plan/deepseek/deepseek-v4.1-flash', thinking: 'low', instructions: 'No tools, network, or external messages. Only answer the exact local QA prompt.' });
  const { run } = await api('/api/runs', { botId: bot.id, text: 'Reply exactly DESKTOP_BACKGROUND_NATIVE_493.', timeoutMs: 120000 });
  await main(`${windowExpression}.close()`);
  assert.equal(await main(`${windowExpression}.isVisible()`), false, 'Close must hide the window');
  assert.equal(exited, false, 'Closing window must keep Electron backend alive');
  const terminal = await until(async () => {
    const { run: current } = await api('/api/runs/' + run.id);
    return ['completed', 'failed', 'cancelled', 'interrupted', 'reconciliation_required'].includes(current.state) ? current : false;
  });
  assert.equal(terminal.state, 'completed', terminal.error);
  assert.match(terminal.reply, /DESKTOP_BACKGROUND_NATIVE_493/);
  records.push({ check: 'close-hides-and-native-task-completes', state: terminal.state, windowVisible: false });
  await main(`(${electron}).Menu.getApplicationMenu().items.find(item=>item.label==='窗口').submenu.items.find(item=>item.label==='显示主窗口').click()`);
  await until(() => main(`${windowExpression}.isVisible()`), 10000);
  await page(`window.dispatchEvent(new CustomEvent('ompbot:open-bot',{detail:{botId:${JSON.stringify(bot.id)}}}))`);
  await until(async () => (await page('document.body.innerText')).includes('DesktopBackgroundProof'));
  const png = await main(`${windowExpression}.webContents.capturePage().then(image=>image.toPNG().toString('base64'))`);
  writeFileSync(new URL('./desktop-proof.png', import.meta.url), Buffer.from(png, 'base64'));
  records.push({ check: 'window-restores-and-actual-renderer-captured', visible: true });
 await main(`(${electron}).app.quit()`);
 client.close();
 client = null;
  await until(() => exited, 30000);
  assert.equal(existsSync(join(home, 'state.lock')), false, 'Quit must release the data lease');
  records.push({ check: 'explicit-quit-exits-and-releases-lease', exited: true, lockPresent: false });
  writeFileSync(new URL('./desktop-proof.json', import.meta.url), JSON.stringify({ observedAt: new Date().toISOString(), executable: process.env.OMPBOT_DESKTOP_EXE || 'development-electron', records, limits: ['Native tray menu mouse interaction and Windows OS toast delivery not observed; window close/hide, background native work, restore, renderer and explicit quit actually exercised.'] }, null, 2));
  console.log(JSON.stringify({ check: 'desktop-proof', records }));
} finally {
  client?.close();
  if (!exited) { child.kill(); await until(() => exited, 10000).catch(() => {}); }
  rmSync(home, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ComputerBackend } from '../../src/computer-backend.mjs';
const home = path.resolve('.scratch/qa-loop/packaged-home');
const descriptor = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8'));
const proof = { checks: [] };
const observer = new ComputerBackend({ home, runtimeDir: path.join(process.env.LOCALAPPDATA, 'omp-bot', 'computer-runtime') });
const suffix = Date.now().toString(36);
let bot;
async function api(route, body) {
  const response = await fetch(descriptor.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.ok(response.ok, `${route}: HTTP ${response.status}: ${result.error ?? 'unknown'}`);
  return result;
}
try {
  bot = (await api('/api/bots', { name: `发布验收助手 A ${suffix}` })).bot;
  await api('/api/bots', { name: `发布验收助手 B ${suffix}` });
  const endpoint = `/api/bots/${bot.id}/computer`;
  const bound = (await api(endpoint + '/bind', {})).computer;
  assert.equal(bound.state, 'running');
  proof.checks.push('actual ZIP packaged application boots real Linux VM using shared external resources');
  const human = (await api(endpoint + '/takeover', {})).computer;
  await api(endpoint + '/input', { generation: human.generation, action: 'key', key: 'ctrl+alt+t' });
  const guest = await observer.guest(bound.id);
  const until = Date.now() + 30000;
  let focused = false;
  while (Date.now() < until) {
    const windows = JSON.parse(await guest.callJson('WindowsService/ListWindows', '{}')).windows ?? [];
    focused = windows.some(window => window.focused && /terminal/i.test(window.app?.appId ?? window.app?.name ?? ''));
    if (focused) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(focused, 'actual guest terminal did not become focused');
  await api(endpoint + '/input', { generation: human.generation, action: 'type', text: "printf 'OMP_BOT_015_OK\\n' > /work/release-proof.txt" });
  await api(endpoint + '/input', { generation: human.generation, action: 'key', key: 'Enter' });
  const read = await observer.run(bound.id, { command: 'cat /work/release-proof.txt', cwd: '/work', timeoutMs: 15000, tag: 'release-proof' });
  assert.equal(read.exitCode, 0);
  assert.equal(read.stdout, 'OMP_BOT_015_OK\n');
  proof.checks.push('packaged real keyboard input writes exact guest file');
  const screen = await fetch(descriptor.url + endpoint + '/screen', { headers: { Authorization: `Bearer ${descriptor.token}` } });
  assert.equal(screen.status, 200);
  const png = Buffer.from(await screen.arrayBuffer());
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  fs.writeFileSync(path.resolve('.scratch/qa-loop/packaged-desktop.png'), png);
  proof.screen = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  assert.equal((await api(endpoint + '/stop', {})).computer.state, 'stopped');
  assert.equal((await api(endpoint + '/start', {})).computer.state, 'running');
  const again = await observer.run(bound.id, { command: 'cat /work/release-proof.txt', cwd: '/work', timeoutMs: 15000, tag: 'release-retained' });
  assert.equal(again.stdout, 'OMP_BOT_015_OK\n');
  proof.checks.push('packaged stop and restart retains guest file');
  assert.equal((await api(endpoint + '/stop', {})).computer.state, 'stopped');
  const apk = await fetch(descriptor.url + '/api/mobile/apk', { headers: { Authorization: `Bearer ${descriptor.token}` } });
  assert.equal(apk.status, 200);
  assert.equal((await apk.arrayBuffer()).byteLength, 33467713);
  proof.checks.push('packaged companion APK download remains available');
  proof.status = 'PASS';
} catch (error) {
  proof.status = 'FAIL'; proof.error = error.message; process.exitCode = 1;
} finally {
  if (bot) try { await api(`/api/bots/${bot.id}/computer/stop`, {}); } catch (error) { proof.cleanupError = error.message; }
  await observer.close();
  fs.writeFileSync(path.resolve('.scratch/qa-loop/packaged-proof.json'), JSON.stringify(proof, null, 2));
}
console.log(JSON.stringify(proof));

import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const suffix = randomBytes(8).toString('hex');
const rawName = `ompbot-qmp-raw-proof-${suffix}`;
const rawPath = `\\\\.\\pipe\\${rawName}`;
const controlPath = `\\\\.\\pipe\\ompbot-qmp-control-proof-${suffix}`;
const controlKey = randomBytes(32).toString('hex');
const child = spawn(resolve('.computer-runtime/qemu/qemu-system-x86_64.exe'), ['-machine', 'none', '-nodefaults', '-display', 'none', '-monitor', 'none', '-vnc', 'none', '-name', 'ompbot-broker-proof', '-qmp', `pipe:${rawName}`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => { stderr += data.toString('utf8'); });
let qmp;
let input = '';
let sequence = 1;
const pending = new Map();
let relay;
const proof = { success: false, controlTransport: 'Windows named pipe', persistentRawSession: true };
async function request(command) {
  const id = ++sequence;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('QMP command timeout')); }, 4000);
    pending.set(id, message => { clearTimeout(timer); resolveRequest(message); });
    qmp.write(JSON.stringify({ execute: command, id }) + '\n');
  });
}
async function client(key) {
  return new Promise((resolveClient, reject) => {
    const socket = createConnection({ path: controlPath });
    let bytes = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Control client timeout')); }, 4000);
    socket.on('connect', () => socket.write(JSON.stringify({ key, execute: 'query-name' }) + '\n'));
    socket.on('error', reject);
    socket.on('data', part => {
      bytes += part.toString('utf8');
      if (!bytes.includes('\n')) return;
      clearTimeout(timer);
      socket.destroy();
      resolveClient(JSON.parse(bytes.slice(0, bytes.indexOf('\n'))));
    });
  });
}
try {
  const until = Date.now() + 10000;
  while (!qmp && Date.now() < until) {
    try {
      qmp = await new Promise((resolveSocket, reject) => {
        const socket = createConnection({ path: rawPath });
        socket.once('connect', () => resolveSocket(socket));
        socket.once('error', reject);
      });
    } catch { await sleep(100); }
  }
  if (!qmp) throw new Error('QMP raw pipe unavailable');
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Negotiation timeout')), 4000);
    qmp.on('data', bytes => {
      input += bytes.toString('utf8');
      for (;;) {
        const end = input.indexOf('\n');
        if (end < 0) break;
        const line = input.slice(0, end).trim();
        input = input.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.QMP) qmp.write(JSON.stringify({ execute: 'qmp_capabilities', id: 1 }) + '\n');
        else if (message.id === 1) { clearTimeout(timer); resolveReady(); }
        else if (pending.has(message.id)) { const callback = pending.get(message.id); pending.delete(message.id); callback(message); }
      }
    });
  });
  await ready;
  relay = createServer(socket => {
    let text = '';
    socket.on('data', async bytes => {
      text += bytes.toString('utf8');
      if (!text.includes('\n')) return;
      const value = JSON.parse(text.slice(0, text.indexOf('\n')));
      if (value.key !== controlKey) { socket.end(JSON.stringify({ error: 'unauthorized' }) + '\n'); return; }
      socket.end(JSON.stringify(await request(value.execute)) + '\n');
    });
  });
  await new Promise((resolveListen, reject) => { relay.once('error', reject); relay.listen(controlPath, resolveListen); });
  proof.first = await client(controlKey);
  proof.second = await client(controlKey);
  proof.invalidKey = await client('incorrect');
  proof.success = proof.first.return?.name === 'ompbot-broker-proof' && proof.second.return?.name === 'ompbot-broker-proof' && proof.invalidKey.error === 'unauthorized';
  await request('quit');
} catch (error) {
  proof.error = { code: error.code, message: error.message };
  process.exitCode = 1;
} finally {
  qmp?.destroy();
  relay?.close();
  if (child.exitCode === null) child.kill();
  proof.stderr = stderr;
  writeFileSync(resolve('.scratch/bot-computers/qmp-broker-proof.json'), JSON.stringify(proof, null, 2));
}
console.log(JSON.stringify(proof));

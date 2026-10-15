import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const pipeName = `ompbot-qmp-proof-${randomBytes(8).toString('hex')}`;
const pipe = `\\\\.\\pipe\\${pipeName}`;
const qemu = resolve('.computer-runtime/qemu/qemu-system-x86_64.exe');
const args = ['-machine', 'none', '-nodefaults', '-display', 'none', '-monitor', 'none', '-vnc', 'none', '-name', 'ompbot-pipe-proof', '-qmp', `pipe:${pipeName}`];
const child = spawn(qemu, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => { stderr += data.toString('utf8'); });
const result = { pipeName, args, success: false, connections: [] };
async function session(quit = false) {
  return new Promise((resolveSession, reject) => {
    const socket = createConnection({ path: pipe });
    let input = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('QMP pipe session timed out')); }, 4000);
    socket.on('error', error => { clearTimeout(timeout); reject(error); });
    socket.on('connect', () => socket.write(JSON.stringify({ execute: 'qmp_capabilities', id: 1 }) + '\n'));
    socket.on('data', bytes => {
      input += bytes.toString('utf8');
      for (;;) {
        const end = input.indexOf('\n');
        if (end < 0) break;
        const line = input.slice(0, end).trim();
        input = input.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.QMP) continue;
        if (message.id === 1) {
          if (message.error) result.negotiationError = message.error;
          socket.write(JSON.stringify({ execute: 'query-name', id: 2 }) + '\n');
        }
        else if (message.id === 2) {
          clearTimeout(timeout);
          if (quit) socket.write(JSON.stringify({ execute: 'quit', id: 3 }) + '\n');
          socket.destroy();
          resolveSession(message);
        }
      }
    });
  });
}
try {
  const deadline = Date.now() + 10000;
  let first;
  while (Date.now() < deadline && !first) {
    try { first = await session(); } catch (error) { if (child.exitCode !== null) throw error; await sleep(100); }
  }
  if (!first) throw new Error('QMP pipe did not become ready');
  result.connections.push(first);
  await sleep(100);
  result.connections.push(await session(true));
  result.success = result.connections.every(item => item.return?.name === 'ompbot-pipe-proof');
} catch (error) {
  result.error = { code: error.code, message: error.message };
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill();
  result.stderr = stderr;
  writeFileSync(resolve('.scratch/bot-computers/qmp-pipe-proof.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));

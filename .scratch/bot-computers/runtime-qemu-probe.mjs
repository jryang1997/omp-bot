import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const vm = join(root, 'cua-probe-home', 'vmm', 'qemu', 'ompbot-probe-a');
const tokens = readFileSync(join(vm, 'cmdline'), 'utf8').trim().split(/\s+/);
const bin = tokens.shift();
const args = tokens;
const accelIndex = args.indexOf('-accel');
args[accelIndex + 1] = 'whpx,kernel-irqchip=off';
const log = join(vm, 'qemu-whpx-noirq.log');
const fd = openSync(log, 'w');
const child = spawn(bin, args, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
closeSync(fd);
child.unref();
let exited = false;
let exitCode = null;
child.on('error', error => { exited = true; console.error(error.message); });
child.on('exit', code => { exited = true; exitCode = code; });
const result = { at: new Date().toISOString(), pid: child.pid, accel: args[accelIndex + 1], healthy: false, exitCode: null };
const until = Date.now() + 180000;
while (Date.now() < until && !exited) {
  try {
    const response = await fetch('http://127.0.0.1:56001/health', { signal: AbortSignal.timeout(2000) });
    if (response.status === 204 || response.status === 200) { result.healthy = true; result.healthStatus = response.status; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
result.exitCode = exitCode;
result.checkedAt = new Date().toISOString();
writeFileSync(join(root, 'qemu-whpx-noirq-proof.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.healthy) {
  console.error(readFileSync(log, 'utf8').slice(-4000));
  if (!exited) child.kill();
  process.exitCode = 1;
}

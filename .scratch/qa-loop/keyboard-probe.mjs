import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ComputerBackend } from '../../src/computer-backend.mjs';
const home = path.resolve('.scratch/qa-loop/packaged-home');
const recordRoot = path.join(home, 'computers');
const id = fs.readdirSync(recordRoot).find(id => fs.existsSync(path.join(recordRoot, id, 'vm.json')));
const backend = new ComputerBackend({ home, runtimeDir: path.join(process.env.LOCALAPPDATA, 'omp-bot', 'computer-runtime') });
const proof = {};
try {
  await backend.start(id);
  const client = await backend.guest(id);
  const before = JSON.parse(await client.callJson('WindowsService/ListWindows', '{}')).windows ?? [];
  proof.before = { windows: before.length, focused: before.filter(w => w.focused).map(w => w.app?.appId ?? w.app?.name) };
  await backend.input(id, { action: 'key', key: 'ctrl+alt+t' });
  proof.keyboard = 'virtual keyboard accepted';
  const until = Date.now() + 5000;
  do {
    const windows = JSON.parse(await client.callJson('WindowsService/ListWindows', '{}')).windows ?? [];
    proof.after = { windows: windows.length, focused: windows.filter(w => w.focused).map(w => w.app?.appId ?? w.app?.name) };
    if (proof.after.focused.some(name => /terminal/i.test(name))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  assert.ok(proof.after.focused.some(name => /terminal/i.test(name)), 'System shortcut did not open focused terminal');
  await backend.input(id, { action: 'type', text: "printf 'VIRTUAL_KEYBOARD_OK\\n' > /work/keyboard-proof.txt" });
  await backend.input(id, { action: 'key', key: 'Enter' });
  const command = await backend.run(id, { command: 'cat /work/keyboard-proof.txt', cwd: '/work', timeoutMs: 15000, tag: 'keyboard-fixed' });
  assert.equal(command.stdout, 'VIRTUAL_KEYBOARD_OK\n');
  proof.status = 'PASS';
} finally {
  await backend.stop(id);
  await backend.close();
}
fs.writeFileSync(path.resolve('.scratch/qa-loop/keyboard-probe.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));

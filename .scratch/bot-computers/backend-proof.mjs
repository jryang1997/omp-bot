import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ComputerBackend } from '../../src/computer-backend.mjs';
const home = resolve('.scratch/bot-computers/backend-hardened-proof-home');
const id = 'pc_000000000000000000000002';
const backend = new ComputerBackend({ home });
mkdirSync(home, { recursive: true });
const proof = { startedAt: new Date().toISOString(), home, computerId: id };
try {
  proof.created = await backend.create(id);
  console.log(JSON.stringify({ stage: 'create', state: proof.created.state }));
  const output = await backend.run(id, { command: 'uname -s; printf backend-ready', cwd: '/work', timeoutMs: 10000, tag: 'backend-first-proof' });
  proof.command = output;
  if (output.exitCode !== 0 || output.stdout !== 'Linux\nbackend-ready') throw new Error('Guest command result differed from expected Linux output');
  const shot = await backend.screenshot(id);
  writeFileSync(resolve('.scratch/bot-computers/backend-desktop.png'), shot.data);
  proof.screenshot = { width: shot.width, height: shot.height, bytes: shot.data.length };
  proof.stopped = await backend.stop(id);
  if (proof.stopped.state !== 'stopped') throw new Error('Owned guest did not stop');
  proof.status = 'PASS';
} catch (error) {
  proof.status = 'FAIL';
  proof.error = { code: error.code, name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  try { proof.finalStopped = await backend.stop(id); } catch (error) { proof.cleanupError = { code: error.code, message: error.message }; }
  await backend.close();
  proof.finishedAt = new Date().toISOString();
  writeFileSync(resolve('.scratch/bot-computers/backend-proof.json'), JSON.stringify(proof, null, 2));
}
console.log(JSON.stringify(proof));

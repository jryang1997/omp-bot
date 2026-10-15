import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ComputerBackend } from '../../src/computer-backend.mjs';
const home = path.resolve('.scratch/qa-loop/vm-home');
const runtime = path.resolve('.computer-runtime');
const moved = path.resolve('.scratch/qa-loop/runtime-moved');
const id = 'qa_loop_vm';
let backend = new ComputerBackend({ home, runtimeDir: runtime });
const proof = { checks: [] };
const vmFile = path.join(home, 'computers', id, 'vm.json');
async function command(text, tag) {
  const out = await backend.run(id, { command: text, cwd: '/work', timeoutMs: 15000, tag });
  assert.equal(out.exitCode, 0, out.stderr);
  return out.stdout;
}
try {
  assert.equal((await backend.create(id)).state, 'running');
  assert.equal(await command('uname -s', 'qa-loop-linux'), 'Linux\n');
  await command("printf 'persistent-resource-marker' > /work/qa-loop-proof.txt", 'qa-loop-write');
  assert.equal((await backend.stop(id)).state, 'stopped');
  await backend.close();
  if (!fs.existsSync(moved)) fs.symlinkSync(runtime, moved, 'junction');
  backend = new ComputerBackend({ home, runtimeDir: moved });
  assert.equal((await backend.start(id)).state, 'running');
  assert.equal(await command('cat /work/qa-loop-proof.txt', 'qa-loop-read'), 'persistent-resource-marker');
  proof.checks.push('real stopped VM relocates identical base image and retains guest file');
  assert.equal((await backend.stop(id)).state, 'stopped');
  let record = JSON.parse(fs.readFileSync(vmFile, 'utf8'));
  assert.equal(record.imagePath, path.join(moved, 'images', 'linux.img'));
  assert.equal(record.backingFormat, 'qcow2');
  fs.rmSync(record.disk);
  record.imageSha256 = '00'.repeat(32);
  record.imageBytes = 0;
  fs.writeFileSync(vmFile, JSON.stringify(record));
  assert.equal((await backend.create(id)).state, 'running');
  assert.equal(await command('uname -s', 'qa-loop-recreated'), 'Linux\n');
  record = JSON.parse(fs.readFileSync(vmFile, 'utf8'));
  assert.equal(record.imageSha256, '57feb6ef48446f4eff4541266841ec78d79e0a8662f2e9e3081942c9c4581721');
  assert.equal(record.imageBytes, 1306198016);
  proof.checks.push('real missing guest disk rebuild clears obsolete stamp and boots new disk');
  const shot = await backend.screenshot(id);
  assert.equal(shot.data.readUInt32BE(0), 0x89504e47);
  proof.checks.push('recreated real VM returns SDK screenshot');
  proof.status = 'PASS';
} catch (error) {
  proof.status = 'FAIL'; proof.error = error.message; process.exitCode = 1;
} finally {
  try { await backend.stop(id); } catch (error) { proof.cleanupError = error.message; }
  await backend.close();
  fs.writeFileSync(path.resolve('.scratch/qa-loop/vm-proof.json'), JSON.stringify(proof, null, 2));
  if (proof.status === 'PASS' && !proof.cleanupError) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(proof));

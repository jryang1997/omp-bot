import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const runtime = join(root, 'runtime');
const home = join(root, 'cua-probe-home');
const name = process.argv[2] || 'ompbot-probe-a';
mkdirSync(home, { recursive: true });
const command = ['--embedded', '--state-dir', join(home, 'sandboxes'), 'sb', 'create', 'linux', '--on', 'local', '--kind', 'vm', '--runtime', 'qemu', '--name', name, '--cpu', '2', '--memory', '2048MB', '--wait', 'desktop', '--ready-timeout', '600', '--json'];
const child = spawn(join(runtime, 'cua.exe'), command, {
  env: { ...process.env, CUA_HOME: home, CUA_DEFAULT_ON: 'local', DO_NOT_TRACK: '1', PATH: `${join(runtime, 'qemu')};${process.env.PATH}` },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
child.stderr.on('data', bytes => {
  stderr += bytes.toString('utf8');
  const safe = bytes.toString('utf8').replace(/(token|authorization|secret)[=:]\s*[^\s]+/gi, '$1=[redacted]');
  process.stderr.write(safe);
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  writeFileSync(join(root, `create-${name}.private.json`), JSON.stringify({ at: new Date().toISOString(), code, stdout, stderr }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ name, exitCode: code, resultFile: `create-${name}.private.json`, outputBytes: stdout.length }));
  process.exitCode = code === 0 ? 0 : 1;
});

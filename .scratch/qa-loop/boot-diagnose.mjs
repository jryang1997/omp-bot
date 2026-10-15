import fs from 'node:fs';
import path from 'node:path';
import { ComputerBackend } from '../../src/computer-backend.mjs';
const home = path.resolve('.scratch/qa-loop/packaged-home');
const root = path.join(home, 'computers');
const id = fs.readdirSync(root).find(id => fs.existsSync(path.join(root, id, 'vm.json')));
const backend = new ComputerBackend({ home, runtimeDir: path.join(process.env.LOCALAPPDATA, 'omp-bot', 'computer-runtime') });
const proof = { samples: [] };
try {
  const start = Date.now();
  await backend.start(id);
  const client = await backend.guest(id);
  for (let sample = 0; sample < 4; sample++) {
    const caps = await client.capabilities();
    const windows = JSON.parse(await client.callJson('WindowsService/ListWindows', '{}')).windows ?? [];
    const processes = await backend.run(id, { command: 'ps -C xfwm4,xfce4-session,xfce4-terminal,xfdesktop,Xorg,lightdm -o pid,comm', cwd: '/work', timeoutMs: 10000, tag: 'boot-processes-' + sample });
    const item = { elapsedMs: Date.now() - start, initialized: caps.initialized, features: caps.features, windows: windows.map(w => ({ app: w.app?.appId ?? w.app?.name, focused: w.focused, title: w.title })), processes: processes.stdout };
    proof.samples.push(item);
    const shot = await backend.screenshot(id);
    fs.writeFileSync(path.resolve('.scratch/qa-loop/boot-' + sample + '.png'), shot.data);
    if (sample < 3) await new Promise(resolve => setTimeout(resolve, 5000));
  }
} finally {
  await backend.stop(id);
  await backend.close();
  fs.writeFileSync(path.resolve('.scratch/qa-loop/boot-proof.json'), JSON.stringify(proof, null, 2));
}
console.log(JSON.stringify(proof));

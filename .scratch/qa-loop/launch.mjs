import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const env = { ...process.env, OMPBOT_HOME: resolve('.scratch/qa-loop/home'), OMPBOT_COMPUTER_RUNTIME: resolve('.computer-runtime') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve('.'), '--user-data-dir=' + resolve('.scratch/qa-loop/profile'), '--remote-debugging-port=9472'], { env, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const env = { ...process.env, OMPBOT_HOME: resolve('.scratch/qa-loop/packaged-home') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OMPBOT_COMPUTER_RUNTIME;
const child = spawn(resolve('.scratch/qa-loop/portable-extracted/omp-bot.exe'), ['--user-data-dir=' + resolve('.scratch/qa-loop/packaged-profile'), '--remote-debugging-port=9473'], { env, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });

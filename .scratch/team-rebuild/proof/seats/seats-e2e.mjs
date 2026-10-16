// 07 沙盒端到端：真实 Xvfb、cua-spacesd 和 guest/omp-seat，两个座席的截图、输入、命令、传文件互不串。
// 共享虚拟机换成沙盒本身：sudo 起一个 root 的 cua-spacesd 当管理通道，座席端口不经 QEMU 转发，直接连。
// 运行：cd /data/omp-bot && node .scratch/team-rebuild/proof/seats/seats-e2e.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestDesk, connectSpacesd, probeSpacesdHealth, redactSecrets } from '../../../../src/computer-backend.mjs';
import { SEAT_SCRIPT, SeatBackend, seatUser } from '../../../../src/computer-seats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const MGMT_PORT = 3399;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sudo = (...args) => execFileSync('sudo', ['-n', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha = buf => createHash('sha256').update(buf).digest('hex');
const proof = { startedAt: new Date().toISOString(), host: { cpus: os.cpus().length, kernel: os.release() }, checks: [] };
function pass(name, evidence = {}) {
  proof.checks.push({ name, ...evidence });
  console.log(`PASS  ${name}`);
}

/** 沙盒版共享虚拟机：root spacesd 当管理通道。 */
class SandboxVm {
  seatListen = '127.0.0.1';
  creates = [];
  stops = 0;
  #token = randomBytes(24).toString('hex');
  #dir;
  #desk;
  constructor(dir) {
    this.#dir = dir;
    this.#desk = new GuestDesk({
      connect: () => connectSpacesd(`http://127.0.0.1:${MGMT_PORT}`, this.#token),
      describe: error => redactSecrets(error?.message ?? error, [this.#token]),
    });
  }
  async status() {
    return { state: (await probeSpacesdHealth(MGMT_PORT)) ? 'running' : 'stopped', error: null };
  }
  async create({ machine } = {}) {
    this.creates.push(machine);
    const tokenFile = path.join(this.#dir, 'mgmt-token');
    fs.writeFileSync(tokenFile, `${this.#token}\n`, { mode: 0o600 });
    const log = fs.openSync(path.join(this.#dir, 'mgmt-spacesd.log'), 'a');
    spawn('sudo', ['-n', 'cua-spacesd', 'serve', '--listen', `127.0.0.1:${MGMT_PORT}`, '--token-file', tokenFile,
      '--data-dir', path.join(this.#dir, 'mgmt-data'), '--no-mcp', '--quic-port', '0'], { detached: true, stdio: ['ignore', log, log] }).unref();
    for (let i = 0; i < 100 && !(await probeSpacesdHealth(MGMT_PORT)); i += 1) await sleep(100);
    this.#desk.reset();
    return await this.status();
  }
  async stop() {
    this.stops += 1;
    try { sudo('pkill', '-f', `cua-spacesd serve --listen 127.0.0.1:${MGMT_PORT}`); } catch {}
    for (let i = 0; i < 50 && (await probeSpacesdHealth(MGMT_PORT)); i += 1) await sleep(100);
    this.#desk.reset();
    return await this.status();
  }
  management() {
    return {
      run: (options, hooks) => this.#desk.run(options, hooks),
      uploadFile: (transfer, options) => this.#desk.uploadFile(transfer, options),
    };
  }
  seatDesk(port, token) {
    return new GuestDesk({
      connect: () => connectSpacesd(`http://127.0.0.1:${port}`, token),
      describe: error => redactSecrets(error?.message ?? error, [token]),
    });
  }
  async seatHealthy(port) {
    return await probeSpacesdHealth(port);
  }
}

function pixel(file, x, y) {
  return execFileSync('magick', [file, '-alpha', 'off', '-format', `%[pixel:p{${x},${y}}]`, 'info:'], { encoding: 'utf8' }).trim();
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ompbot-seats-e2e-'));
const vm = new SandboxVm(home);
const seats = new SeatBackend({ home, vm, machine: { cpus: 2, memoryGb: 8 } });
const A = 'pc_e2e_a';
const B = 'pc_e2e_b';
const userA = seatUser(A);
const userB = seatUser(B);
const run = async (id, command, cwd) => {
  const out = await seats.run(id, { command, ...(cwd ? { cwd } : {}), timeoutMs: 20_000, tag: `e2e-${randomBytes(3).toString('hex')}` });
  return out;
};
const ok = async (id, command, cwd) => {
  const out = await run(id, command, cwd);
  assert.equal(out.exitCode, 0, `${id} ${command}: ${out.stderr}`);
  return String(out.stdout).trim();
};

try {
  // 干净起点：没有客机脚本（走补装），没有旧的座席用户
  try { sudo('rm', '-f', SEAT_SCRIPT); } catch {}
  for (const user of [userA, userB, 'omp-t1']) {
    try { sudo('pkill', '-KILL', '-u', user); } catch {}
    try { sudo('userdel', '-r', user); } catch {}
  }
  await vm.stop();

  const [stA, stB] = await Promise.all([seats.start(A), seats.start(B)]);
  assert.deepEqual([stA.state, stB.state], ['running', 'running']);
  assert.deepEqual([stA.vm.state, stA.seat.ready, stB.seat.ready], ['running', true, true]);
  assert.equal(vm.creates.length, 1);
  const installed = sudo('sha256sum', SEAT_SCRIPT).slice(0, 64);
  assert.equal(installed, sha(fs.readFileSync(path.join(REPO, 'guest/omp-seat'))));
  const mode = sudo('stat', '-c', '%U:%G %a', SEAT_SCRIPT).trim();
  assert.equal(mode, 'root:root 755');
  pass('两个座席同时启动，共享电脑只开一次，客机脚本经管理通道补装', { creates: vm.creates, seatScript: { sha256: installed, mode }, users: [userA, userB] });

  const idA = (await ok(A, 'printf "%s %s %s" "$(id -un)" "$HOME" "$(pwd)"')).split(' ');
  const idB = (await ok(B, 'printf "%s %s %s" "$(id -un)" "$HOME" "$(pwd)"')).split(' ');
  assert.deepEqual(idA, [userA, `/home/${userA}`, `/home/${userA}/work`]);
  assert.deepEqual(idB, [userB, `/home/${userB}`, `/home/${userB}/work`]);
  const groupsA = await ok(A, 'id -nG');
  assert.match(groupsA, /\bteam\b/);
  assert.doesNotMatch(groupsA, /\b(sudo|wheel|admin)\b/);
  assert.notEqual((await run(A, 'sudo -n true')).exitCode, 0, '座席用户没有 sudo');
  assert.equal(await ok(A, 'pwd', '~'), `/home/${userA}`);
  pass('命令以各自座席用户运行，默认在 ~/work，没有 sudo', { a: idA, b: idB, groupsA });

  // 屏幕：各画一块颜色，截图只看到自己的
  for (const [id, color] of [[A, 'red'], [B, 'blue']]) {
    await ok(id, `magick -size 300x200 xc:${color} ~/work/block.png && (nohup display -geometry +0+0 ~/work/block.png >/dev/null 2>&1 &) ; sleep 1.5`);
  }
  const shots = {};
  for (const [id, name] of [[A, 'a'], [B, 'b']]) {
    const shot = await seats.screenshot(id);
    const file = path.join(HERE, `seat-${name}.png`);
    fs.writeFileSync(file, shot.data);
    shots[name] = { width: shot.width, height: shot.height, block: pixel(file, 50, 50), outside: pixel(file, 900, 700) };
  }
  assert.equal(shots.a.block, 'srgb(255,0,0)');
  assert.equal(shots.b.block, 'srgb(0,0,255)');
  assert.deepEqual([shots.a.width, shots.a.height], [1280, 800]);
  pass('两个座席的截图来自各自的屏幕', shots);

  // 输入：A 移鼠标，只有 A 的指针动
  const before = await ok(B, 'xdotool getmouselocation --shell | head -2 | tr "\\n" " "');
  await seats.input(A, { action: 'move', x: 111, y: 222 });
  const locA = await ok(A, 'xdotool getmouselocation --shell | head -2 | tr "\\n" " "');
  const locB = await ok(B, 'xdotool getmouselocation --shell | head -2 | tr "\\n" " "');
  assert.equal(locA, 'X=111 Y=222');
  assert.equal(locB, before);
  await seats.input(B, { action: 'move', x: 333, y: 44 });
  assert.equal(await ok(B, 'xdotool getmouselocation --shell | head -2 | tr "\\n" " "'), 'X=333 Y=44');
  assert.equal(await ok(A, 'xdotool getmouselocation --shell | head -2 | tr "\\n" " "'), 'X=111 Y=222');
  pass('输入只进自己的屏幕', { a: locA, bUntouched: locB });

  // 文件和主目录隔离
  await ok(A, 'printf secret-a > ~/work/secret.txt');
  const peek = await run(B, `cat /home/${userA}/work/secret.txt; ls /home/${userA}`);
  assert.notEqual(peek.exitCode, 0);
  assert.match(peek.stderr, /Permission denied/);
  const xPeek = await run(B, 'DISPLAY=:20 XAUTHORITY="$HOME/.Xauthority" xdotool getmouselocation');
  assert.notEqual(xPeek.exitCode, 0, 'B 连不上 A 的屏幕');
  const tokenPeek = await run(B, `cat /home/${userA}/.omp-seat/token`);
  assert.notEqual(tokenPeek.exitCode, 0);
  const local = path.join(home, 'up.txt');
  fs.writeFileSync(local, 'uploaded-to-a');
  await seats.uploadFile(A, { localPath: local, path: '~/work/in/up.txt' });
  assert.equal(await ok(A, 'cat ~/work/in/up.txt; printf " %s" "$(stat -c %U ~/work/in/up.txt)"'), `uploaded-to-a ${userA}`);
  const back = path.join(home, 'back.txt');
  await seats.downloadFile(A, { path: '~/work/secret.txt', localPath: back });
  assert.equal(fs.readFileSync(back, 'utf8'), 'secret-a');
  pass('B 读不到 A 的主目录、令牌和屏幕；~ 路径的上传下载落在自己主目录', { peekStderr: peek.stderr.trim().split('\n'), xPeekExit: xPeek.exitCode });

  // 拿 B 的令牌连 A 的 spacesd：被拒
  const seatFile = JSON.parse(fs.readFileSync(path.join(home, 'computers', 'seats.json'), 'utf8'));
  const wrong = vm.seatDesk(seatFile.seats[A].port, seatFile.seats[B].token);
  let rejected = null;
  try {
    await wrong.run({ command: 'id -un', cwd: '/', timeoutMs: 5000, tag: 'e2e-wrong' });
  } catch (error) {
    rejected = String(error?.message ?? error).slice(0, 200);
  }
  assert.ok(rejected, '换令牌应该连不上');
  assert.ok(!rejected.includes(seatFile.seats[B].token));
  assert.equal(fs.statSync(path.join(home, 'computers', 'seats.json')).mode & 0o777, 0o600);
  pass('一个座席的令牌连不上别的座席，seats.json 0600', { rejected });

  // 装系统包：经管理通道 root 跑；沙盒是 Amazon Linux 没有 apt-get，脚本如实报
  const apt = await seats.installPackages(A, ['hello']);
  assert.equal(apt.exitCode, 4);
  assert.match(apt.stderr, /apt-get/);
  await assert.rejects(seats.installPackages(A, ['-oops']), e => e.code === 'computer_invalid_argument');
  pass('装包经管理通道以 root 运行 omp-seat install-packages，坏包名在宿主就被拒', { exitCode: apt.exitCode, stderr: apt.stderr.trim() });

  // 停 A：只停 A 的进程，共享电脑还开着，B 照常
  let st = await seats.stop(A);
  assert.equal(st.state, 'stopped');
  assert.equal(st.vm.state, 'running');
  assert.equal(vm.stops, 1, '只有开头清场那一次');
  const leftA = (() => { try { return sudo('pgrep', '-u', userA).trim(); } catch { return ''; } })();
  assert.equal(leftA, '');
  assert.equal(await ok(B, 'id -un'), userB);
  assert.equal(sudo(SEAT_SCRIPT, 'count').trim(), '1');
  pass('停一个座席只停它自己的进程，共享电脑和另一个座席照常', { leftCount: 1 });

  // 停 B：最后一个，关共享电脑
  st = await seats.stop(B);
  assert.deepEqual([st.state, st.vm.state], ['stopped', 'stopped']);
  assert.equal(vm.stops, 2);
  assert.equal(sudo(SEAT_SCRIPT, 'count').trim(), '0');
  // 文件留着，再开还在
  st = await seats.start(A);
  assert.equal(st.state, 'running');
  assert.equal(await ok(A, 'cat ~/work/secret.txt'), 'secret-a');
  await seats.stop(A);
  pass('最后一个座席停掉后关共享电脑，再开文件还在', { stops: vm.stops });

  proof.result = `${proof.checks.length}/${proof.checks.length} PASS`;
} catch (error) {
  proof.error = String(error?.stack ?? error);
  console.log(`FAIL  ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try { await vm.stop(); } catch {}
  for (const user of [userA, userB]) {
    try { sudo('pkill', '-KILL', '-u', user); } catch {}
  }
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(HERE, 'seats-e2e.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(proof.result ?? 'FAILED');
  process.exit(process.exitCode ?? 0);
}

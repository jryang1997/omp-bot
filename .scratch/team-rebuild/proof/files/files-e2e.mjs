// 08 沙盒端到端：真实 sshfs、guest/omp-seat 和 src/file-share.mjs，两个座席挂 /workspace 和各自的 ~/work。
// 共享虚拟机换成沙盒本身（同 07 的 seats-e2e）：sudo 起一个 root 的 cua-spacesd 当管理通道，
// 客机连回宿主的地址从 10.0.2.2 换成 127.0.0.1。SFTP 服务以沙盒普通用户运行，跟 omp-bot 在宿主上一样。
// 准备：sudo chmod 0666 /dev/fuse（沙盒里 /dev/fuse 是 0600，普通用户的 sshfs 挂不上；真客机里本来就是 0666）
// 运行：cd /data/omp-bot && node .scratch/team-rebuild/proof/files/files-e2e.mjs
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestDesk, connectSpacesd, probeSpacesdHealth, redactSecrets } from '../../../../src/computer-backend.mjs';
import { SeatBackend, SeatShare, seatUser } from '../../../../src/computer-seats.mjs';
import { seatShareRoots } from '../../../../src/features/computers.mjs';
import { FileShare, WORKSPACE_USER } from '../../../../src/file-share.mjs';
import { teamPaths, teamRoot } from '../../../../src/team.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MGMT_PORT = 3398;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sudo = (...args) => execFileSync('sudo', ['-n', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const trySudo = (...args) => { try { return sudo(...args); } catch (e) { return null; } };
// 碰到挂载的命令要异步跑：SFTP 服务就在这个进程里，同步等会把它自己卡死
const sudoAsync = async (...args) => (await promisify(execFile)('sudo', ['-n', ...args], { encoding: 'utf8', timeout: 20_000 })).stdout;
const trySudoAsync = async (...args) => { try { return await sudoAsync(...args); } catch { return null; } };
const proof = { startedAt: new Date().toISOString(), host: { kernel: os.release(), sshfs: execFileSync('sshfs', ['--version'], { encoding: 'utf8' }).split('\n')[0] }, checks: [] };
function pass(name, evidence = {}) {
  proof.checks.push({ name, ...evidence });
  console.log(`PASS  ${name}`);
}

/** 沙盒版共享虚拟机：root spacesd 当管理通道，客机经 127.0.0.1 连回宿主。 */
class SandboxVm {
  seatListen = '127.0.0.1';
  shareHost = '127.0.0.1';
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
  async create() {
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
    trySudo('pkill', '-f', `cua-spacesd serve --listen 127.0.0.1:${MGMT_PORT}`);
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ompbot-files-e2e-'));
const BOT_A = 'bot_e2e_a';
const BOT_B = 'bot_e2e_b';
const A = 'pc_files_a';
const B = 'pc_files_b';
const userA = seatUser(A);
const userB = seatUser(B);
const OUTSIDER = 'omp-outsider';
const bots = new Map([[A, BOT_A], [B, BOT_B]]);
const roots = seatShareRoots({ home, getBot: id => ([...bots.values()].includes(id) ? { id } : null), teamPaths, teamRoot });
const workspace = path.join(teamRoot(home), 'workspace');
const workA = teamPaths(home, BOT_A).workDir;
const workB = teamPaths(home, BOT_B).workDir;
let fileShare = new FileShare({ home, roots });
let share = new SeatShare({ fileShare, botIdFor: cid => bots.get(cid) ?? null });
const vm = new SandboxVm(home);
let seats = new SeatBackend({ home, vm, share });

const run = (id, command) => seats.run(id, { command, timeoutMs: 30_000, tag: `files-${randomBytes(3).toString('hex')}` });
const ok = async (id, command) => {
  const out = await run(id, command);
  assert.equal(out.exitCode, 0, `${id} ${command}: ${out.stderr}`);
  return String(out.stdout).trim();
};
const fails = async (id, command) => {
  const out = await run(id, command);
  assert.notEqual(out.exitCode, 0, `${id} ${command} 应该失败：${out.stdout}`);
  return String(out.stderr).trim();
};
const mounts = () => fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').filter(l => l.includes('fuse.sshfs'));
const seatStatus = async user => Object.fromEntries((await sudoAsync('/usr/local/lib/omp-bot/omp-seat', 'status', user)).trim().split('\n').map(l => l.split('=')));

function cleanup() {
  for (const m of mounts()) trySudo('umount', '-l', m.split(' ')[1]);
  for (const user of [userA, userB, OUTSIDER]) {
    trySudo('pkill', '-KILL', '-u', user);
  }
}

try {
  cleanup();
  for (const user of [userA, userB, OUTSIDER]) trySudo('userdel', '-r', user);
  trySudo('rm', '-f', '/workspace');
  await vm.stop();
  fs.mkdirSync(workspace, { recursive: true });

  // 1. 两个座席起来，两类目录都挂上
  const [stA, stB] = await Promise.all([seats.start(A), seats.start(B)]);
  assert.deepEqual([stA.state, stB.state], ['running', 'running']);
  const sa = await seatStatus(userA);
  const sb = await seatStatus(userB);
  assert.deepEqual([sa.workspace, sa.work, sb.work], ['1', '1', '1']);
  const ms = mounts();
  assert.equal(ms.filter(l => l.startsWith(`${WORKSPACE_USER}@127.0.0.1:/ /srv/omp-share/workspace `)).length, 1);
  assert.equal(ms.filter(l => l.startsWith(`${BOT_A}@127.0.0.1:/ /home/${userA}/work `)).length, 1);
  assert.equal(ms.filter(l => l.startsWith(`${BOT_B}@127.0.0.1:/ /home/${userB}/work `)).length, 1);
  assert.equal(fs.readlinkSync('/workspace'), '/srv/omp-share/workspace');
  assert.equal((await sudoAsync('stat', '-c', '%U:%G %a', '/srv/omp-share')).trim(), 'root:team 750');
  assert.equal(fileShare.port > 0, true);
  // 沙盒里没有 ss，直接读 /proc/net/tcp{,6}：状态 0A 是 LISTEN，0100007F 是 127.0.0.1
  const hexPort = fileShare.port.toString(16).toUpperCase().padStart(4, '0');
  const listen = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').slice(1))
    .map(l => l.trim().split(/\s+/)).filter(c => c[3] === '0A' && c[1].endsWith(`:${hexPort}`)).map(c => c[1]);
  assert.deepEqual(listen, [`0100007F:${hexPort}`]);
  pass('两个座席起来后 /workspace 和各自的 ~/work 都挂上，SFTP 服务只听 127.0.0.1', { port: fileShare.port, mounts: ms.map(l => l.split(' ').slice(0, 3).join(' ')), listen });

  // 2. 双向即时可见：写完马上读，不等
  fs.writeFileSync(path.join(workspace, 'from-host.txt'), 'host v1\n');
  assert.equal(await ok(A, 'cat /workspace/from-host.txt'), 'host v1');
  fs.writeFileSync(path.join(workspace, 'from-host.txt'), 'host v2 longer\n');
  assert.equal(await ok(B, 'cat /workspace/from-host.txt'), 'host v2 longer');
  await ok(B, 'echo "guest b" > /workspace/from-b.txt');
  assert.equal(fs.readFileSync(path.join(workspace, 'from-b.txt'), 'utf8'), 'guest b\n');
  fs.writeFileSync(path.join(workA, 'mine.txt'), 'a private\n');
  assert.equal(await ok(A, 'cat ~/work/mine.txt'), 'a private');
  await ok(A, 'echo "a wrote" > ~/work/out.txt');
  assert.equal(fs.readFileSync(path.join(workA, 'out.txt'), 'utf8'), 'a wrote\n');
  fs.rmSync(path.join(workspace, 'from-host.txt'));
  await fails(A, 'cat /workspace/from-host.txt');
  fs.mkdirSync(path.join(workspace, 'dir1'));
  assert.equal(await ok(A, 'test -d /workspace/dir1 && echo yes'), 'yes');
  pass('宿主和客机双向即时可见：新建、改写变长、删除、建目录，写完马上读', {});

  // 3. 改名落盘：编辑器式保存（写临时文件再改名覆盖），宿主改名客机马上看到
  fs.writeFileSync(path.join(workspace, 'notes.md'), 'old\n');
  await ok(A, 'printf "new from editor\\n" > /workspace/.notes.md.tmp && mv -f /workspace/.notes.md.tmp /workspace/notes.md');
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8'), 'new from editor\n');
  assert.equal(fs.existsSync(path.join(workspace, '.notes.md.tmp')), false);
  fs.renameSync(path.join(workspace, 'notes.md'), path.join(workspace, 'renamed.md'));
  assert.equal(await ok(B, 'cat /workspace/renamed.md && test ! -e /workspace/notes.md && echo gone'), 'new from editor\ngone');
  await ok(A, 'mkdir -p ~/work/proj && echo x > ~/work/proj/a && mv ~/work/proj ~/work/proj2');
  assert.equal(fs.readFileSync(path.join(workA, 'proj2', 'a'), 'utf8'), 'x\n');
  pass('改名落盘：临时文件改名覆盖、宿主改名、目录改名', {});

  // 4. 并发追加：两个座席各追加 200 行，宿主同时追加 200 行
  const log = path.join(workspace, 'log.txt');
  fs.writeFileSync(log, '');
  const append = (id, tag) => ok(id, `for i in $(seq 200); do echo ${tag}-$i >> /workspace/log.txt; done`);
  const hostAppend = (async () => {
    for (let i = 1; i <= 200; i += 1) {
      fs.appendFileSync(log, `host-${i}\n`);
      if (i % 20 === 0) await sleep(5);
    }
  })();
  await Promise.all([append(A, 'a'), append(B, 'b'), hostAppend]);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 600);
  assert.equal(new Set(lines).size, 600);
  for (const tag of ['a', 'b', 'host']) assert.equal(lines.filter(l => l.startsWith(`${tag}-`)).length, 200);
  pass('并发追加不丢：两个座席和宿主各 200 行，共 600 行不重不丢', { lines: lines.length, unique: new Set(lines).size });

  // 5. 越出根被拒
  fs.writeFileSync(path.join(teamRoot(home), 'outside.txt'), 'outside\n');
  fs.symlinkSync('/etc/hostname', path.join(workspace, 'abs-link'));
  fs.symlinkSync('../outside.txt', path.join(workspace, 'rel-link'));
  fs.symlinkSync(workB, path.join(workA, 'to-b'));
  await fails(A, 'cat /workspace/abs-link');
  await fails(A, 'cat /workspace/rel-link');
  await fails(A, 'ls ~/work/to-b/');
  await fails(A, 'ln -s /etc/passwd /workspace/p');
  await fails(A, 'ln -s ../outside.txt /workspace/q');
  assert.equal(fs.existsSync(path.join(workspace, 'p')), false);
  await ok(A, 'echo t > /workspace/target.txt && ln -s target.txt /workspace/inside-link && cat /workspace/inside-link');
  assert.equal(fs.readlinkSync(path.join(workspace, 'inside-link')), 'target.txt');
  // /workspace/.. 是客机本地的 /srv/omp-share，不是宿主的 team 目录
  assert.equal(await ok(A, 'ls /workspace/.. | tr "\\n" " "'), 'workspace');
  pass('越出根被拒：宿主建的绝对和相对外链读不到，客机建不了外链，根内链接照常', {});

  // 6. 钥匙：A 的钥匙登不进 B 和 workspace，陌生钥匙登不进
  const sftpProbe = (who, key) => `sftp -b /dev/null -i ${key} -P ${fileShare.port} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlias=omp-bot-share -o UserKnownHostsFile=~/.omp-seat/share-known-hosts ${who}@127.0.0.1`;
  await ok(A, sftpProbe(BOT_A, '~/.omp-seat/share-key'));
  const wrongUser = await fails(A, sftpProbe(BOT_B, '~/.omp-seat/share-key'));
  await fails(A, sftpProbe(WORKSPACE_USER, '~/.omp-seat/share-key'));
  await ok(A, 'ssh-keygen -q -t ed25519 -N "" -f ~/stranger && echo made');
  await fails(A, sftpProbe(BOT_A, '~/stranger'));
  await ok(A, 'rm -f ~/stranger ~/stranger.pub');
  assert.equal(await ok(A, 'stat -c %a ~/.omp-seat/share-key'), '400');
  pass('钥匙：自己的钥匙能登自己的根，登别的 bot 和 workspace 被拒，陌生钥匙被拒，钥匙文件 0400', { wrongUser: wrongUser.split('\n').slice(-1)[0] });

  // 7. ~/work 只有这个 bot 能读写：别的座席、root、组外用户都进不去
  await fails(B, `ls /home/${userA}/work`);
  assert.equal(await trySudoAsync('ls', `/home/${userA}/work`), null, 'root 也进不去 bot 的 ~/work（FUSE 挂载没开 allow_other）');
  assert.equal((await ok(B, 'ls ~/work | tr "\\n" " "')).includes('mine.txt'), false);
  pass('~/work 只有这个 bot 能读写：别的座席和客机 root 都读不到', {});

  // 8. /workspace 归 team 组：组内都能写、能 chmod +x 跑脚本、git 能用；组外用户进不去
  await ok(A, 'printf "#!/bin/sh\\necho ran\\n" > /workspace/run.sh && chmod +x /workspace/run.sh');
  assert.equal(await ok(B, '/workspace/run.sh'), 'ran');
  assert.ok((fs.statSync(path.join(workspace, 'run.sh')).mode & 0o100) !== 0, '宿主上也是可执行的');
  await ok(B, 'echo b2 >> /workspace/from-b.txt && cd /workspace && git init -q repo && cd repo && git status --short && echo ok');
  assert.ok(fs.existsSync(path.join(workspace, 'repo', '.git', 'HEAD')));
  trySudo('useradd', '-M', OUTSIDER);
  assert.equal(await trySudoAsync('runuser', '-u', OUTSIDER, '--', 'ls', '/workspace/'), null, '组外用户进不去 /workspace');
  assert.equal((await sudoAsync('stat', '-c', '%U:%G', '-L', '/workspace')).trim(), 'root:team');
  pass('/workspace 归 team 组：组内能写、chmod +x 能跑、git 能用，组外用户进不去', {});

  // 9. 服务随 omp-bot 启停：关掉再起（同一个端口），客机 sshfs 自己接上；再 up 不重挂
  const before = mounts().join('\n');
  await seats.close();
  // 服务停着时查状态不会卡住，如实报挂载不可用
  const t0 = Date.now();
  const down = await seatStatus(userA);
  const statusMs = Date.now() - t0;
  assert.deepEqual([down.workspace, down.work], ['0', '0']);
  assert.ok(statusMs < 10_000, `服务停着时 status 花了 ${statusMs}ms`);
  fileShare = new FileShare({ home, roots });
  share = new SeatShare({ fileShare, botIdFor: cid => bots.get(cid) ?? null });
  seats = new SeatBackend({ home, vm, share });
  const portBefore = Number(JSON.parse(fs.readFileSync(path.join(home, 'computers', 'file-share', 'port.json'), 'utf8')).port);
  await seats.status(A); // 共享电脑开着，服务跟着起来
  for (let i = 0; i < 50 && !fileShare.port; i += 1) await sleep(20);
  assert.equal(fileShare.port, portBefore, '优先用上次的端口');
  fs.writeFileSync(path.join(workspace, 'after-restart.txt'), 'back\n');
  assert.equal(await ok(A, 'cat /workspace/after-restart.txt'), 'back');
  assert.equal(await ok(A, 'cat ~/work/mine.txt'), 'a private');
  await seats.start(A);
  assert.equal(mounts().join('\n'), before, '挂载还活着就不重挂');
  pass('服务随 omp-bot 启停：停着时查状态不卡、报不可用，重启后用回同一个端口，客机 sshfs 自己接上，再开座席不重挂', { port: portBefore, statusWhileDownMs: statusMs });

  // 10. 停座席：先卸 ~/work 再停进程，宿主的文件都在；最后一个停掉关共享电脑
  await seats.stop(A);
  assert.equal(mounts().some(l => l.includes(`/home/${userA}/work `)), false);
  assert.equal(mounts().some(l => l.includes(`/home/${userB}/work `)), true);
  assert.equal(fs.readFileSync(path.join(workA, 'mine.txt'), 'utf8'), 'a private\n');
  assert.equal(await ok(B, 'cat /workspace/renamed.md'), 'new from editor');
  await seats.stop(B);
  assert.equal(mounts().some(l => l.includes('/work ')), false);
  assert.equal((await vm.status()).state, 'stopped');
  pass('停座席先卸 ~/work，另一个座席不受影响，宿主的文件都在，最后一个停掉关共享电脑', { vmStops: vm.stops });

  proof.result = `${proof.checks.length}/${proof.checks.length} PASS`;
} catch (error) {
  proof.error = String(error?.stack ?? error);
  console.log(`FAIL  ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try { await seats.close(); } catch {}
  try { await vm.stop(); } catch {}
  cleanup();
  trySudo('userdel', OUTSIDER);
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(HERE, 'files-e2e.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(proof.result ?? 'FAILED');
  process.exit(process.exitCode ?? 0);
}

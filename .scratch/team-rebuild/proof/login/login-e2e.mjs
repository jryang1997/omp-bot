// 09 沙盒端到端：真实 Xvfb、cua-spacesd、Chromium 和仓库里的 guest/omp-seat、guest/omp-login-sync、
// guest/chromium.d/omp-shared-login。共享虚拟机换成沙盒本身（同 07、08），两个脚本经座席层的补装装进去。
// 登录屏上的登录走用户的路径：座席层的输入接口点地址栏、打字、回车，再点「完成」（publishLogin）。
// bot 的浏览器开在自己的屏幕上，经 chromium.d 钩子以 bot 身份同步，从窗口标题读当前登录者。
// 步骤和结论对照 02 的 .scratch/team-architecture/login-proof/proof.json。
// 运行：cd /data/omp-bot && node .scratch/team-rebuild/proof/login/login-e2e.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestDesk, connectSpacesd, probeSpacesdHealth, redactSecrets } from '../../../../src/computer-backend.mjs';
import { BROWSER_QUIT, CHROMIUM_HOOK, LOGIN_SEAT_ID, LOGIN_STORE, LOGIN_SYNC_SCRIPT, SeatBackend, seatUser } from '../../../../src/computer-seats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const MGMT_PORT = 3397;
const SITE_PORT = 18091;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const OTHER = `http://localhost:${SITE_PORT}`;
const WRAPPER = '/usr/local/sbin/chromium';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sudo = (...args) => execFileSync('sudo', ['-n', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const trySudo = (...args) => { try { return sudo(...args); } catch { return null; } };
const proof = {
  ticket: '09-shared-login',
  chromium: execFileSync('/usr/local/bin/chromium', ['--version'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  steps: {},
  checks: [],
};
function pass(name, evidence = {}) {
  proof.checks.push({ name, ...evidence });
  console.log(`PASS  ${name}`);
}

/** 沙盒版共享虚拟机：root spacesd 当管理通道。 */
class SandboxVm {
  seatListen = '127.0.0.1';
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ompbot-login-e2e-'));
const vm = new SandboxVm(home);
const seats = new SeatBackend({ home, vm });
const A = 'pc_login_a';
const B = 'pc_login_b';
const users = [seatUser(A), seatUser(B), 'omp-login'];
const run = (id, command, timeoutMs = 40_000) => seats.run(id, { command, cwd: '~', timeoutMs, tag: `login-${randomBytes(3).toString('hex')}` });
const ok = async (id, command, timeoutMs) => {
  const out = await run(id, command, timeoutMs);
  assert.equal(out.exitCode, 0, `${id} ${command}: ${out.stderr}`);
  return String(out.stdout).trim();
};
const BROWSER = "'chromium|chrome'";
// 和登录屏「完成」同一段退出脚本：SIGTERM 不写 cookie，先按退出键
const closeBrowser = id => ok(id, BROWSER_QUIT, 50_000);
/** 像 bot 一样在自己的屏幕上开浏览器（经 /usr/bin/chromium 的替身和钩子），读窗口标题里的登录者。 */
async function visit(id, url, { keepOpen = false } = {}) {
  const who = await ok(id, [
    `setsid -f chromium --no-first-run --no-default-browser-check '${url}' > "$HOME/.omp-seat/chromium-e2e.log" 2>&1 < /dev/null`,
    'for _ in $(seq 200); do',
    '  t="$(xdotool search --onlyvisible --name "logged-|anonymous" getwindowname 2>/dev/null | head -n 1)"',
    '  if [ -n "$t" ]; then printf "%s\\n" "${t%% - *}"; exit 0; fi',
    '  sleep 0.2',
    'done',
    'echo "没看到页面" >&2; exit 1',
  ].join('\n'));
  if (!keepOpen) await closeBrowser(id);
  return who;
}
/** 用户在登录屏上：点一下窗口，Ctrl+L，输入地址，回车。全走座席层的输入接口。 */
async function userTypesUrl(url) {
  await seats.input(LOGIN_SEAT_ID, { action: 'click', x: 400, y: 300, button: 'left' });
  await seats.input(LOGIN_SEAT_ID, { action: 'key', key: 'ctrl+l' });
  await sleep(300);
  await seats.input(LOGIN_SEAT_ID, { action: 'type', text: url });
  await seats.input(LOGIN_SEAT_ID, { action: 'key', key: 'Enter' });
  for (let i = 0; i < 100; i += 1) {
    const t = (await run(LOGIN_SEAT_ID, 'xdotool search --onlyvisible --name "logged-|anonymous" getwindowname 2>/dev/null | head -n 1')).stdout.trim();
    if (t) return t.split(' - ')[0];
    await sleep(200);
  }
  throw new Error(`登录屏没打开 ${url}`);
}
const stat = p => sudo('stat', '-c', '%U:%G %a', p).trim();

let site;
try {
  // 干净起点
  for (const user of users) {
    trySudo('pkill', '-KILL', '-u', user);
    trySudo('userdel', '-r', user);
  }
  trySudo('rm', '-rf', LOGIN_STORE, CHROMIUM_HOOK, LOGIN_SYNC_SCRIPT);
  sudo('install', '-m', '0755', path.join(HERE, 'chromium-wrapper.sh'), WRAPPER);
  await vm.stop();
  site = spawn(process.execPath, [path.join(HERE, 'site.mjs')], { env: { ...process.env, SITE_PORT: String(SITE_PORT) }, stdio: 'ignore' });
  await sleep(500);

  // 1. bot-a 事先在另一个站点有自己的登录
  await seats.start(A);
  await seats.start(B);
  for (const f of [LOGIN_SYNC_SCRIPT, CHROMIUM_HOOK]) {
    const want = execFileSync('sha256sum', [path.join(REPO, f === CHROMIUM_HOOK ? 'guest/chromium.d/omp-shared-login' : 'guest/omp-login-sync')], { encoding: 'utf8' }).slice(0, 64);
    assert.equal(sudo('sha256sum', f).slice(0, 64), want, `${f} 是仓库里那份`);
  }
  assert.equal(stat(CHROMIUM_HOOK), 'root:root 644');
  proof.steps.botAOwnLogin = await visit(A, `${OTHER}/login?user=bot-a-own`);
  assert.equal(proof.steps.botAOwnLogin, 'logged-in:bot-a-own');
  pass('开机补装：登录脚本和浏览器钩子就是仓库里那两份，钩子 root:root 0644', {});

  // 2. 用户打开登录屏，在上面登录一次，点「完成」
  const opened = await seats.openLogin();
  assert.equal(opened.state, 'running');
  assert.equal(opened.seat.user, 'omp-login');
  proof.steps.userLogsInOnLoginScreen = await userTypesUrl(`${SITE}/login?user=alice`);
  assert.equal(proof.steps.userLogsInOnLoginScreen, 'logged-in:alice');
  const shot = await seats.screenshot(LOGIN_SEAT_ID);
  fs.writeFileSync(path.join(HERE, 'login-screen.png'), shot.data);
  const done = await seats.publishLogin();
  proof.steps.publish = done.status.state === 'stopped' ? 'published' : `state=${done.status.state}`;
  assert.equal(proof.steps.publish, 'published');
  assert.equal(trySudo('pgrep', '-u', 'omp-login'), null, '完成后登录屏的进程都停了');
  pass('登录屏：打开就有浏览器，用户经输入接口登录，「完成」关浏览器、发布、停登录屏', { publishedAt: done.publishedAt });

  // 3. 共享库归 root:team，bot 只能读
  assert.equal(stat(LOGIN_STORE), 'root:team 750');
  assert.equal(stat(`${LOGIN_STORE}/Cookies.db`), 'root:team 640');
  assert.equal(stat(`${LOGIN_STORE}/version`), 'root:team 640');
  assert.notEqual((await run(A, `touch ${LOGIN_STORE}/x`)).exitCode, 0, 'bot 写不进共享库');
  assert.notEqual((await run(A, `cp /etc/hostname ${LOGIN_STORE}/Cookies.db`)).exitCode, 0, 'bot 改不了共享库');
  assert.match(await ok(A, `cat ${LOGIN_STORE}/version`), /^\d+$/);
  pass('共享库 /var/lib/omp-login 归 root:team，目录 0750、文件 0640，bot 能读不能写', {});

  // 4. 两个 bot 同时开浏览器，都是登录状态；钩子带上 basic 和 256 MiB 缓存
  proof.steps.parallel = await Promise.all([visit(A, `${SITE}/`, { keepOpen: true }), visit(B, `${SITE}/`, { keepOpen: true })]);
  assert.deepEqual(proof.steps.parallel, ['logged-in:alice', 'logged-in:alice']);
  const args = await ok(B, `pgrep -a -u "$(id -u)" -x chrome | head -n 1`);
  assert.match(args, /--password-store=basic/);
  assert.match(args, /--disk-cache-size=268435456/);
  assert.match(await ok(A, 'cat ~/.config/chromium/.omp-login-version'), /^\d+$/, '以 bot 身份同步，标记在它自己的 profile 里');
  assert.equal(await ok(A, 'stat -c %U ~/.config/chromium/Default/Cookies'), seatUser(A));
  // 浏览器开着时同步跳过，不改正在用的库
  sudo('sh', '-c', `v=$(cat ${LOGIN_STORE}/version); echo $((v + 1)) > ${LOGIN_STORE}/version`);
  proof.steps.syncWhileRunning = await ok(B, `/usr/bin/python3 ${LOGIN_SYNC_SCRIPT} sync`);
  assert.equal(proof.steps.syncWhileRunning, 'profile in use, skipped');
  await Promise.all([closeBrowser(A), closeBrowser(B)]);
  proof.steps.botAOwnLoginKept = await visit(A, `${OTHER}/`);
  assert.equal(proof.steps.botAOwnLoginKept, 'logged-in:bot-a-own');
  pass('两个 bot 同时开浏览器都是登录状态，自己别的网站的登录还在；钩子带 basic 和 256 MiB，以 bot 身份同步，浏览器开着时跳过', { args: args.replace(/^\d+ /, '').slice(0, 300) });

  // 5. 关掉再开，登录还在
  proof.steps.afterRestart = [await visit(A, `${SITE}/`), await visit(B, `${SITE}/`)];
  assert.deepEqual(proof.steps.afterRestart, ['logged-in:alice', 'logged-in:alice']);

  // 6. bot-a 只在本地清 cookie，bot-b 不受影响
  await ok(A, `/usr/bin/python3 -c "import os, sqlite3; db = sqlite3.connect(os.path.expanduser('~/.config/chromium/Default/Cookies')); db.execute(\\"DELETE FROM cookies WHERE host_key = '127.0.0.1'\\"); db.commit()"`);
  proof.steps.localClearInA = [await visit(A, `${SITE}/`), await visit(B, `${SITE}/`)];
  assert.deepEqual(proof.steps.localClearInA, ['anonymous', 'logged-in:alice']);

  // 7. bot-b 点了网站的退出：服务端吊销会话，所有共用这个会话的 bot 都掉线
  proof.steps.serverLogoutInB = await visit(B, `${SITE}/logout`);
  proof.steps.afterServerLogout = [await visit(A, `${SITE}/`), await visit(B, `${SITE}/`)];
  assert.deepEqual(proof.steps.afterServerLogout, ['anonymous', 'anonymous']);

  // 8. 用户在登录屏重登一次，两个 bot 下次开浏览器都恢复
  await seats.openLogin();
  assert.equal(await userTypesUrl(`${SITE}/login?user=alice`), 'logged-in:alice');
  await seats.publishLogin();
  proof.steps.afterRelogin = [await visit(A, `${SITE}/`), await visit(B, `${SITE}/`)];
  assert.deepEqual(proof.steps.afterRelogin, ['logged-in:alice', 'logged-in:alice']);
  pass('关掉再开登录还在；本地清 cookie 只影响自己；点网站退出会让大家掉线；登录屏重登一次大家都恢复', {});

  // 和 02 的结论逐条对照
  const old = JSON.parse(fs.readFileSync(path.join(REPO, '.scratch/team-architecture/login-proof/proof.json'), 'utf8')).steps;
  const keys = ['botAOwnLogin', 'userLogsInOnLoginScreen', 'publish', 'parallel', 'botAOwnLoginKept', 'syncWhileRunning', 'afterRestart', 'localClearInA', 'serverLogoutInB', 'afterServerLogout', 'afterRelogin'];
  for (const k of keys) assert.deepEqual(proof.steps[k], old[k], `${k} 和 02 不一致`);
  pass('结论和 02 号票的 proof.json 逐条一致', { compared: keys });

  proof.result = `${proof.checks.length}/${proof.checks.length} PASS`;
} catch (error) {
  proof.error = String(error?.stack ?? error);
  console.log(`FAIL  ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  site?.kill();
  try { await seats.stop(A); } catch {}
  try { await seats.stop(B); } catch {}
  try { await seats.stop(LOGIN_SEAT_ID); } catch {}
  try { await vm.stop(); } catch {}
  for (const user of users) trySudo('pkill', '-KILL', '-u', user);
  trySudo('rm', '-f', WRAPPER);
  proof.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(HERE, 'login-e2e.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(proof.result ?? 'FAILED');
  process.exit(process.exitCode ?? 0);
}

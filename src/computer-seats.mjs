// computer-seats.mjs — 共享电脑的座席层。
//
// 对外接口和 ComputerBackend 一样（status、create、start、stop、guest、screenshot、input、run、
// uploadFile、downloadFile），仍按电脑 id 区分。电脑 id 现在指一个 bot 在共享电脑里的座席，
// 所以上层的租约、接管、工具和界面不用改。另外多一个 installPackages，给装系统包的客机工具用。
//
// 只有一台共享虚拟机。座席层经管理通道（客机里 root 运行的 spacesd）运行 guest/omp-seat，
// 给每个 bot 建 Linux 用户、屏幕和它自己的 spacesd，然后直接连那个 spacesd 截图、输入、跑命令。
// 停一个座席只停它的进程。最后一个座席停掉后关虚拟机。
//
// vm 是共享虚拟机的接口。生产用 QemuSharedVm 包一台 ComputerBackend 电脑，测试换成替身：
//   status() → { state, error }        state 取 unbound、stopped、starting、running、error
//   create({ image, machine }) → status  幂等：没有就建，没开就开
//   stop() → status
//   management() → { run, uploadFile }   管理通道，root 身份，参数同 GuestDesk
//   seatDesk(guestPort, token) → GuestDesk 连某个座席自己的 spacesd
//   seatHealthy(guestPort) → boolean     这个座席的 spacesd 是否应答 /health
//   seatListen                           可选，座席 spacesd 的监听地址，不给就用客机脚本的默认值
//   shareHost                            可选，客机连回宿主 SFTP 服务的地址，不给就用客机脚本的默认值 10.0.2.2
//
// share 是可选的共享目录提供者（生产用 SeatShare 包 FileShare）：
//   forSeat(computerId) → { host?, port, knownHosts, workspaceKey, user, key } 或 null（不挂）
//   start()  共享电脑开着时确保服务在跑，客机里 sshfs 的 reconnect 才接得上
//   close()
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileShare, WORKSPACE_USER } from './file-share.mjs';
import { COMPUTER_ERROR, ComputerBackend, ComputerBackendError, GuestDesk, connectSpacesd, probeSpacesdHealth, redactSecrets } from './computer-backend.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const SHARED_COMPUTER_ID = 'shared';
/** 16 个座席给 bot，第 17 个给登录屏。 */
export const BOT_SEAT_COUNT = 16;
export const LOGIN_SEAT_ID = 'login';
export const LOGIN_SEAT_USER = 'omp-login';
export const SEAT_GUEST_PORT_BASE = 3300;
export const SEAT_DISPLAY_BASE = 20;
/** QEMU 启动时预先转发的 17 个座席端口。 */
export const SEAT_GUEST_PORTS = Object.freeze(Array.from({ length: BOT_SEAT_COUNT + 1 }, (_, slot) => SEAT_GUEST_PORT_BASE + slot));

export const SHARED_MACHINE_DEFAULT = Object.freeze({ cpus: 4, memoryGb: 8, diskGb: 64 });
export const SHARED_MACHINE_RANGE = Object.freeze({ cpus: Object.freeze([2, 8]), memoryGb: Object.freeze([4, 16]) });

export const GUEST_LIB_DIR = '/usr/local/lib/omp-bot';
export const SEAT_SCRIPT = `${GUEST_LIB_DIR}/omp-seat`;
/** 随仓库发布的客机脚本。已有镜像在第一次就绪时经管理通道补装。 */
export const GUEST_FILES = Object.freeze([Object.freeze({ local: 'guest/omp-seat', guest: SEAT_SCRIPT, mode: '0755' })]);

/** Debian 包名：小写字母、数字和 + - .，至少两个字符，以字母或数字开头。 */
export const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]+$/;
export const MAX_PACKAGES = 32;
const MAX_PACKAGE_NAME = 100;

const DEFAULT_SEAT_CWD = '~/work';
const SEAT_UP_TIMEOUT_MS = 60_000;
const SEAT_DOWN_TIMEOUT_MS = 30_000;
const MANAGE_TIMEOUT_MS = 30_000;
const SEAT_HEALTH_WAIT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 1_500;

function fail(code, message) {
  return new ComputerBackendError(code, message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tail(text) {
  const s = String(text ?? '').trim();
  return s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s || '（没有输出）';
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function parseKv(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** 座席的 Linux 用户名。登录屏固定 omp-login，其余按电脑 id 的哈希取 12 位。 */
export function seatUser(computerId) {
  if (computerId === LOGIN_SEAT_ID) return LOGIN_SEAT_USER;
  return `omp-${sha256(String(computerId)).slice(0, 12)}`;
}

/** `~` 和 `~/…` 换成座席用户的主目录，其余原样返回。 */
export function expandHome(value, home) {
  if (typeof value !== 'string') return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}${value.slice(1)}`;
  return value;
}

/** vCPU 上限不超过宿主逻辑核数减 2。宿主核数太少时上限按下限算。 */
export function sharedMachineLimits(hostCpus = os.cpus().length) {
  const [minCpus, maxCpus] = SHARED_MACHINE_RANGE.cpus;
  const cpus = [minCpus, Math.max(minCpus, Math.min(maxCpus, Math.trunc(Number(hostCpus) || 0) - 2))];
  return { cpus, memoryGb: [...SHARED_MACHINE_RANGE.memoryGb] };
}

/**
 * 共享电脑的规格。默认 4 vCPU、8 GiB、64 GiB 动态磁盘，默认值也受宿主上限约束。
 * 给了值就严格校验，不在范围里抛 computer_invalid_argument。
 */
export function sharedMachineSpec(input = {}, { hostCpus = os.cpus().length } = {}) {
  const limits = sharedMachineLimits(hostCpus);
  const pick = (value, [min, max], fallback, label) => {
    if (value === undefined || value === null || value === '') return Math.min(Math.max(fallback, min), max);
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `${label}要在 ${min} 到 ${max} 之间，收到 ${JSON.stringify(value)}`);
    }
    return n;
  };
  return {
    cpus: pick(input?.cpus, limits.cpus, SHARED_MACHINE_DEFAULT.cpus, 'vCPU 个数'),
    memoryGb: pick(input?.memoryGb, limits.memoryGb, SHARED_MACHINE_DEFAULT.memoryGb, '内存 GiB 数'),
    diskGb: SHARED_MACHINE_DEFAULT.diskGb,
    limits,
  };
}

function machineFile(home) {
  return path.join(path.resolve(home), 'computers', 'shared-machine.json');
}

function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/** 用户保存的共享电脑规格。文件坏了或超出现在宿主的范围，就退回默认值。 */
export function readSharedMachine(home, { hostCpus = os.cpus().length } = {}) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(machineFile(home), 'utf8'));
  } catch {
    saved = null;
  }
  if (saved && typeof saved === 'object') {
    try {
      return { ...sharedMachineSpec(saved, { hostCpus }), saved: true };
    } catch {
      // 换了核数更少的宿主之类，退回默认
    }
  }
  return { ...sharedMachineSpec({}, { hostCpus }), saved: false };
}

/** 保存共享电脑规格，下次开机生效。 */
export function writeSharedMachine(home, input, { hostCpus = os.cpus().length } = {}) {
  const spec = sharedMachineSpec({ cpus: input?.cpus, memoryGb: input?.memoryGb }, { hostCpus });
  writeJsonAtomic(machineFile(home), { cpus: spec.cpus, memoryGb: spec.memoryGb }, 0o644);
  return { ...spec, saved: true };
}

/** 装系统包工具的包名列表：去重，逐个按 Debian 包名规则校验。 */
export function validatePackages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'packages 要是一个非空的包名列表');
  }
  if (raw.length > MAX_PACKAGES) {
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `一次最多装 ${MAX_PACKAGES} 个包，收到 ${raw.length} 个`);
  }
  const names = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!PACKAGE_NAME_PATTERN.test(name) || name.length > MAX_PACKAGE_NAME) {
      throw fail(
        COMPUTER_ERROR.INVALID_ARGUMENT,
        `包名不合法：${JSON.stringify(item)}。Debian 包名只能有小写字母、数字和 + - .，至少两个字符，以字母或数字开头`,
      );
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export class SeatBackend {
  #home;
  #vm;
  #machine;
  #file;
  #stageDir;
  #data = null;
  #desks = new Map();
  #busy = new Map();
  #lifecycle = Promise.resolve();
  #guestFiles = null;
  #seq = 0;
  #share;

  /**
   * @param {object} opts
   * @param {string} opts.home 应用数据根
   * @param {object} opts.vm 共享虚拟机接口，见文件开头
   * @param {Function|object} [opts.machine] 共享电脑规格，或返回规格的函数（每次开机前读）
   * @param {object} [opts.share] 共享目录提供者，见文件开头；不给就不挂共享目录
   */
  constructor({ home, vm, machine = null, share = null } = {}) {
    if (typeof home !== 'string' || home.trim() === '') throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'SeatBackend needs the app data home');
    if (!vm || typeof vm.status !== 'function') throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'SeatBackend needs a shared vm');
    this.#home = path.resolve(home);
    this.#vm = vm;
    this.#machine = machine;
    this.#share = share;
    this.#file = path.join(this.#home, 'computers', 'seats.json');
    this.#stageDir = path.join(this.#home, 'computers', 'guest-files');
  }

  get runtimeDir() {
    return this.#vm.runtimeDir ?? null;
  }

  get imageFile() {
    return this.#vm.imageFile ?? null;
  }

  /** 座席状态：共享电脑没开时是 stopped；开着时看这个座席的 spacesd 是否应答。 */
  async status(computerId) {
    this.#assertId(computerId);
    return await this.#observe(computerId, this.#busy.get(computerId)?.mark ?? null);
  }

  /** busy 是正在进行的生命周期操作（starting、stopping），有就按它报。 */
  async #observe(computerId, busy = null) {
    const seat = this.#seats()[computerId] ?? null;
    let vm;
    try {
      vm = await this.#vm.status();
    } catch (error) {
      return this.#state('error', seat, null, { code: error?.code ?? 'computer_status_failed', message: error?.message ?? String(error) });
    }
    const vmState = vm?.state ?? 'error';
    if (vmState === 'running') this.#share?.start?.().catch(() => {});
    if (busy) return this.#state(busy, seat, vm);
    if (vmState === 'error') {
      return this.#state('error', seat, vm, vm?.error ?? { code: 'computer_shared_error', message: '共享电脑报错' });
    }
    if (vmState === 'starting') return this.#state('starting', seat, vm);
    if (vmState !== 'running' || !seat) return this.#state('stopped', seat, vm);
    const ready = await this.#vm.seatHealthy(seat.port).catch(() => false);
    return this.#state(ready ? 'running' : 'stopped', seat, vm, null, ready === true);
  }

  async create(computerId, { image } = {}) {
    this.#assertId(computerId);
    return await this.#queue(computerId, 'starting', () => this.#up(computerId, { image }));
  }

  /** 座席是按需建的：已经绑定过旧电脑的 bot 第一次 start 时直接得到一个座席。 */
  async start(computerId) {
    this.#assertId(computerId);
    return await this.#queue(computerId, 'starting', () => this.#up(computerId, {}));
  }

  async stop(computerId) {
    this.#assertId(computerId);
    return await this.#queue(computerId, 'stopping', () => this.#down(computerId));
  }

  async close() {
    for (const desk of this.#desks.values()) desk.reset?.();
    this.#desks.clear();
    await this.#vm.close?.();
    await this.#share?.close?.();
  }

  async guest(computerId) {
    return await this.#desk(computerId).client();
  }

  async screenshot(computerId, { signal } = {}) {
    const shot = await this.#desk(computerId).screenshot({ signal });
    const seat = this.#seatOrThrow(computerId);
    if (seat.display?.width !== shot.width || seat.display?.height !== shot.height) {
      this.#saveSeat(computerId, { ...seat, display: { width: shot.width, height: shot.height } });
    }
    return shot;
  }

  async input(computerId, action = {}, { signal } = {}) {
    await this.#desk(computerId).input(action, { signal });
    return await this.status(computerId);
  }

  /** 客机命令以座席用户身份运行，cwd 默认 ~/work，`~` 换成这个用户的主目录。 */
  async run(computerId, options = {}, hooks = {}) {
    const desk = this.#desk(computerId);
    const seat = this.#seatOrThrow(computerId);
    const cwd = expandHome(options?.cwd ?? DEFAULT_SEAT_CWD, seat.home);
    return await desk.run({ ...options, cwd }, hooks);
  }

  async uploadFile(computerId, { localPath, path: target } = {}, { signal } = {}) {
    const desk = this.#desk(computerId);
    const seat = this.#seatOrThrow(computerId);
    return await desk.uploadFile({ localPath, path: expandHome(target, seat.home) }, { signal });
  }

  async downloadFile(computerId, { path: source, localPath } = {}, { signal } = {}) {
    const desk = this.#desk(computerId);
    const seat = this.#seatOrThrow(computerId);
    return await desk.downloadFile({ path: expandHome(source, seat.home), localPath }, { signal });
  }

  /** 经管理通道以 root 运行 apt 装系统包。包名先在这里校验，客机脚本里再校验一遍。 */
  async installPackages(computerId, packages, { signal } = {}) {
    const names = validatePackages(packages);
    this.#seatOrThrow(computerId);
    const vm = await this.#vm.status();
    if (vm?.state !== 'running') {
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `共享电脑没有在运行（state=${vm?.state ?? 'unknown'}），装不了包`);
    }
    await this.#ensureGuestFiles();
    const out = await this.#manage(`exec ${SEAT_SCRIPT} install-packages ${names.map(shQuote).join(' ')}`, {
      label: 'apt',
      timeoutMs: INSTALL_TIMEOUT_MS,
      signal,
    });
    return { packages: names, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, timedOut: out.timedOut === true };
  }

  // ---------------- 生命周期 ----------------

  /** 建座席、开机、停座席、关机全部排成一队，"最后一个座席停掉就关机"不会和别的座席开机撞上。 */
  async #queue(computerId, mark, fn) {
    const token = { mark };
    this.#busy.set(computerId, token);
    const run = this.#lifecycle.then(fn);
    this.#lifecycle = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      if (this.#busy.get(computerId) === token) this.#busy.delete(computerId);
    }
  }

  async #up(computerId, { image } = {}) {
    const seat = this.#ensureSeat(computerId);
    let vm = await this.#vm.status();
    if (vm?.state !== 'running') {
      const spec = this.#spec();
      vm = await this.#vm.create({
        image,
        machine: { cpus: spec.cpus, memoryMb: spec.memoryGb * 1024, diskGb: spec.diskGb, forwards: [...SEAT_GUEST_PORTS] },
      });
    }
    if (vm?.state !== 'running') {
      throw fail(
        COMPUTER_ERROR.START_FAILED,
        `共享电脑没有开起来（state=${vm?.state ?? 'unknown'}）${vm?.error?.message ? `：${vm.error.message}` : ''}`,
      );
    }
    await this.#ensureGuestFiles();
    const env = { OMP_SEAT_TOKEN: seat.token };
    const secrets = [seat.token];
    if (typeof this.#vm.seatListen === 'string' && this.#vm.seatListen) env.OMP_SEAT_LISTEN = this.#vm.seatListen;
    const share = this.#share ? await this.#share.forSeat(computerId) : null;
    if (share) {
      const host = this.#vm.shareHost || share.host || null;
      if (host) env.OMP_SHARE_HOST = host;
      env.OMP_SHARE_PORT = String(share.port);
      env.OMP_SHARE_KNOWN_HOSTS = share.knownHosts;
      env.OMP_SHARE_WORKSPACE_KEY = Buffer.from(share.workspaceKey).toString('base64');
      env.OMP_SHARE_USER = share.user;
      env.OMP_SHARE_KEY = Buffer.from(share.key).toString('base64');
      secrets.push(env.OMP_SHARE_WORKSPACE_KEY, env.OMP_SHARE_KEY);
    }
    const out = await this.#manage(`exec ${SEAT_SCRIPT} up ${seat.user} ${seat.displayNumber} ${seat.port}`, {
      label: 'up',
      timeoutMs: SEAT_UP_TIMEOUT_MS,
      env,
    });
    if (out.exitCode !== 0) {
      throw fail(COMPUTER_ERROR.START_FAILED, `座席 ${seat.user} 没有起来（退出码 ${out.exitCode ?? 'null'}）：${redactSecrets(tail(out.stderr || out.stdout), secrets)}`);
    }
    const info = parseKv(out.stdout);
    if (info.home && info.home.startsWith('/') && info.home !== seat.home) this.#saveSeat(computerId, { ...seat, home: info.home });
    this.#desks.get(computerId)?.reset?.();
    const deadline = Date.now() + SEAT_HEALTH_WAIT_MS;
    while (!(await this.#vm.seatHealthy(seat.port).catch(() => false))) {
      if (Date.now() > deadline) {
        throw fail(COMPUTER_ERROR.START_FAILED, `座席 ${seat.user} 的 spacesd 在客机里起来了，但宿主连不上转发端口`);
      }
      await sleep(200);
    }
    return await this.#observe(computerId);
  }

  async #down(computerId) {
    const seat = this.#seats()[computerId] ?? null;
    const vm = await this.#vm.status();
    if (!seat || vm?.state !== 'running') return await this.#observe(computerId);
    const out = await this.#manage(`exec ${SEAT_SCRIPT} down ${seat.user}`, { label: 'down', timeoutMs: SEAT_DOWN_TIMEOUT_MS });
    if (out.exitCode !== 0) {
      throw fail(COMPUTER_ERROR.STOP_FAILED, `座席 ${seat.user} 没有停干净（退出码 ${out.exitCode ?? 'null'}）：${tail(out.stderr || out.stdout)}`);
    }
    this.#desks.get(computerId)?.reset?.();
    // 数不清还剩几个座席时不关机，宁可多开着
    const count = await this.#manage(`exec ${SEAT_SCRIPT} count`, { label: 'count', timeoutMs: MANAGE_TIMEOUT_MS }).catch(() => null);
    const left = count?.exitCode === 0 ? Number(String(count.stdout).trim()) : NaN;
    if (left === 0) {
      await this.#vm.stop();
      this.#guestFiles = null;
      for (const desk of this.#desks.values()) desk.reset?.();
    }
    return await this.#observe(computerId);
  }

  #spec() {
    const raw = typeof this.#machine === 'function' ? this.#machine() : this.#machine;
    return sharedMachineSpec(raw ?? {});
  }

  /** 管理通道上跑一条 shell 命令，root 身份。 */
  async #manage(command, { label, timeoutMs, env = null, signal } = {}) {
    const management = await this.#vm.management();
    this.#seq += 1;
    const tag = `omp-seat-${label}-${process.pid}-${Date.now().toString(36)}-${this.#seq}`;
    return await management.run({ command, cwd: '/', timeoutMs, tag, ...(env ? { env } : {}) }, { signal });
  }

  /** 每次开机后核对一次客机脚本，和仓库里的不一样就经管理通道补装。 */
  async #ensureGuestFiles() {
    if (!this.#guestFiles) {
      this.#guestFiles = this.#installGuestFiles().catch(error => {
        this.#guestFiles = null;
        throw error;
      });
    }
    return await this.#guestFiles;
  }

  async #installGuestFiles() {
    for (const file of GUEST_FILES) {
      const data = fs.readFileSync(path.join(REPO_ROOT, file.local));
      const want = sha256(data);
      const probe = await this.#manage(`sha256sum ${shQuote(file.guest)} 2>/dev/null | cut -c1-64`, { label: 'probe', timeoutMs: MANAGE_TIMEOUT_MS });
      if (probe.exitCode === 0 && String(probe.stdout).trim() === want) continue;
      // 打包后脚本在 app.asar 里，SDK 的原生上传读不到，先落一份普通文件
      fs.mkdirSync(this.#stageDir, { recursive: true });
      const staged = path.join(this.#stageDir, path.basename(file.local));
      fs.writeFileSync(staged, data);
      const management = await this.#vm.management();
      const incoming = `${file.guest}.new`;
      await management.uploadFile({ localPath: staged, path: incoming }, {});
      const done = await this.#manage(
        `set -e; chown root:root ${shQuote(incoming)}; chmod ${file.mode} ${shQuote(incoming)}; mv -f ${shQuote(incoming)} ${shQuote(file.guest)}; sha256sum ${shQuote(file.guest)} | cut -c1-64`,
        { label: 'install', timeoutMs: MANAGE_TIMEOUT_MS },
      );
      if (done.exitCode !== 0 || String(done.stdout).trim() !== want) {
        throw fail(COMPUTER_ERROR.START_FAILED, `补装客机脚本 ${file.guest} 失败：${tail(done.stderr || done.stdout)}`);
      }
    }
  }

  // ---------------- 座席记录 ----------------

  #assertId(computerId) {
    if (typeof computerId !== 'string' || !ID_PATTERN.test(computerId)) {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `invalid computer id ${JSON.stringify(computerId)}`);
    }
  }

  #state(state, seat, vm, error = null, ready = false) {
    return {
      state,
      runtime: 'qemu',
      kind: 'vm',
      os: 'linux',
      display: seat?.display ?? null,
      error,
      vm: { state: vm?.state ?? 'unknown' },
      seat: { ready, user: seat?.user ?? null, home: seat?.home ?? null },
    };
  }

  #seats() {
    if (!this.#data) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
        this.#data = raw && typeof raw.seats === 'object' && raw.seats ? raw : { version: 1, seats: {} };
      } catch {
        this.#data = { version: 1, seats: {} };
      }
    }
    return this.#data.seats;
  }

  #saveSeat(computerId, seat) {
    const seats = { ...this.#seats(), [computerId]: seat };
    const next = { version: 1, seats };
    writeJsonAtomic(this.#file, next, 0o600);
    this.#data = next;
  }

  #ensureSeat(computerId) {
    const existing = this.#seats()[computerId];
    if (existing) return existing;
    const used = new Set(Object.values(this.#seats()).map(seat => seat.slot));
    let slot = null;
    if (computerId === LOGIN_SEAT_ID) slot = BOT_SEAT_COUNT;
    else for (let candidate = 0; candidate < BOT_SEAT_COUNT; candidate += 1) if (!used.has(candidate)) { slot = candidate; break; }
    if (slot === null) {
      throw fail(COMPUTER_ERROR.START_FAILED, `共享电脑最多 ${BOT_SEAT_COUNT} 个 bot 座席，已经用满`);
    }
    const user = seatUser(computerId);
    const seat = {
      slot,
      user,
      home: `/home/${user}`,
      port: SEAT_GUEST_PORT_BASE + slot,
      displayNumber: SEAT_DISPLAY_BASE + slot,
      token: randomBytes(24).toString('hex'),
      display: null,
      createdAt: Date.now(),
    };
    this.#saveSeat(computerId, seat);
    return seat;
  }

  #seatOrThrow(computerId) {
    this.#assertId(computerId);
    const seat = this.#seats()[computerId];
    if (!seat) throw fail(COMPUTER_ERROR.NOT_CREATED, `computer ${computerId} has no seat on the shared computer yet; start it first`);
    return seat;
  }

  #desk(computerId) {
    const seat = this.#seatOrThrow(computerId);
    let desk = this.#desks.get(computerId);
    if (!desk) {
      desk = this.#vm.seatDesk(seat.port, seat.token);
      this.#desks.set(computerId, desk);
    }
    return desk;
  }
}

/** 共享虚拟机：一台固定 id 的 ComputerBackend 电脑。座席端口经 QEMU 用户网络转发到宿主回环。 */
export class QemuSharedVm {
  #backend;
  #id;

  constructor(backend, { id = SHARED_COMPUTER_ID } = {}) {
    this.#backend = backend;
    this.#id = id;
  }

  get runtimeDir() {
    return this.#backend.runtimeDir;
  }

  get imageFile() {
    return this.#backend.imageFile;
  }

  async status() {
    return await this.#backend.status(this.#id);
  }

  async create({ image, machine } = {}) {
    return await this.#backend.create(this.#id, { image, machine });
  }

  async stop() {
    return await this.#backend.stop(this.#id);
  }

  management() {
    return {
      run: (options, hooks) => this.#backend.run(this.#id, options, hooks),
      uploadFile: (transfer, options) => this.#backend.uploadFile(this.#id, transfer, options),
    };
  }

  seatDesk(guestPort, token) {
    return new GuestDesk({
      connect: async () => {
        const host = this.#backend.forwardedPort(this.#id, guestPort);
        if (!host) throw fail(COMPUTER_ERROR.NOT_CREATED, `共享电脑没有转发座席端口 ${guestPort}，重新开一次共享电脑`);
        return await connectSpacesd(`http://127.0.0.1:${host}`, token);
      },
      describe: error => redactSecrets(error?.message ?? error, [token]),
    });
  }

  async seatHealthy(guestPort) {
    const host = this.#backend.forwardedPort(this.#id, guestPort);
    return host ? await probeSpacesdHealth(host) : false;
  }

  async close() {
    await this.#backend.close();
  }
}

/**
 * 座席的共享目录。/workspace 用一把钥匙，每个 bot 的 ~/work 各用一把：同一把钥匙的话，
 * 一个座席就能用别的 bot 的用户名登进它的 ~/work。
 * botIdFor(computerId) 给出这个座席的 bot id，不是 bot 的座席（比如登录座席）返回 null，不挂。
 */
export class SeatShare {
  #files;
  #botIdFor;
  #host;

  /**
   * @param {object} opts
   * @param {FileShare} opts.fileShare
   * @param {(computerId: string) => string|null} opts.botIdFor
   * @param {string} [opts.host] 客机连回来的地址，不给就用客机脚本的默认值
   */
  constructor({ fileShare, botIdFor, host = null } = {}) {
    if (!fileShare) throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'SeatShare 需要 fileShare');
    if (typeof botIdFor !== 'function') throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'SeatShare 需要 botIdFor(computerId)');
    this.#files = fileShare;
    this.#botIdFor = botIdFor;
    this.#host = host;
  }

  async forSeat(computerId) {
    const botId = this.#botIdFor(computerId);
    if (!botId) return null;
    const { port } = await this.#files.start();
    return {
      host: this.#host,
      port,
      knownHosts: this.#files.knownHosts,
      workspaceKey: this.#files.credentials(WORKSPACE_USER).privateKey,
      user: botId,
      key: this.#files.credentials(botId).privateKey,
    };
  }

  async start() {
    return await this.#files.start();
  }

  async close() {
    await this.#files.close();
  }
}

/**
 * 生产用的电脑后端：一台共享虚拟机加座席层。规格每次开机前从用户设置里读。
 * roots 和 botIdFor 给了就带上共享目录（见 SeatShare）。
 */
export function createSharedComputer({ home, runtimeDir = null, image = null, roots = null, botIdFor = null } = {}) {
  const backend = new ComputerBackend({ home, ...(runtimeDir ? { runtimeDir } : {}), ...(image ? { image } : {}) });
  const share = roots && botIdFor ? new SeatShare({ fileShare: new FileShare({ home, roots }), botIdFor }) : null;
  return new SeatBackend({ home, vm: new QemuSharedVm(backend), machine: () => readSharedMachine(home), share });
}

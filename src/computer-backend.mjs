import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Server, createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..');

const COMPUTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;
const GUEST_SPACESD_PORT = 3211;
const ACCEL = 'whpx,kernel-irqchip=off';
const QMP_CALL_TIMEOUT_MS = 5_000;
const QMP_STATUS_TIMEOUT_MS = 600;
const QMP_START_TIMEOUT_MS = 30_000;
const HEALTH_PROBE_TIMEOUT_MS = 1_500;
const SDK_RPC_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;
const INPUT_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const BOOT_TIMEOUT_MS = 240_000;
const BOOTING_GRACE_MS = 180_000;
const QEMU_EXIT_GRACE_MS = 60_000;
const QEMU_QUIT_GRACE_MS = 20_000;
const PID_EXIT_CONFIRM_MS = 15_000;
const CANCEL_CONFIRM_MS = 20_000;
const LOCAL_RUN_GUARD_SLACK_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const OUTPUT_TRUNCATED_NOTE = '\n[omp-bot] output truncated at 4194304 bytes\n';
const LOG_TAIL_CHARS = 2_000;
const CONTROL_REPLY_LIMIT_BYTES = 1024 * 1024;
const PID_IDENTITY_TIMEOUT_MS = 15_000;

const GUEST_WORK_DIR = '/work';
const GUEST_TOKEN_PERSISTENT = '/etc/cua/env-token';
const GUEST_TOKEN_RUNTIME = '/run/cua/env-token';
const GUEST_DRIVER_DROPIN = '/etc/systemd/system/cua-spacesd.service.d/50-cua-token-file.conf';
const GUEST_TOKEN_SYNC_DROPIN = '/etc/systemd/system/cua-env-token-sync.service.d/50-cua-token-file.conf';

export const COMPUTER_ERROR = Object.freeze({
  RUNTIME_UNAVAILABLE: 'computer_runtime_unavailable',
  NOT_CREATED: 'computer_not_created',
  INVALID_ARGUMENT: 'computer_invalid_argument',
  START_FAILED: 'computer_start_failed',
  STOP_FAILED: 'computer_stop_failed',
  GUEST_RPC_FAILED: 'computer_guest_rpc_failed',
  EFFECT_UNKNOWN: 'computer_effect_unknown',
});

export class ComputerBackendError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ComputerBackendError';
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function fail(code, message) {
  return new ComputerBackendError(code, message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function tailText(file, limit = LOG_TAIL_CHARS) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - limit);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function redact(message, secrets) {
  let out = String(message ?? 'unknown error');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** 宿主 pid 存活，自己实现（官方 CLI 的 Windows pid_alive 恒为 false，不能用）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readPidFile(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 只在 QMP 无响应或最终强杀前调用：pid 存活不代表它还是那台 QEMU，必须查 Windows 进程的 exe 与命令行。 */
function probeProcessIdentity(pid) {
  if (process.platform !== 'win32') return { known: false, reason: 'process identity checks are only implemented on Windows' };
  const script =
    `$target = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -First 1; ` +
    `if ($null -eq $target) { 'null' } else { ConvertTo-Json -Compress -InputObject @{ exe = $target.ExecutablePath; cmdline = $target.CommandLine } }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: PID_IDENTITY_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return { known: false, reason: `the Windows process query failed: ${result.error.message}` };
  if (result.status !== 0) {
    return { known: false, reason: `the Windows process query exited with ${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}` };
  }
  const text = (result.stdout ?? '').trim();
  if (text === '' || text === 'null') return { known: true, present: false, exe: null, cmdline: null };
  try {
    const parsed = JSON.parse(text);
    return {
      known: true,
      present: true,
      exe: typeof parsed?.exe === 'string' && parsed.exe !== '' ? parsed.exe : null,
      cmdline: typeof parsed?.cmdline === 'string' && parsed.cmdline !== '' ? parsed.cmdline : null,
    };
  } catch (error) {
    return { known: false, present: false, reason: `the Windows process query returned unreadable output: ${String(error?.message ?? error)}` };
  }
}

function bindFreePort() {
  return new Promise((resolve, reject) => {
    const probe = new Server();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function portFree(port) {
  return new Promise(resolve => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return resolve(false);
    const probe = new Server();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(true)));
  });
}

function sameHostPath(left, right) {
  const normalize = value => {
    const resolved = path.resolve(String(value).replace(/^\\\\\?\\/, ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  try {
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

async function probeGuestHealth(port, timeoutMs = HEALTH_PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status === 204 || response.status === 200;
  } catch {
    return false;
  }
}

// ---- cloud-init NoCloud seed（与 cua-vmm/crates/cua-vmm/src/cloudinit.rs 的写法一致）----

function tokenBootcmd() {
  return (
    'if systemctl cat cua-env-token-sync.service >/dev/null 2>&1; then ' +
    'mountpoint -q /run/cua || { mkdir -p /run/cua && mount -t tmpfs -o mode=0700,size=1m,nosuid,nodev,noexec cua-env-token /run/cua; }; ' +
    `for d in ${GUEST_DRIVER_DROPIN} ${GUEST_TOKEN_SYNC_DROPIN}; do ` +
    'mkdir -p "$(dirname $d)" && printf "[Service]\\nEnvironment=CUA_ENV_AWAIT_TOKEN_FILE=1\\n" >$d; done && systemctl daemon-reload; ' +
    'else install -d -m 0755 /run/cua; fi; ' +
    `if [ -s ${GUEST_TOKEN_PERSISTENT} ]; then install -m 0600 -o root -g root ${GUEST_TOKEN_PERSISTENT} ${GUEST_TOKEN_RUNTIME}; fi; ` +
    'systemctl start --no-block cua-env-token-sync.service >/dev/null 2>&1 || true'
  );
}

function tokenFileBlock(file, token) {
  return `  - path: ${file}\n    owner: 'root:root'\n    permissions: '0600'\n    content: |\n      ${token}`;
}

function guestUserData(token) {
  return [
    '#cloud-config',
    'users:',
    '  - default',
    '  - name: cua',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    'ssh_pwauth: false',
    'disable_root: true',
    'bootcmd:',
    `  - [sh, -c, '${tokenBootcmd()}']`,
    'write_files:',
    tokenFileBlock(GUEST_TOKEN_PERSISTENT, token),
    tokenFileBlock(GUEST_TOKEN_RUNTIME, token),
    'runcmd:',
    `  - [sh, -c, 'mkdir -p ${GUEST_WORK_DIR} && chown cua:cua ${GUEST_WORK_DIR} && chmod 0755 ${GUEST_WORK_DIR}']`,
    "  - [sh, -c, 'systemctl restart cua-env-token-sync.service >/dev/null 2>&1 || true']",
    "  - [sh, -c, 'systemctl try-restart cua-spacesd.service >/dev/null 2>&1 || true']",
    '',
  ].join('\n');
}

const ISO_SECTOR = 2048;

function writeBoth32(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
  buffer.writeUInt32BE(value, offset + 4);
}

function writeBoth16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
  buffer.writeUInt16BE(value, offset + 2);
}

function padAscii(buffer, start, end, text) {
  buffer.fill(0x20, start, end);
  if (text.length > 0) buffer.write(text, start, 'ascii');
}

function dirRecord(ident, lba, length, isDirectory) {
  const base = 33 + ident.length;
  const size = base + (base % 2);
  const record = Buffer.alloc(size);
  record[0] = size;
  writeBoth32(record, 2, lba);
  writeBoth32(record, 10, length);
  record.set([124, 1, 1, 0, 0, 0, 0], 18); // 2024-01-01，固定值让 seed 可复现
  record[25] = isDirectory ? 2 : 0;
  writeBoth16(record, 28, 1);
  record[32] = ident.length;
  ident.copy(record, 33);
  return record;
}

/** 最小 ISO 9660 写入器：CIDATA 卷标 + 平铺的 level-1 文件名（Linux 会去掉 ;1 后缀）。 */
export function buildSeedIso(volumeId, files) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rootLba = 20;
  let next = rootLba + 1;
  const placed = sorted.map(file => {
    const lba = next;
    next += Math.max(1, Math.ceil(file.data.length / ISO_SECTOR));
    return { ident: Buffer.from(`${file.name};1`, 'ascii'), lba, data: file.data };
  });
  const image = Buffer.alloc(next * ISO_SECTOR);

  const directory = Buffer.concat([
    dirRecord(Buffer.from([0]), rootLba, ISO_SECTOR, true),
    dirRecord(Buffer.from([1]), rootLba, ISO_SECTOR, true),
    ...placed.map(entry => dirRecord(entry.ident, entry.lba, entry.data.length, false)),
  ]);
  if (directory.length > ISO_SECTOR) {
    throw new Error('cloud-init seed directory does not fit in one ISO sector');
  }
  directory.copy(image, rootLba * ISO_SECTOR);
  for (const entry of placed) entry.data.copy(image, entry.lba * ISO_SECTOR);

  const pathTable = littleEndian => {
    const table = Buffer.alloc(10);
    table[0] = 1;
    if (littleEndian) {
      table.writeUInt32LE(rootLba, 2);
      table.writeUInt16LE(1, 6);
    } else {
      table.writeUInt32BE(rootLba, 2);
      table.writeUInt16BE(1, 6);
    }
    return table;
  };
  pathTable(true).copy(image, 18 * ISO_SECTOR);
  pathTable(false).copy(image, 19 * ISO_SECTOR);

  const primary = Buffer.alloc(ISO_SECTOR);
  primary[0] = 1;
  primary.write('CD001', 1, 'ascii');
  primary[6] = 1;
  padAscii(primary, 8, 40, '');
  padAscii(primary, 40, 72, volumeId);
  writeBoth32(primary, 80, next);
  writeBoth16(primary, 120, 1);
  writeBoth16(primary, 124, 1);
  writeBoth16(primary, 128, ISO_SECTOR);
  writeBoth32(primary, 132, 10);
  primary.writeUInt32LE(18, 140);
  primary.writeUInt32BE(19, 148);
  dirRecord(Buffer.from([0]), rootLba, ISO_SECTOR, true).copy(primary, 156);
  for (const [start, end] of [
    [190, 318],
    [318, 446],
    [446, 574],
    [574, 702],
    [702, 739],
    [739, 776],
    [776, 813],
  ]) {
    padAscii(primary, start, end, '');
  }
  for (const offset of [813, 830, 847, 864]) {
    primary.write('0000000000000000', offset, 'ascii');
    primary[offset + 16] = 0;
  }
  primary[881] = 1;
  primary.copy(image, 16 * ISO_SECTOR);

  const terminator = Buffer.alloc(7);
  terminator[0] = 255;
  terminator.write('CD001', 1, 'ascii');
  terminator[6] = 1;
  terminator.copy(image, 17 * ISO_SECTOR);
  return image;
}

function pipePath(name) {
  return `\\\\.\\pipe\\${name}`;
}

/** 每次调用一条连接、一次请求、一行响应；supervisor 侧串行转发到唯一的 raw QMP 会话。 */
async function controlRequest(pipe, key, command, args, timeoutMs) {
  const socket = await new Promise((resolve, reject) => {
    const candidate = createConnection({ path: pipePath(pipe) });
    const timer = setTimeout(() => {
      candidate.destroy();
      reject(new Error(`QMP control ${command} timed out connecting`));
    }, timeoutMs);
    candidate.once('connect', () => {
      clearTimeout(timer);
      resolve(candidate);
    });
    candidate.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const payload = args === undefined ? { key, command } : { key, command, arguments: args };
  const reply = await new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`QMP control ${command} timed out`)), timeoutMs);
    socket.on('data', chunk => {
      text += chunk.toString('utf8');
      const index = text.indexOf('\n');
      if (index < 0) {
        if (text.length > CONTROL_REPLY_LIMIT_BYTES) finish(new Error('the QMP control reply is over the framing limit'));
        return;
      }
      try {
        finish(null, JSON.parse(text.slice(0, index)));
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error(`the QMP control channel closed before ${command} answered`)));
    socket.write(`${JSON.stringify(payload)}\n`, error => {
      if (error) finish(error);
    });
  });
  if (reply?.ok === true) return reply.return;
  const code = reply?.error?.class ?? 'qmp_error';
  throw new Error(`QMP ${command} failed: ${code}${reply?.error?.desc ? ` (${reply.error.desc})` : ''}`);
}

function packagedResourcesDir() {
  const resources = process.resourcesPath;
  if (typeof resources !== 'string' || resources === '') return null;
  try {
    return fs.existsSync(path.join(resources, 'app.asar')) ? resources : null;
  } catch {
    return null;
  }
}

function resolveRuntimeDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit);
  const fromEnv = process.env.OMPBOT_COMPUTER_RUNTIME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv);
  const packaged = packagedResourcesDir();
  if (!packaged) return path.join(REPO_ROOT, '.computer-runtime');
  const appDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const cacheDirectory = process.env.LOCALAPPDATA || process.env.APPDATA;
  const candidates = [
    path.join(appDirectory, 'computer-runtime'),
    ...(cacheDirectory ? [path.join(cacheDirectory, 'omp-bot', 'computer-runtime')] : []),
    path.join(packaged, 'computer-runtime'),
  ];
  return candidates.find(directory => fs.existsSync(path.join(directory, 'manifest.json'))) || candidates[0];
}

function resolveImage(runtimeDir) {
  const manifest = readJson(path.join(runtimeDir, 'manifest.json'));
  const image = manifest?.image;
  if (image && typeof image.path === 'string') {
    const id =
      typeof image.id === 'string'
        ? image.id
        : typeof image.reference === 'string'
          ? image.reference
          : path.basename(image.path);
    const sha256 = typeof image.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(image.sha256) ? image.sha256.toLowerCase() : null;
    return { file: path.resolve(runtimeDir, image.path), id, sha256 };
  }
  return { file: path.join(runtimeDir, 'images', 'linux.img'), id: 'linux.img', sha256: null };
}

let imageHashCache = null;

/** 官方镜像 1.3GB：流式计算内容 SHA-256，按 size+mtime+ino 的指纹缓存，不整块读进内存。 */
async function imageContentSha(file) {
  const stats = fs.statSync(file);
  const fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ino}`;
  if (imageHashCache && imageHashCache.file === file && imageHashCache.fingerprint === fingerprint) {
    return { sha256: imageHashCache.sha256, bytes: stats.size };
  }
  const sha256 = await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  imageHashCache = { file, fingerprint, sha256 };
  return { sha256, bytes: stats.size };
}

function inspectDiskImage(file) {
  const header = Buffer.alloc(32);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.subarray(0, 4).toString('binary') !== 'QFI\xfb') {
    return { format: 'raw', bytes: fs.statSync(file).size, virtualSize: null, clusterSize: null };
  }
  const clusterBits = header.readUInt32BE(20);
  return {
    format: 'qcow2',
    bytes: fs.statSync(file).size,
    virtualSize: Number(header.readBigUInt64BE(24)),
    clusterSize: 2 ** clusterBits,
  };
}

let sdkPromise = null;

/** app.asar 的虚拟路径让 SDK 原生加载器找不到自己的 DLL，所以打包后从 app.asar.unpacked 的物理包入口导入。 */
function sdkImportTarget() {
  const moduleFile = fileURLToPath(import.meta.url);
  const archiveMarker = `.asar${path.sep}`;
  const index = moduleFile.lastIndexOf(archiveMarker);
  if (index < 0) return '@trycua/cua';
  const unpackedRoot = `${moduleFile.slice(0, index)}.asar.unpacked`;
  return pathToFileURL(path.join(unpackedRoot, 'node_modules', '@trycua', 'cua', 'dist', 'index.js')).href;
}

function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import(sdkImportTarget()).catch(error => {
      sdkPromise = null;
      throw fail(
        COMPUTER_ERROR.RUNTIME_UNAVAILABLE,
        `the official Cua SDK (@trycua/cua) is not installed: ${redact(error?.message ?? error, [])}`,
      );
    });
  }
  return sdkPromise;
}

let embeddedRuntime = null;

async function cuaRuntime() {
  const sdk = await loadSdk();
  if (!embeddedRuntime) embeddedRuntime = sdk.embedded();
  return embeddedRuntime;
}

function runProcess(command, args, timeout = 60_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout });
  return {
    code: result.status ?? (result.error ? -1 : null),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/** qcow2 覆盖层；backing 用规范化的 \\?\ 绝对路径，和 cua-vmm create_overlay 一致（支持长路径）。 */
async function createOverlay(qemuImg, backing, overlay) {
  const backingSpec = inspectDiskImage(backing);
  const backingArg = process.platform === 'win32' ? `\\\\?\\${path.resolve(backing)}` : path.resolve(backing);
  const result = runProcess(qemuImg, ['create', '-q', '-f', 'qcow2', '-b', backingArg, '-F', backingSpec.format, overlay]);
  if (result.code !== 0 || !fs.existsSync(overlay)) {
    throw fail(
      COMPUTER_ERROR.RUNTIME_UNAVAILABLE,
      `qemu-img could not create the overlay on ${backing}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
    );
  }
  return backingSpec;
}

const KEY_CHORD_MODIFIERS = new Map([
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['shift', 'shift'],
  ['meta', 'meta'],
  ['cmd', 'meta'],
  ['command', 'meta'],
  ['super', 'meta'],
  ['win', 'meta'],
]);

const KEY_ALIASES = new Map([
  ['enter', 'enter'],
  ['return', 'enter'],
  ['esc', 'escape'],
  ['escape', 'escape'],
  ['tab', 'tab'],
  ['space', 'space'],
  ['spacebar', 'space'],
  ['backspace', 'backspace'],
  ['del', 'delete'],
  ['delete', 'delete'],
  ['insert', 'insert'],
  ['home', 'home'],
  ['end', 'end'],
  ['pageup', 'pageup'],
  ['pagedown', 'pagedown'],
  ['arrowup', 'up'],
  ['arrowdown', 'down'],
  ['arrowleft', 'left'],
  ['arrowright', 'right'],
  ['up', 'up'],
  ['down', 'down'],
  ['left', 'left'],
  ['right', 'right'],
  ['minus', 'minus'],
  ['equal', 'equal'],
  ['comma', 'comma'],
  ['period', 'period'],
  ['slash', 'slash'],
  ['backslash', 'backslash'],
  ['semicolon', 'semicolon'],
  ['quote', 'apostrophe'],
  ['backquote', 'grave'],
  ['bracketleft', 'bracketleft'],
  ['bracketright', 'bracketright'],
]);

/** UI 约定：修饰键小写 ctrl/alt/shift/meta，`+` 连接，键名按 DOM KeyboardEvent.key 归一化。 */
function parseKeyChord(key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'input key needs a key name such as "enter" or "ctrl+shift+t"');
  }
  const parts = key
    .split('+')
    .map(part => part.trim())
    .filter(part => part !== '');
  if (parts.length === 0) {
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'input key needs a key name such as "enter" or "ctrl+shift+t"');
  }
  const modifiers = [];
  let name = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (KEY_CHORD_MODIFIERS.has(lower)) {
      const modifier = KEY_CHORD_MODIFIERS.get(lower);
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (name !== null) {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `input key "${key}" has more than one non-modifier key`);
    }
    const canonical = lower.startsWith('key_') ? lower.slice(4) : lower;
    name = KEY_ALIASES.get(canonical) ?? canonical;
  }
  if (name === null) {
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `input key "${key}" names modifiers only`);
  }
  return { modifiers, key: name };
}

const SDK_KEYS = new Map([
  ['ctrl', 'KEY_CONTROL'], ['alt', 'KEY_ALT'], ['shift', 'KEY_SHIFT'], ['meta', 'KEY_META'],
  ['pageup', 'KEY_PAGE_UP'], ['pagedown', 'KEY_PAGE_DOWN'],
  ['up', 'KEY_ARROW_UP'], ['down', 'KEY_ARROW_DOWN'], ['left', 'KEY_ARROW_LEFT'], ['right', 'KEY_ARROW_RIGHT'],
  ['bracketleft', 'KEY_BRACKET_LEFT'], ['bracketright', 'KEY_BRACKET_RIGHT'],
  ['grave', 'KEY_BACKQUOTE'], ['apostrophe', 'KEY_QUOTE'],
  ['capslock', 'KEY_CAPS_LOCK'], ['numlock', 'KEY_NUM_LOCK'], ['scrolllock', 'KEY_SCROLL_LOCK'],
  ['printscreen', 'KEY_PRINT_SCREEN'], ['contextmenu', 'KEY_CONTEXT_MENU'],
  ...['enter', 'escape', 'space', 'tab', 'backspace', 'delete', 'insert', 'home', 'end',
    'minus', 'equal', 'comma', 'period', 'slash', 'backslash', 'semicolon', 'pause'].map(name => [name, `KEY_${name.toUpperCase()}`]),
]);

function desktopKeyboardKeys(chord) {
  return [...chord.modifiers, chord.key].map(name => {
    const named = SDK_KEYS.get(name)
      ?? (/^[a-z]$|^f(?:[1-9]|1\d|2[0-4])$/.test(name) ? `KEY_${name.toUpperCase()}` : null)
      ?? (/^\d$/.test(name) ? `KEY_DIGIT_${name}` : null);
    if (named) return { named };
    if (/^[-=,./\\;\x27\x60\[\]]$/.test(name)) return { character: name };
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `不支持的实体按键 ${JSON.stringify(name)}；文字和 emoji 请使用文本输入。`);
  });
}

function point(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `input needs ${name} as a non-negative number`);
  }
  return Math.round(value);
}

function guestPath(value, name) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `${name} must be an absolute guest path`);
  }
  return value;
}

export class ComputerBackend {
  #home;
  #runtimeDir;
  #imageFile;
  #imageLabel;
  #imageManifestSha;
  #clients = new Map();
  #guestDirs = new Map();
  #starting = new Map();
  #locks = new Map();

  /** 电脑资源从 EXE 旁或用户缓存读取；源码运行使用 .computer-runtime，显式路径优先。
   *  image 只是镜像标签，运行时镜像始终由 manifest 决定。 */
  constructor({ home, runtimeDir, image } = {}) {
    if (typeof home !== 'string' || home.trim() === '') {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'ComputerBackend needs the app data home');
    }
    this.#home = path.resolve(home);
    this.#runtimeDir = resolveRuntimeDir(runtimeDir);
    const resolved = resolveImage(this.#runtimeDir);
    this.#imageFile = resolved.file;
    this.#imageLabel = typeof image === 'string' && image.trim() !== '' ? image.trim() : resolved.id;
    this.#imageManifestSha = resolved.sha256;
    if (!process.env.CUA_HOME) process.env.CUA_HOME = path.join(this.#home, 'computers', 'sdk-home');
    if (!process.env.DO_NOT_TRACK) process.env.DO_NOT_TRACK = '1';
  }

  get runtimeDir() {
    return this.#runtimeDir;
  }

  get imageFile() {
    return this.#imageFile;
  }

  async status(computerId) {
    this.#assertId(computerId);
    const record = this.#readRecord(computerId);
    if (!record || !fs.existsSync(record.disk) || !fs.existsSync(record.seed)) return this.#state('unbound', null, null);
    const display = record.display ?? null;
    try {
      this.#assets();
    } catch (error) {
      return this.#state('error', display, { code: error.code, message: error.message });
    }
    const live = await this.#inspect(record);
    if (live.reachable && live.owned) {
      if (live.qemuStatus === 'running') {
        if (await probeGuestHealth(record.ports.spacesd)) {
          if (record.guest?.desktopReady !== true) {
            if (this.#starting.has(computerId)) return this.#state('starting', display, null);
            try { await this.#verifyGuest(record); }
            catch (error) { return this.#bootState(record, display, 'computer_guest_initializing', error.message); }
          }
          return this.#state('running', display, null);
        }
        return this.#bootState(record, display, 'computer_guest_unhealthy', `the guest behind 127.0.0.1:${record.ports.spacesd} does not answer /health yet`);
      }
      if (live.qemuStatus === 'paused' || live.qemuStatus === 'prelaunch') {
        return this.#bootState(record, display, 'computer_guest_paused', `QEMU reports the guest as "${live.qemuStatus}"`);
      }
      if (live.qemuStatus === 'shutdown' || live.qemuStatus === 'guest-panicked' || live.qemuStatus === 'internal-error') {
        return this.#state('stopped', display, null);
      }
      return this.#bootState(record, display, 'computer_guest_unhealthy', `QEMU reports status "${live.qemuStatus ?? 'unknown'}"`);
    }
    if (live.pidAlive && this.#starting.has(computerId)) {
      return this.#state('starting', display, null);
    }
    if (live.reachable && !live.owned) {
      return this.#state('error', display, {
        code: 'computer_process_unmanaged',
        message: `the host QMP channel answers but does not own this computer (disk match: ${live.diskMatch}, name: ${JSON.stringify(live.name)}${live.ownershipError ? `, ${live.ownershipError}` : ''})`,
      });
    }
    if (live.pidAlive) {
      return this.#state('error', display, {
        code: 'computer_process_unmanaged',
        message: `pid ${live.pid} is alive but the host QMP channel does not answer for this computer; start or stop re-checks it against the recorded disk and seed`,
      });
    }
    return this.#state('stopped', display, null);
  }

  async create(computerId, { image } = {}) {
    this.#assertId(computerId);
    return await this.#exclusive(computerId, () => this.#create(computerId, { image }));
  }

  async start(computerId) {
    this.#assertId(computerId);
    return await this.#exclusive(computerId, () => this.#start(computerId));
  }

  async stop(computerId) {
    this.#assertId(computerId);
    return await this.#exclusive(computerId, () => this.#stop(computerId));
  }

  async close() {
    this.#clients.clear();
    this.#guestDirs.clear();
  }

  async guest(computerId) {
    this.#assertId(computerId);
    const record = this.#readRecord(computerId);
    if (!record) {
      throw fail(COMPUTER_ERROR.NOT_CREATED, `computer ${computerId} has no runtime record; bind it first`);
    }
    let pending = this.#clients.get(computerId);
    if (!pending) {
      pending = this.#createClient(record).catch(error => {
        this.#clients.delete(computerId);
        throw error;
      });
      this.#clients.set(computerId, pending);
    }
    return await pending;
  }

  async screenshot(computerId, { signal } = {}) {
    const record = this.#recordOrThrow(computerId);
    const client = await this.guest(computerId);
    const sdk = await loadSdk();
    let shot;
    try {
      shot = await client.screenshot(
        { format: sdk.ImageFormat.Png },
        { signal: signal ?? AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS) },
      );
    } catch (error) {
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `screenshot failed: ${this.#guestError(record, error)}`);
    }
    if (shot.format !== sdk.ImageFormat.Png) {
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `the guest returned image format ${shot.format}; only PNG is served`);
    }
    const data = Buffer.from(shot.image);
    if (data.length === 0) {
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, 'the guest returned an empty screenshot');
    }
    if (record.display?.width !== shot.width || record.display?.height !== shot.height) {
      record.display = { width: shot.width, height: shot.height };
      this.#writeRecord(record);
    }
    return { data, mimeType: 'image/png', width: shot.width, height: shot.height };
  }

  async input(computerId, action = {}, { signal } = {}) {
    const record = this.#recordOrThrow(computerId);
    const client = await this.guest(computerId);
    const options = { signal: signal ?? AbortSignal.timeout(INPUT_TIMEOUT_MS) };
    const kind = action?.action;
    try {
      switch (kind) {
        case 'click': {
          const x = point(action.x, 'x');
          const y = point(action.y, 'y');
          const button = action.button ?? 'left';
          if (button === 'left') await client.click(x, y, options);
          else if (button === 'right') await client.rightClick(x, y, options);
          else throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `input click button must be "left" or "right", got ${JSON.stringify(button)}`);
          break;
        }
        case 'move': {
          await client.moveTo(point(action.x, 'x'), point(action.y, 'y'), options);
          break;
        }
        case 'scroll': {
          if (!Number.isFinite(action.deltaY)) {
            throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'input scroll needs a numeric deltaY');
          }
          const deltaX = action.deltaX === undefined || action.deltaX === null ? 0 : action.deltaX;
          if (!Number.isFinite(deltaX)) {
            throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'input scroll needs deltaX as a number when given');
          }
          await client.scroll(Math.round(deltaX), Math.round(action.deltaY), options);
          break;
        }
        case 'type': {
          if (typeof action.text !== 'string') {
            throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'input type needs text as a string');
          }
          const windows = JSON.parse(await client.callJson('WindowsService/ListWindows', '{}', options)).windows ?? [];
          const focused = windows.find(window => window.focused);
          if (!focused) throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'text input needs a focused guest window; click the destination first');
          const app = focused.app?.appId ?? focused.app?.name ?? '';
          const terminal = /^(?:xfce4-terminal|gnome-terminal(?:-server)?|konsole|xterm|kitty|alacritty|wezterm|tilix|terminator)(?:\.desktop)?$/i.test(app);
          await client.setClipboard(action.text, options);
          options.signal.throwIfAborted();
          const keys = terminal ? ['KEY_CONTROL', 'KEY_SHIFT', 'KEY_V'] : ['KEY_CONTROL', 'KEY_V'];
          await client.keyboardJson(JSON.stringify({ target: { window: focused.ref }, hotkey: { keys: keys.map(named => ({ named })) } }), options);
          break;
        }
        case 'key': {
          const chord = parseKeyChord(action.key);
          const keys = desktopKeyboardKeys(chord);
          await client.keyboardJson(JSON.stringify({ target: { displayId: 'primary', delivery: 'DELIVERY_FOREGROUND' }, hotkey: { keys } }), options);
          break;
        }
        default:
          throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `unknown computer input action ${JSON.stringify(kind)}`);
      }
    } catch (error) {
      if (error instanceof ComputerBackendError) throw error;
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `computer input ${JSON.stringify(kind)} failed: ${this.#guestError(record, error)}`);
    }
    return await this.status(computerId);
  }

  /** 客机 /bin/sh -lc；用 spawn+tag 而不是 run()，取消时才能杀该 tag 的进程组并确认终态（见 #cancelGuestCommand）。 */
  async run(computerId, options = {}, hooks = {}) {
    const { command, cwd = GUEST_WORK_DIR, timeoutMs, tag } = options ?? {};
    const { signal, onUpdate } = hooks ?? {};
    if (typeof command !== 'string' || command.trim() === '') {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'run needs a non-empty command');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'run needs timeoutMs as a positive number (the SDK field is a plain number, never a BigInt)');
    }
    if (typeof tag !== 'string' || tag.trim() === '') {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'run needs a tag so a cancelled command can be found and killed in the guest');
    }
    const target = guestPath(cwd, 'cwd');
    const record = this.#recordOrThrow(computerId);
    const client = await this.guest(computerId);
    const sdk = await loadSdk();
    await this.#ensureGuestDir(record, client, target);

    let guestProcess;
    try {
      guestProcess = await client.spawn(
        sdk.SpacesdCommand.create({
          program: '/bin/sh',
          args: ['-lc', command],
          cwd: target,
          timeoutMs,
          tag,
          stdin: false,
        }),
        { signal: AbortSignal.timeout(SDK_RPC_TIMEOUT_MS) },
      );
    } catch (error) {
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `the guest refused to start ${tag}: ${this.#guestError(record, error)}`);
    }

    const kinds = sdk.ProcessEventKind;
    const decoders = typeof onUpdate === 'function' ? { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') } : null;
    const parts = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let exit = null;
    let guardFired = false;
    const abort = new AbortController();
    const relay = () => abort.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) relay();
      else signal.addEventListener('abort', relay, { once: true });
    }
    const guard = setTimeout(() => {
      guardFired = true;
      abort.abort(new Error('local run guard'));
    }, timeoutMs + LOCAL_RUN_GUARD_SLACK_MS);
    const emitUpdateBestEffort = (stream, chunk) => {
      if (decoders === null) return;
      try {
        onUpdate({ stream, text: decoders[stream].write(chunk) });
      } catch {
        // 消费者回调的异常不能影响客机命令本身
      }
    };
    const append = (stream, chunk) => {
      const room = OUTPUT_LIMIT_BYTES - sizes[stream];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      parts[stream].push(kept);
      sizes[stream] += kept.length;
      if (kept.length < chunk.length) truncated = true;
      emitUpdateBestEffort(stream, kept);
    };

    try {
      for (;;) {
        const event = await guestProcess.nextEvent({ signal: abort.signal });
        if (event === undefined) break;
        if (event.kind === kinds.Exit) {
          exit = event.exit ?? null;
          break;
        }
        const chunk = Buffer.from(event.data);
        if (chunk.length === 0) continue;
        append(event.kind === kinds.Stderr ? 'stderr' : 'stdout', chunk);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `the guest command ${tag} failed: ${this.#guestError(record, error)}`);
      }
    } finally {
      clearTimeout(guard);
      if (signal) signal.removeEventListener('abort', relay);
    }

    if (exit === null && abort.signal.aborted) {
      exit = await this.#cancelGuestCommand(record, client, guestProcess, tag);
    } else if (exit === null) {
      try {
        const output = await guestProcess.wait({ signal: AbortSignal.timeout(5_000) });
        exit = output?.exit ?? null;
      } catch {
        exit = null;
      }
      if (exit === null) {
        const survivors = await this.#runningWithTag(record, client, tag);
        if (survivors.length > 0) {
          exit = await this.#cancelGuestCommand(record, client, guestProcess, tag);
        }
      }
    }

    const finish = stream => {
      const text = Buffer.concat(parts[stream]).toString('utf8');
      return truncated ? text + OUTPUT_TRUNCATED_NOTE : text;
    };
    return {
      stdout: finish('stdout'),
      stderr: finish('stderr'),
      exitCode: Number.isInteger(exit?.code) ? exit.code : null,
      timedOut: exit?.timedOut === true || guardFired,
    };
  }

  async uploadFile(computerId, { localPath, path: target } = {}, { signal } = {}) {
    const record = this.#recordOrThrow(computerId);
    const source = this.#hostFile(localPath, 'localPath');
    const destination = guestPath(target, 'path');
    const client = await this.guest(computerId);
    const sdk = await loadSdk();
    let result;
    try {
      result = await client.uploadFile(
        source,
        destination,
        sdk.UploadOptions.create({ createParents: true }),
        { signal: signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS) },
      );
    } catch (error) {
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `upload ${source} -> ${destination} failed: ${this.#guestError(record, error)}`);
    }
    return { path: destination, bytes: Number(result.size), sha256: result.sha256, resumes: result.resumes };
  }

  async downloadFile(computerId, { path: source, localPath } = {}, { signal } = {}) {
    const record = this.#recordOrThrow(computerId);
    const guestSource = guestPath(source, 'path');
    if (typeof localPath !== 'string' || localPath.trim() === '') {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, 'localPath must be a host file path');
    }
    const destination = path.resolve(localPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const client = await this.guest(computerId);
    let result;
    try {
      result = await client.downloadFile(guestSource, destination, {
        signal: signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      });
    } catch (error) {
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `download ${guestSource} -> ${destination} failed: ${this.#guestError(record, error)}`);
    }
    return { path: guestSource, localPath: destination, bytes: Number(result.size), sha256: result.sha256 };
  }

  #assertId(computerId) {
    if (typeof computerId !== 'string' || !COMPUTER_ID_PATTERN.test(computerId)) {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `invalid computer id ${JSON.stringify(computerId)}`);
    }
  }

  #state(state, display, error) {
    return { state, runtime: 'qemu', kind: 'vm', os: 'linux', display, error };
  }

  #bootState(record, display, code, message) {
    if (this.#starting.has(record.computerId)) return this.#state('starting', display, null);
    const startedAt = Number(record.startedAt ?? 0);
    if (startedAt > 0 && Date.now() - startedAt < BOOTING_GRACE_MS) return this.#state('starting', display, null);
    return this.#state('error', display, { code, message });
  }

  #dirFor(computerId) {
    return path.join(this.#home, 'computers', computerId);
  }

  #readRecord(computerId) {
    const file = path.join(this.#dirFor(computerId), 'vm.json');
    const record = readJson(file);
    if (!record || record.computerId !== computerId) return null;
    return record;
  }

  #recordOrThrow(computerId) {
    this.#assertId(computerId);
    const record = this.#readRecord(computerId);
    if (!record) {
      throw fail(COMPUTER_ERROR.NOT_CREATED, `computer ${computerId} has no runtime record; bind it first`);
    }
    return record;
  }

  #writeRecord(record) {
    writeJsonAtomic(path.join(this.#dirFor(record.computerId), 'vm.json'), record);
  }

  #readTokenSafe(record) {
    try {
      const token = fs.readFileSync(record.tokenFile, 'utf8').trim();
      return token === '' ? null : token;
    } catch {
      return null;
    }
  }

  #token(record) {
    const token = this.#readTokenSafe(record);
    if (!token) {
      throw fail(COMPUTER_ERROR.NOT_CREATED, `computer ${record.computerId} has no guest token on disk`);
    }
    return token;
  }

  #guestError(record, error) {
    return redact(error?.message ?? error, [this.#readTokenSafe(record) ?? '\u0000']);
  }

  #assets() {
    const qemu = path.join(this.#runtimeDir, 'qemu', 'qemu-system-x86_64.exe');
    const qemuImg = path.join(this.#runtimeDir, 'qemu', 'qemu-img.exe');
    const missing = [
      [qemu, 'qemu/qemu-system-x86_64.exe'],
      [qemuImg, 'qemu/qemu-img.exe'],
      [this.#imageFile, path.relative(this.#runtimeDir, this.#imageFile) || this.#imageFile],
    ]
      .filter(([file]) => !fs.existsSync(file))
      .map(([, label]) => label);
    if (missing.length > 0) {
      throw fail(
        COMPUTER_ERROR.RUNTIME_UNAVAILABLE,
        `电脑资源不完整：${this.#runtimeDir}，缺少 ${missing.join(', ')}。请将 omp-bot-computer-runtime.zip 解压到应用 EXE 旁，或 %LOCALAPPDATA%\\omp-bot；源码运行可执行 npm run setup:computers。`,
      );
    }
    return { qemu, qemuImg };
  }

  async #assertImageStamp(record) {
    const { sha256, bytes } = await imageContentSha(this.#imageFile);
    if (record.imageSha256 === undefined) {
      if (record.imagePath && !sameHostPath(record.imagePath, this.#imageFile)) {
        if (!fs.existsSync(record.imagePath)) {
          throw fail(COMPUTER_ERROR.RUNTIME_UNAVAILABLE, '旧电脑未记录镜像摘要，且原镜像已不存在；无法确认新资源与原磁盘兼容，请先恢复原镜像。');
        }
        const previous = await imageContentSha(record.imagePath);
        if (previous.sha256 !== sha256 || previous.bytes !== bytes) {
          throw fail(COMPUTER_ERROR.RUNTIME_UNAVAILABLE, '新电脑资源的镜像与原镜像内容不同，不能迁移现有电脑磁盘。');
        }
      }
      if (this.#imageManifestSha && this.#imageManifestSha !== sha256) {
        throw fail(
          COMPUTER_ERROR.RUNTIME_UNAVAILABLE,
          `the runtime image ${this.#imageFile} does not match the digest recorded in manifest.json; the runtime assets are inconsistent`,
        );
      }
      record.imageBytes = bytes;
      record.imageSha256 = sha256;
      this.#writeRecord(record);
      return;
    }
    if (record.imageSha256 === sha256 && record.imageBytes === bytes) return;
    throw fail(
      COMPUTER_ERROR.RUNTIME_UNAVAILABLE,
      `the runtime image ${this.#imageFile} changed content since this computer was created; it must be recreated on the current image`,
    );
  }

  async #control(record, command, args, timeoutMs = QMP_CALL_TIMEOUT_MS) {
    const pipe = record.qmp?.control;
    if (typeof pipe !== 'string' || pipe === '') {
      throw fail(COMPUTER_ERROR.NOT_CREATED, `computer ${record.computerId} has no QMP supervisor channel recorded`);
    }
    return await controlRequest(pipe, this.#controlKey(record), command, args, timeoutMs);
  }

  #controlKey(record) {
    const file = record.controlKeyFile;
    let key = null;
    if (typeof file === 'string' && file !== '') {
      try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (/^[0-9a-f]{64}$/i.test(text)) key = text;
      } catch {
        key = null;
      }
    }
    if (!key) throw fail(COMPUTER_ERROR.NOT_CREATED, `computer ${record.computerId} has no host control key on disk`);
    return key;
  }

  async #qmpOwnsComputer(record, timeoutMs = QMP_CALL_TIMEOUT_MS) {
    const block = await this.#control(record, 'query-block', undefined, timeoutMs);
    let diskMatch = false;
    if (Array.isArray(block)) {
      for (const device of block) {
        const candidates = [device?.inserted?.file, device?.inserted?.backing_file, device?.file];
        for (const candidate of candidates) {
          if (typeof candidate !== 'string') continue;
          if (sameHostPath(candidate, record.disk) || sameHostPath(candidate, record.seed)) diskMatch = true;
        }
      }
    }
    let name = null;
    try {
      const reply = await this.#control(record, 'query-name', undefined, timeoutMs);
      name = typeof reply?.name === 'string' ? reply.name : null;
    } catch {
      name = null;
    }
    return { owned: diskMatch && (name === null || name === record.name), diskMatch, name };
  }

  async #inspect(record, timeoutMs = QMP_STATUS_TIMEOUT_MS) {
    const pid = readPidFile(record.pidFile);
    const alive = pidAlive(pid);
    try {
      const reply = await this.#control(record, 'query-status', undefined, timeoutMs);
      const qemuStatus = typeof reply?.status === 'string' ? reply.status : 'unknown';
      let ownership = { owned: false, diskMatch: false, name: null };
      try {
        ownership = await this.#qmpOwnsComputer(record, timeoutMs);
      } catch (error) {
        ownership = { owned: false, diskMatch: false, name: null, ownershipError: String(error?.message ?? error) };
      }
      return { reachable: true, pid, pidAlive: alive, qemuStatus, ...ownership };
    } catch (error) {
      return { reachable: false, owned: false, diskMatch: false, name: null, qemuStatus: null, pid, pidAlive: alive, error };
    }
  }

  async #requireOwnedChannel(record, timeoutMs = QMP_CALL_TIMEOUT_MS) {
    let ownership;
    try {
      ownership = await this.#qmpOwnsComputer(record, timeoutMs);
    } catch (error) {
      throw fail(
        COMPUTER_ERROR.EFFECT_UNKNOWN,
        `the host QMP channel for ${record.computerId} does not answer (${redact(error?.message ?? error, [])}); refusing the action`,
      );
    }
    if (!ownership.owned) {
      throw fail(
        COMPUTER_ERROR.EFFECT_UNKNOWN,
        `the host QMP channel is not ${record.computerId} (disk=${ownership.diskMatch}, name=${JSON.stringify(ownership.name)}); refusing the action`,
      );
    }
    return ownership;
  }

  async #pidIdentity(record, pid) {
    const observed = probeProcessIdentity(pid);
    if (!observed.known) return { state: 'unknown', reason: observed.reason };
    if (!observed.present) return { state: 'gone', reason: 'the process is gone' };
    if (observed.exe === null || observed.cmdline === null) {
      return { state: 'unknown', reason: 'the Windows process query could not read the executable path and command line' };
    }
    let qemu = null;
    try {
      qemu = this.#assets().qemu;
    } catch {
      return { state: 'unknown', reason: 'the runtime assets are missing, so the executable path cannot be checked' };
    }
    const cmdline = observed.cmdline.toLowerCase();
    const tokens = [record.name, record.disk, record.seed].map(value => String(value).toLowerCase());
    if (sameHostPath(observed.exe, qemu) && tokens.every(token => cmdline.includes(token))) {
      return { state: 'verified', exe: observed.exe };
    }
    return { state: 'foreign', reason: `pid ${pid} runs ${observed.exe} without the ${record.name} disk and seed on its command line` };
  }

  async #resolveStrayPid(record, pid, context) {
    const identity = await this.#pidIdentity(record, pid);
    if (identity.state === 'gone' || identity.state === 'foreign') {
      this.#clearPidFile(record);
      record.pid = null;
      record.startedAt = null;
      this.#writeRecord(record);
      return;
    }
    if (identity.state !== 'verified') {
      const message = `pid ${pid} is alive but cannot be verified as the QEMU for ${record.computerId} (${identity.reason})`;
      throw context === 'start'
        ? fail(COMPUTER_ERROR.START_FAILED, `${message}; refusing to start a second QEMU on the same disk`)
        : fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `${message}; refusing to kill it`);
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `cannot kill the stray QEMU for ${record.computerId} (pid ${pid}): ${redact(error?.message ?? error, [])}`);
      }
    }
    if (!(await this.#awaitQemuExit(record, pid, PID_EXIT_CONFIRM_MS))) {
      throw fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `the stray QEMU for ${record.computerId} (pid ${pid}) is still alive after SIGKILL`);
    }
    this.#clearPidFile(record);
    record.pid = null;
    record.startedAt = null;
    this.#writeRecord(record);
  }

  async #exclusive(computerId, fn) {
    const previous = this.#locks.get(computerId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => {});
    this.#locks.set(computerId, settled);
    settled.then(() => {
      if (this.#locks.get(computerId) === settled) this.#locks.delete(computerId);
    });
    return await run;
  }

  async #create(computerId, { image } = {}) {
    this.#assets();
    const directory = this.#dirFor(computerId);
    fs.mkdirSync(directory, { recursive: true });
    const label = typeof image === 'string' && image.trim() !== '' ? image.trim() : this.#imageLabel;
    let record = this.#readRecord(computerId);
    const diskExists = record ? fs.existsSync(record.disk) : false;
    if (record && diskExists) {
      if (typeof image === 'string' && image.trim() !== '' && record.image !== label) {
        record.image = label;
      }
      this.#writeRecord(record);
      return await this.#start(computerId);
    }
    const { qemuImg } = this.#assets();
    const { token } = this.#ensureToken(record, computerId, directory);
    if (!record) {
      record = {
        version: 2,
        computerId,
        name: `omp-${computerId}`,
        image: label,
        imagePath: this.#imageFile,
        disk: path.join(directory, 'disk.qcow2'),
        seed: path.join(directory, 'seed.iso'),
        tokenFile: path.join(directory, 'token'),
        controlKeyFile: path.join(directory, 'control.key'),
        pidFile: path.join(directory, 'qemu.pid'),
        serialLog: path.join(directory, 'serial.log'),
        log: path.join(directory, 'qemu.log'),
        supervisorLog: path.join(directory, 'supervisor.log'),
        cmdline: path.join(directory, 'cmdline'),
        qmp: null,
        ports: { spacesd: await bindFreePort() },
        cpus: DEFAULT_CPUS,
        memoryMb: DEFAULT_MEMORY_MB,
        accel: ACCEL,
        createdAt: Date.now(),
        startedAt: null,
        pid: null,
        supervisorPid: null,
        display: null,
        guest: null,
      };
    } else {
      record.image = label;
      record.imagePath = this.#imageFile;
    }
    this.#ensureControlKey(record, directory);
    if (!fs.existsSync(record.disk)) {
      const backing = await createOverlay(qemuImg, this.#imageFile, record.disk);
      record.backingFormat = backing.format;
      // 这个覆盖层就是按当前镜像新建的，旧摘要描述的是已经不在的磁盘：留着会让 start 永远拒绝启动（新摘要由 #assertImageStamp 盖章）
      delete record.imageSha256;
      delete record.imageBytes;
    }
    this.#writeSeed(record, token);
    this.#writeRecord(record);
    return await this.#start(computerId);
  }

  #ensureToken(record, computerId, directory) {
    const existing = record ? this.#readTokenSafe(record) : null;
    if (existing) return { token: existing, created: false };
    const token = randomBytes(16).toString('hex');
    const file = record?.tokenFile ?? path.join(directory, 'token');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    this.#clients.delete(computerId);
    return { token, created: true };
  }

  #ensureControlKey(record, directory) {
    const file = typeof record.controlKeyFile === 'string' && record.controlKeyFile !== '' ? record.controlKeyFile : path.join(directory, 'control.key');
    record.controlKeyFile = file;
    const existing = (() => {
      try {
        return fs.readFileSync(file, 'utf8').trim();
      } catch {
        return '';
      }
    })();
    if (/^[0-9a-f]{64}$/i.test(existing)) return file;
    fs.writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    return file;
  }

  #writeSeed(record, token) {
    const instanceId = `${record.name}-${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;
    const iso = buildSeedIso('CIDATA', [
      { name: 'META-DATA', data: Buffer.from(`instance-id: ${instanceId}\nlocal-hostname: ${record.computerId}\n`, 'utf8') },
      { name: 'USER-DATA', data: Buffer.from(guestUserData(token), 'utf8') },
    ]);
    const tmp = `${record.seed}.tmp`;
    fs.writeFileSync(tmp, iso);
    fs.renameSync(tmp, record.seed);
  }

  async #start(computerId) {
    const task = this.#startInner(computerId);
    this.#starting.set(computerId, task);
    try {
      return await task;
    } finally {
      if (this.#starting.get(computerId) === task) this.#starting.delete(computerId);
    }
  }

  async #startInner(computerId) {
    const record = this.#recordOrThrow(computerId);
    if (!fs.existsSync(record.disk)) {
      throw fail(COMPUTER_ERROR.NOT_CREATED, `computer ${computerId} has no disk; bind it first`);
    }
    this.#assets();
    await this.#assertImageStamp(record);
    await cuaRuntime();
    const directory = this.#dirFor(computerId);
    const { token, created } = this.#ensureToken(record, computerId, directory);
    // 新 token 必须重写 seed：instance-id 跟着 token 变，cloud-init 才会把新 token 写进客机并重启 cua-spacesd
    if (created || !fs.existsSync(record.seed)) this.#writeSeed(record, token);
    this.#ensureControlKey(record, directory);

    const live = await this.#inspect(record, QMP_CALL_TIMEOUT_MS);
    if (live.reachable && live.owned) {
      if (live.qemuStatus === 'running' && (await probeGuestHealth(record.ports.spacesd))) {
        await this.#verifyGuest(record);
        return await this.status(computerId);
      }
      await this.#awaitGuest(record, BOOT_TIMEOUT_MS);
      return await this.status(computerId);
    }
    if (live.pidAlive) {
      if (live.reachable || live.error?.code !== 'ENOENT') {
        throw fail(COMPUTER_ERROR.START_FAILED, `the live computer ${computerId} has an unconfirmed control channel; refusing to replace its running desktop`);
      }
      await this.#resolveStrayPid(record, live.pid, 'start');
    } else {
      this.#clearPidFile(record);
    }
    if (record.imagePath && !sameHostPath(record.imagePath, this.#imageFile)) {
      const { qemuImg } = this.#assets();
      const backing = process.platform === 'win32' ? `\\\\?\\${path.resolve(this.#imageFile)}` : path.resolve(this.#imageFile);
      // -F 必须是新镜像自身的真实格式：rebase -u 不校验任何内容，写错格式会让之后每次开机都打不开 backing 链
      const backingFormat = inspectDiskImage(this.#imageFile).format;
      const result = runProcess(qemuImg, ['rebase', '-u', '-f', 'qcow2', '-F', backingFormat, '-b', backing, record.disk]);
      if (result.code !== 0) {
        throw fail(COMPUTER_ERROR.START_FAILED, `迁移电脑镜像路径失败：${(result.stderr || result.stdout).trim() || result.code}`);
      }
      record.imagePath = this.#imageFile;
      record.backingFormat = backingFormat;
      this.#writeRecord(record);
    }
    this.#clients.delete(computerId);
    await this.#ensurePorts(record);
    const children = this.#launchMachine(record);
    await this.#awaitSupervisor(record, children);
    await this.#awaitGuest(record, BOOT_TIMEOUT_MS);
    return await this.status(computerId);
  }

  async #ensurePorts(record) {
    if (await portFree(record.ports.spacesd)) return;
    record.ports.spacesd = await bindFreePort();
    this.#writeRecord(record);
    this.#clients.delete(record.computerId);
  }

  #qemuArgs(record) {
    return [
      '-name',
      record.name,
      '-machine',
      'q35,smm=off',
      '-cpu',
      'host',
      '-accel',
      ACCEL,
      '-smp',
      String(record.cpus),
      '-m',
      String(record.memoryMb),
      '-drive',
      `file=${record.disk},if=none,id=disk0,format=qcow2,cache=writeback,discard=unmap`,
      '-device',
      'virtio-blk-pci,drive=disk0,bootindex=1',
      '-drive',
      `file=${record.seed},if=none,id=cidata,format=raw,readonly=on`,
      '-device',
      'virtio-blk-pci,drive=cidata',
      '-netdev',
      `user,id=net0,hostfwd=tcp:127.0.0.1:${record.ports.spacesd}-:${GUEST_SPACESD_PORT}`,
      '-device',
      'virtio-net-pci,netdev=net0',
      '-vga',
      'std',
      '-device',
      'qemu-xhci,id=xhci',
      '-device',
      'usb-kbd',
      '-device',
      'usb-tablet',
      '-display',
      'none',
      '-vnc',
      'none',
      '-qmp',
      `pipe:${record.qmp.raw}`,
      '-serial',
      'null',
      '-monitor',
      'none',
      '-pidfile',
      record.pidFile,
    ];
  }

  #childEnv(extraEnv) {
    const env = { ...extraEnv };
    for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'COMSPEC', 'USERPROFILE']) {
      const value = process.env[name];
      if (typeof value === 'string' && value !== '') env[name] = value;
    }
    return env;
  }

  #spawnDetached(command, args, logFile, extraEnv) {
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: this.#childEnv(extraEnv),
    });
    fs.closeSync(fd);
    child.on('error', error => {
      child.spawnError = error;
    });
    child.unref();
    return child;
  }

  #terminateChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程可能刚好自己退出
    }
  }

  /** supervisor 先起：它轮询 raw 管道，QEMU 一创建就能被唯一那个会话接上（chardev pipe 只服务一次连接）。 */
  #launchMachine(record) {
    record.guest = null;
    record.qmp = {
      raw: `omp-qmp-raw-${record.computerId}-${randomBytes(6).toString('hex')}`,
      control: `omp-qmp-ctl-${record.computerId}-${randomBytes(6).toString('hex')}`,
    };
    this.#writeRecord(record);
    const supervisorModule = path.join(MODULE_DIR, 'computer-qmp-supervisor.mjs');
    const supervisor = this.#spawnDetached(
      process.execPath,
      [supervisorModule, '--raw-pipe', record.qmp.raw, '--control-pipe', record.qmp.control, '--key-file', record.controlKeyFile],
      record.supervisorLog,
      { ELECTRON_RUN_AS_NODE: '1' },
    );
    record.supervisorPid = supervisor.pid ?? null;
    this.#writeRecord(record);
    const { qemu } = this.#assets();
    const args = this.#qemuArgs(record);
    fs.writeFileSync(record.cmdline, `${qemu} ${args.join(' ')}\n`);
    const machine = this.#spawnDetached(qemu, args, record.log, {});
    record.pid = machine.pid ?? null;
    record.startedAt = Date.now();
    this.#writeRecord(record);
    return { machine, supervisor };
  }

  async #awaitSupervisor(record, { machine, supervisor }) {
    const deadline = Date.now() + QMP_START_TIMEOUT_MS;
    for (;;) {
      const pid = machine?.pid ?? record.pid ?? readPidFile(record.pidFile);
      if (!pidAlive(pid) && !pidAlive(readPidFile(record.pidFile))) break;
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) break;
      const ownership = await this.#qmpOwnsComputer(record, 1_000).catch(() => null);
      if (ownership?.owned) {
        const filePid = readPidFile(record.pidFile);
        if (filePid && filePid !== record.pid) {
          record.pid = filePid;
          this.#writeRecord(record);
        }
        return ownership;
      }
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    const detail = [
      machine?.spawnError ? `QEMU spawn failed: ${machine.spawnError.message}` : tailText(record.log).trim(),
      supervisor?.spawnError ? `supervisor spawn failed: ${supervisor.spawnError.message}` : tailText(record.supervisorLog).trim(),
    ]
      .filter(part => part !== '')
      .join(' | ');
    this.#terminateChild(supervisor);
    this.#terminateChild(machine);
    throw fail(
      COMPUTER_ERROR.START_FAILED,
      `QEMU for ${record.computerId} did not come up behind a verifiable QMP supervisor: ${detail || 'no output'}`,
    );
  }

  async #awaitGuest(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      const pid = record.pid ?? readPidFile(record.pidFile);
      if (!pidAlive(pid)) {
        throw fail(COMPUTER_ERROR.START_FAILED, `QEMU for ${record.computerId} exited while the guest was starting: ${tailText(record.log).trim()}`);
      }
      if (await probeGuestHealth(record.ports.spacesd)) {
        try {
          await this.#verifyGuest(record);
          await this.#learnDisplayBestEffort(record);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(1_000);
    }
    throw fail(
      COMPUTER_ERROR.START_FAILED,
      `the guest for ${record.computerId} was not ready within ${Math.round(timeoutMs / 1000)}s${lastError ? `: ${lastError.message}` : ''}`,
    );
  }

  async #verifyGuest(record) {
    const client = await this.guest(record.computerId);
    let capabilities;
    try {
      capabilities = await client.capabilities({ signal: AbortSignal.timeout(SDK_RPC_TIMEOUT_MS) });
    } catch (error) {
      throw fail(COMPUTER_ERROR.START_FAILED, `guest capabilities failed: ${this.#guestError(record, error)}`);
    }
    if (capabilities.osFamily !== 'linux') {
      throw fail(COMPUTER_ERROR.START_FAILED, `the guest image reports osFamily "${capabilities.osFamily}", expected linux`);
    }
    if (capabilities.initialized !== true) {
      throw fail(COMPUTER_ERROR.START_FAILED, '客机桌面服务仍在初始化。');
    }
    await this.#verifyGuestEnvironment(record, client);
    const guest = {
      protocolRevision: Number(capabilities.protocolRevision ?? 0),
      osName: String(capabilities.osName ?? ''),
      osVersion: String(capabilities.osVersion ?? ''),
      hostname: String(capabilities.hostname ?? ''),
      initialized: capabilities.initialized === true,
      desktopReady: true,
      features: Array.isArray(capabilities.features) ? capabilities.features.length : 0,
    };
    if (JSON.stringify(record.guest ?? null) !== JSON.stringify(guest)) {
      record.guest = guest;
      this.#writeRecord(record);
    }
    return capabilities;
  }

  async #verifyGuestEnvironment(record, client) {
    const sdk = await loadSdk();
    let output;
    const probe = `test -d ${GUEST_WORK_DIR} && test -w ${GUEST_WORK_DIR} && test "$(stat -c %U ${GUEST_WORK_DIR})" = cua && pgrep -x xfwm4 >/dev/null && pgrep -x xfdesktop >/dev/null`;
    try {
      output = await client.run(
        sdk.SpacesdCommand.create({
          program: '/bin/sh',
          args: ['-c', probe],
          cwd: '/',
          timeoutMs: 15_000,
        }),
        { signal: AbortSignal.timeout(SDK_RPC_TIMEOUT_MS) },
      );
    } catch (error) {
      throw fail(COMPUTER_ERROR.START_FAILED, `无法核对客机工作目录和图形桌面：${this.#guestError(record, error)}`);
    }
    if (output?.exit?.code !== 0) {
      throw fail(
        COMPUTER_ERROR.START_FAILED,
        `客机工作目录或官方镜像的 XFCE 图形桌面尚未就绪（退出码 ${String(output?.exit?.code ?? 'unknown')}）。`,
      );
    }
  }

  async #learnDisplayBestEffort(record) {
    await this.screenshot(record.computerId, {}).catch(() => undefined);
  }

  async #stop(computerId) {
    const record = this.#readRecord(computerId);
    if (!record) return await this.status(computerId);
    const live = await this.#inspect(record);
    if (!(live.reachable && live.owned)) {
      if (live.pidAlive) {
        await this.#resolveStrayPid(record, live.pid, 'stop');
      } else {
        this.#clearPidFile(record);
        record.pid = null;
        record.startedAt = null;
        this.#writeRecord(record);
      }
      this.#clients.delete(computerId);
      return await this.status(computerId);
    }
    const pid = live.pid ?? readPidFile(record.pidFile) ?? record.pid ?? null;
    await this.#requireOwnedChannel(record);
    await this.#requestMachineStop(record, 'system_powerdown');
    let exited = await this.#awaitQemuExit(record, pid, QEMU_EXIT_GRACE_MS);
    if (!exited) {
      await this.#requireOwnedChannel(record);
      await this.#requestMachineStop(record, 'quit');
      exited = await this.#awaitQemuExit(record, pid, QEMU_QUIT_GRACE_MS);
    }
    if (!exited && Number.isInteger(pid)) {
      const identity = await this.#pidIdentity(record, pid);
      if (identity.state === 'verified') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error?.code !== 'ESRCH') {
            throw fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `cannot kill the QEMU for ${computerId} (pid ${pid}): ${redact(error?.message ?? error, [])}`);
          }
        }
        exited = await this.#awaitQemuExit(record, pid, PID_EXIT_CONFIRM_MS);
      } else if (identity.state === 'gone') {
        exited = true;
      } else {
        throw fail(
          COMPUTER_ERROR.EFFECT_UNKNOWN,
          `the QEMU for ${computerId} (pid ${pid}) did not exit and its process identity cannot be confirmed (${identity.reason}); refusing to kill it`,
        );
      }
    }
    if (!exited) {
      throw fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `QEMU for ${computerId} (pid ${pid}) is still alive after ACPI powerdown, QMP quit and SIGKILL`);
    }
    this.#clearPidFile(record);
    record.startedAt = null;
    record.pid = null;
    this.#writeRecord(record);
    this.#clients.delete(computerId);
    return await this.status(computerId);
  }

  /** 关机/退出的答复可能赶在 QMP 会话关闭后面；真正的判据是下面的退出确认。 */
  async #requestMachineStop(record, command) {
    try {
      await this.#control(record, command);
    } catch (error) {
      if (error instanceof ComputerBackendError) throw error;
    }
  }

  async #confirmedExited(record, pid) {
    if (pidAlive(pid)) {
      try {
        if ((await this.#qmpOwnsComputer(record, QMP_CALL_TIMEOUT_MS)).owned) return false;
      } catch {}
      const identity = await this.#pidIdentity(record, pid);
      return identity.state === 'gone' || identity.state === 'foreign';
    }
    try {
      const ownership = await this.#qmpOwnsComputer(record, 300);
      return !ownership.owned;
    } catch {
      return true;
    }
  }

  async #awaitQemuExit(record, pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.#confirmedExited(record, pid)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  }

  #clearPidFile(record) {
    fs.rmSync(record.pidFile, { force: true });
  }

  async #createClient(record) {
    const token = this.#token(record);
    const runtime = await cuaRuntime();
    return await runtime.spacesd(`http://127.0.0.1:${record.ports.spacesd}`, token);
  }

  async #ensureGuestDir(record, client, directory) {
    const key = `${record.computerId}\u0000${directory}`;
    const cached = this.#guestDirs.get(key);
    if (cached) return await cached;
    const task = client.makeDir(directory, { signal: AbortSignal.timeout(SDK_RPC_TIMEOUT_MS) }).catch(error => {
      this.#guestDirs.delete(key);
      throw fail(COMPUTER_ERROR.GUEST_RPC_FAILED, `the guest could not create ${directory}: ${this.#guestError(record, error)}`);
    });
    this.#guestDirs.set(key, task);
    return await task;
  }

  async #runningWithTag(record, client, tag) {
    let raw;
    try {
      raw = await client.listProcesses(false, { signal: AbortSignal.timeout(SDK_RPC_TIMEOUT_MS) });
    } catch (error) {
      throw fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `cannot list guest processes to confirm ${tag} stopped: ${this.#guestError(record, error)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `cannot read the guest process list for ${tag}: ${redact(error?.message ?? error, [])}`);
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.processes) ? parsed.processes : null;
    if (list === null) {
      throw fail(COMPUTER_ERROR.EFFECT_UNKNOWN, `unexpected ListProcesses payload while confirming ${tag} stopped`);
    }
    return list.filter(entry => entry?.tag === tag && (entry?.state ?? 'PROCESS_STATE_RUNNING') !== 'PROCESS_STATE_EXITED');
  }

  async #signalGroupKill(client, tag) {
    await client.callJson(
      '/cua.env.v1.ProcessService/SignalProcess',
      JSON.stringify({ process: { tag }, signal: 'SIGNAL_KILL', processGroup: true }),
      { signal: AbortSignal.timeout(10_000) },
    );
  }

  async #cancelGuestCommand(record, client, guestProcess, tag) {
    const deadline = Date.now() + CANCEL_CONFIRM_MS;
    let killError = null;
    const groupKill = async () => {
      try {
        await this.#signalGroupKill(client, tag);
      } catch (error) {
        killError = this.#guestError(record, error);
      }
    };
    await groupKill();
    try {
      await guestProcess.kill({ signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      killError ??= this.#guestError(record, error);
    }
    let exit = null;
    try {
      const output = await guestProcess.wait({ signal: AbortSignal.timeout(8_000) });
      exit = output?.exit ?? null;
    } catch {
      exit = null;
    }
    let survivors = await this.#runningWithTag(record, client, tag);
    if (survivors.length > 0 && Date.now() < deadline) {
      await groupKill();
      await sleep(250);
      survivors = await this.#runningWithTag(record, client, tag);
    }
    if (survivors.length > 0) {
      const pids = survivors.map(entry => entry?.pid).filter(pid => pid !== undefined).join(', ');
      throw fail(
        COMPUTER_ERROR.EFFECT_UNKNOWN,
        `cancelled ${tag} but the guest still runs ${pids || 'a process'} with that tag; the side effects of this command are unknown${killError ? ` (kill error: ${killError})` : ''}`,
      );
    }
    return exit;
  }

  #hostFile(localPath, name) {
    if (typeof localPath !== 'string' || localPath.trim() === '') {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `${name} must be a host file path`);
    }
    const resolved = path.resolve(localPath);
    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `${name} ${resolved} does not exist`);
    }
    if (!stats.isFile()) {
      throw fail(COMPUTER_ERROR.INVALID_ARGUMENT, `${name} ${resolved} is not a regular file`);
    }
    return resolved;
  }
}

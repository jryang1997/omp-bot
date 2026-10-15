// Throwaway QA probe (not part of the repo test suite). Owner: ComputerLifecycle child.
//
// Reproduces two evidenced faults in src/computer-backend.mjs. Run it on the current source:
// both scenarios should print "BUG reproduced" and exit 2 (failing-before evidence); with the
// ComputerLifecycle patch applied both print "ok" and exit 0.
//
// S1  fresh overlay on an existing record that still carries a stale image stamp
//     before: create() rejects with computer_runtime_unavailable
//             "the runtime image ... changed content since this computer was created"
//             even though it just built a brand-new disk on the current image; every
//             later create()/start() repeats the same rejection forever.
//     after:  create() gets past the stamp check, stamps the fresh disk, and only the
//             later QEMU launch fails (stub machine) - the record stamp equals the
//             current image again.
//
// S2  legacy record (imageSha256 + backingFormat absent) whose runtime image moved to a
//     new path while the runtime image itself is a raw file
//     before: the relocation runs `qemu-img rebase -u ... -F <record.backingFormat || "qcow2">`,
//             which writes backing-filename-format=qcow2 into a disk that is backed by a raw
//             file; every later boot then fails with "Image is not in qcow2 format".
//     after:  -F is the detected format of the current image ("raw"), the backing chain stays
//             openable and reads the correct bytes.
//
// Usage:
//   node .scratch/qa-loop/ComputerLifecycle/repro/rebuild-stamp.repro.mjs             # both scenarios
//   node .scratch/qa-loop/ComputerLifecycle/repro/rebuild-stamp.repro.mjs --fixture   # build fixtures, print them, run nothing
//
// Exit codes: 0 = fixed behavior (green), 2 = failing-before behavior (red), 1 = harness error.
// Everything is created under repro/tmp/ ; the real .computer-runtime is only read (qemu binaries copied).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const TMP = path.join(HERE, 'tmp');
const QEMU_SOURCE = path.join(REPO, '.computer-runtime', 'qemu');
const QEMU_CACHE = path.join(TMP, 'qemu-cache');
const spawnQemuImg = (args) => spawnSync(path.join(QEMU_CACHE, 'qemu-img.exe'), args, { encoding: 'utf8' });

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const log = (...parts) => console.log(...parts);
const fixtureOnly = process.argv.includes('--fixture');

function failHarness(message) {
  console.error(`HARNESS ERROR: ${message}`);
  process.exit(1);
}

function buildQemuCache() {
  const marker = path.join(QEMU_CACHE, 'qemu-system-x86_64.exe');
  if (fs.existsSync(marker)) return; // cache already built (qemu-img + stubbed machine exe)
  if (!fs.existsSync(path.join(QEMU_SOURCE, 'qemu-img.exe'))) failHarness(`missing ${QEMU_SOURCE}/qemu-img.exe; run npm run setup:computers first`);
  fs.rmSync(QEMU_CACHE, { recursive: true, force: true });
  fs.mkdirSync(QEMU_CACHE, { recursive: true });
  fs.cpSync(QEMU_SOURCE, QEMU_CACHE, { recursive: true });
  // Stub machine: a real-but-wrong exe that exits immediately, so a start() that gets past the
  // stamp/rebase checks fails fast in #awaitSupervisor instead of booting a nonsense disk.
  const stubSource = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  if (fs.existsSync(stubSource) && fs.statSync(stubSource).size < 2 * 1024 * 1024) {
    fs.copyFileSync(stubSource, path.join(QEMU_CACHE, 'qemu-system-x86_64.exe'));
  } else {
    fs.writeFileSync(path.join(QEMU_CACHE, 'qemu-system-x86_64.exe'), '');
  }
}

function buildRuntime() {
  const runtime = path.join(TMP, 'runtime');
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(path.join(runtime, 'images'), { recursive: true });
  // Small stand-in for images/linux.img: raw format, so -F (in the rebase) must be "raw".
  const image = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < image.length; i += 1) image[i] = i % 251;
  const imageFile = path.join(runtime, 'images', 'linux.img');
  fs.writeFileSync(imageFile, image);
  fs.writeFileSync(
    path.join(runtime, 'manifest.json'),
    `${JSON.stringify({
      version: 1,
      image: { path: 'images/linux.img', id: 'linux.img', sha256: sha256(image), bytes: image.length, format: 'raw' },
    }, null, 2)}\n`,
  );
  const qemuLink = path.join(runtime, 'qemu');
  try {
    fs.symlinkSync(QEMU_CACHE, qemuLink, 'junction');
  } catch {
    fs.cpSync(QEMU_CACHE, qemuLink, { recursive: true });
  }
  return { runtime, imageFile, imageSha: sha256(image), imageBytes: image.length };
}

function writeRecord(home, cid, fields) {
  const directory = path.join(home, 'computers', cid);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'token'), `${'ab'.repeat(16)}\n`);
  const controlKey = 'cd'.repeat(32);
  fs.writeFileSync(path.join(directory, 'control.key'), `${controlKey}\n`);
  const record = {
    version: 2,
    computerId: cid,
    name: `omp-${cid}`,
    image: 'linux.img',
    imagePath: fields.imagePath,
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
    ports: { spacesd: fields.port },
    cpus: 2,
    memoryMb: 2048,
    accel: 'whpx,kernel-irqchip=off',
    createdAt: Date.now(),
    startedAt: null,
    pid: null,
    supervisorPid: null,
    display: null,
    guest: null,
    ...(fields.imageSha256 === undefined ? {} : { imageSha256: fields.imageSha256 }),
    ...(fields.imageBytes === undefined ? {} : { imageBytes: fields.imageBytes }),
    ...(fields.backingFormat === undefined ? {} : { backingFormat: fields.backingFormat }),
  };
  fs.writeFileSync(path.join(directory, 'vm.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { directory, record };
}

function readRecord(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'vm.json'), 'utf8'));
}

function describeError(error) {
  return { code: error?.code ?? error?.name ?? 'unknown', message: String(error?.message ?? error) };
}

async function loadBackend() {
  return await import(pathToFileURL(path.join(REPO, 'src', 'computer-backend.mjs')).href);
}

buildQemuCache();
const { runtime, imageFile, imageSha, imageBytes } = buildRuntime();

// ---------------------------------------------------------------- S1
const s1Home = path.join(TMP, 's1-home');
fs.rmSync(s1Home, { recursive: true, force: true });
const s1 = writeRecord(s1Home, 'pc_s1', {
  imagePath: imageFile,
  port: 47111,
  imageSha256: 'a1'.repeat(32), // stale: describes a disk that is gone / another image
  imageBytes: 4096,
  backingFormat: 'raw',
});
log('S1 record:', s1.record.imageSha256.slice(0, 16), 'diskExists=', fs.existsSync(s1.record.disk));

// S2 old image = byte-identical copy at another path (the moved runtime case)
const oldRuntimeImages = path.join(TMP, 'old-runtime', 'images');
fs.rmSync(path.join(TMP, 'old-runtime'), { recursive: true, force: true });
fs.mkdirSync(oldRuntimeImages, { recursive: true });
const oldImage = path.join(oldRuntimeImages, 'linux.img');
fs.copyFileSync(imageFile, oldImage);

const s2Home = path.join(TMP, 's2-home');
fs.rmSync(s2Home, { recursive: true, force: true });
const s2 = writeRecord(s2Home, 'pc_s2', { imagePath: oldImage, port: 47112 });
// legacy disk created against the old image, exactly like createOverlay() does it
const backingArg = process.platform === 'win32' ? `\\\\?\\${oldImage}` : oldImage;
const overlay = spawnQemuImg(['create', '-q', '-f', 'qcow2', '-b', backingArg, '-F', 'raw', s2.record.disk]);
if (overlay.status !== 0) failHarness(`qemu-img create for S2 failed: ${overlay.stderr || overlay.stdout}`);

if (fixtureOnly) {
  log('fixture S1:', JSON.stringify(readRecord(s1.directory).imageSha256));
  log('fixture S2:', JSON.stringify({ disk: s2.record.disk, info: spawnQemuImg(['info', '--output=json', s2.record.disk]).stdout.trim() }));
  log('fixture-only run: no backend call made');
  process.exit(0);
}

const { ComputerBackend } = await loadBackend();
const red = [];
let harness = null;

// ---- S1: rebuilt disk must not be blocked by the stale stamp
try {
  const backend = new ComputerBackend({ home: s1Home, runtimeDir: runtime });
  let staleStampError = false;
  try {
    const state = await backend.create('pc_s1');
    log('S1 create() returned state=', state?.state);
  } catch (error) {
    const { code, message } = describeError(error);
    log('S1 create() rejected:', code, '|', message.slice(0, 200));
    staleStampError = message.includes('changed content since this computer was created');
    if (staleStampError) {
      red.push('S1: stale stamp still blocks a freshly rebuilt disk (create rejected with the "changed content" error)');
    } else if (!/QMP supervisor|guest|QEMU/.test(message)) {
      harness = `S1 unexpected error: ${code} ${message}`;
    }
  }
  const persisted = readRecord(s1.directory);
  log('S1 persisted stamp:', String(persisted.imageSha256).slice(0, 16), 'expected', imageSha.slice(0, 16));
  if (harness === null && !staleStampError && !(persisted.imageSha256 === imageSha && persisted.imageBytes === imageBytes)) {
    harness = `S1 stamp was not refreshed to the current image (got ${persisted.imageSha256})`;
  }
} catch (error) {
  harness = `S1 harness: ${describeError(error).message}`;
}

// ---- S2: relocation must write the real backing format
try {
  const backend = new ComputerBackend({ home: s2Home, runtimeDir: runtime });
  try {
    const state = await backend.start('pc_s2');
    log('S2 start() returned state=', state?.state);
  } catch (error) {
    const { code, message } = describeError(error);
    log('S2 start() rejected:', code, '|', message.slice(0, 200));
    if (!/QMP supervisor|guest|QEMU/.test(message)) {
      harness = `S2 unexpected error: ${code} ${message}`;
    }
  }
  const info = spawnQemuImg(['info', '--output=json', s2.record.disk]);
  const parsed = info.status === 0 ? JSON.parse(info.stdout) : null;
  const format = parsed?.['backing-filename-format'] ?? null;
  const outFile = path.join(TMP, 's2-out.raw');
  const converted = spawnQemuImg(['convert', '-f', 'qcow2', '-O', 'raw', s2.record.disk, outFile]);
  const equal = converted.status === 0 && fs.existsSync(outFile) && sha256(fs.readFileSync(outFile)) === imageSha;
  log('S2 backing-filename-format:', format, '| chain opens+reads correct bytes:', equal);
  if (format === 'qcow2' && !equal) {
    red.push('S2: relocation wrote backing-filename-format=qcow2 for a raw image; the disk can no longer open its backing chain');
  } else if (harness === null && !(format === 'raw' && equal)) {
    harness = `S2 relocation did not produce an openable chain (format=${format}, equal=${equal})`;
  }
} catch (error) {
  harness = `S2 harness: ${describeError(error).message}`;
}

if (harness) {
  console.error(`HARNESS ERROR: ${harness}`);
  process.exit(1);
}
if (red.length) {
  for (const line of red) console.error(`BUG reproduced -> ${line}`);
  process.exit(2);
}
log('PASS: both scenarios behave as fixed (S1 stamp refreshed, S2 backing format raw and openable)');
process.exit(0);

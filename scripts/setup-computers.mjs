#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const CLI_RELEASE = {
  version: '0.4.1',
  url: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.4.1/cua-cli-0.4.1-windows-x64.zip',
  archiveSha256: '4324f68e51ec230c74c26eed614d9f819b7ba05a039eb41f09154ac6af9aa8c8',
  exeSha256: '583a09f21793997b4a619e722ce5390f8c483a06de002e65c156198107c1e90e',
  license: { name: 'MIT', url: 'https://raw.githubusercontent.com/trycua/cua/cua-sdk-v0.4.1/LICENSE.md' },
};

const QEMU_RELEASE = {
  version: '11.1.0',
  url: 'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  archiveSha512: '5bcf9eed634e8575a37b74f445af41a2fe4106da512d0c30c368301d4c105037fdfab40a5287367a28a957624cddebbc8c07e16c88ab6634f554cdf3d16bf543',
  systemSha256: '47d57a6072e0bb3bd98f87926eb129eb1736dfe818c67b3b81ef7ce4edd0b3cd',
  imgSha256: '9d930582d0d574bb106d89982c547688e10b8f356192d302cc3d0ae4e8674534',
  license: { name: 'GPL-2.0-or-later / LGPL-2.1-or-later', files: ['COPYING', 'COPYING.LIB'] },
};

/** 官方 Linux 镜像：registry manifest 与它在本机镜像库里的磁盘 digest 是两回事，两个都记。 */
const IMAGE_RELEASE = {
  reference: 'ghcr.io/trycua/linux@sha256:f1a1a0b36388c7e42faae58b2015efa048963faef4817a11376f90cfd1835369',
  storeDigest: 'sha256:1a5014da91afbbaaf28df9b2fec2c7f5a0bd322b46be1e7079f5081c1438482c',
  sha256: '57feb6ef48446f4eff4541266841ec78d79e0a8662f2e9e3081942c9c4581721',
  bytes: 1_306_198_016,
  format: 'qcow2',
  virtualSize: 21_474_836_480,
  clusterSize: 65_536,
  id: 'linux.img',
  file: 'images/linux.img',
  license: {
    name: 'FSL-1.1-MIT',
    component: 'cua-spacesd（客机镜像内）',
    url: 'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-spacesd/LICENSE',
  },
};

const NOTICE_ASSETS = {
  cli: { asset: 'desktop/CUA-CLI-LICENSE', file: 'licenses/cua-cli-LICENSE.md' },
  image: { asset: 'desktop/CUA-SPACESD-LICENSE', file: 'licenses/cua-spacesd-LICENSE.txt' },
};

const QEMU_KEEP_TOP_LEVEL = new Set(['qemu-system-x86_64.exe', 'qemu-img.exe']);
const QEMU_SKIP_DIRS = new Map([
  ['$PLUGINSDIR', 'NSIS 安装器自带的插件目录，不是 QEMU 资料'],
  ['share/doc', 'QEMU 的 HTML 文档，运行不需要'],
  ['share/dtb', 'ARM/其他架构的设备树，x86_64 走 ACPI 不需要'],
]);
const QEMU_OTHER_ARCH_FIRMWARE = /^edk2-(arm|armeb|aarch64|riscv|loongarch64)[-.].*\.fd$/;

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  return error;
}

function hashFile(file, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  const buffer = Buffer.alloc(4 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw fail(`${label} 不存在或是目录：${file}`);
  }
  return file;
}

function inspectImage(file) {
  const header = Buffer.alloc(32);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const bytes = fs.statSync(file).size;
  if (header.subarray(0, 4).toString('binary') !== 'QFI\xfb') {
    return { format: 'raw', bytes, virtualSize: null, clusterSize: null };
  }
  return {
    format: 'qcow2',
    bytes,
    virtualSize: Number(header.readBigUInt64BE(24)),
    clusterSize: 2 ** header.readUInt32BE(20),
  };
}

function qemuSkipReason(relative) {
  const posix = relative.split(path.sep).join('/');
  if (posix === '') return null;
  for (const [prefix, reason] of QEMU_SKIP_DIRS) {
    if (posix === prefix || posix.startsWith(`${prefix}/`)) return reason;
  }
  const parts = posix.split('/');
  const name = parts[parts.length - 1];
  if (parts.length === 1 && name.endsWith('.exe') && !QEMU_KEEP_TOP_LEVEL.has(name)) {
    return '其他架构/QEMU 自带的其他可执行文件，本后端只用 qemu-system-x86_64.exe 与 qemu-img.exe';
  }
  if (QEMU_OTHER_ARCH_FIRMWARE.test(name)) return '其他架构的 UEFI 固件，x86_64 不用';
  return null;
}

function parseArgs(argv) {
  const options = {
    runtimeSource: null,
    imageSource: null,
    imageDigest: null,
    runtimeDir: null,
    sevenZip: null,
    force: false,
    json: false,
    help: false,
  };
  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw fail(`${flag} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--runtime-source':
        options.runtimeSource = takeValue(index, arg);
        index += 1;
        break;
      case '--image-source':
        options.imageSource = takeValue(index, arg);
        index += 1;
        break;
      case '--image-digest':
        options.imageDigest = takeValue(index, arg);
        index += 1;
        break;
      case '--runtime-dir':
        options.runtimeDir = takeValue(index, arg);
        index += 1;
        break;
      case '--7z':
        options.sevenZip = takeValue(index, arg);
        index += 1;
        break;
      case '--force':
      case '-f':
        options.force = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw fail(`未知参数 ${arg}（--help 看用法）`);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/setup-computers.mjs [选项]',
    '',
    '  --runtime-source <dir>   复用本机已核验资产（目录里含 cua.exe 与 qemu/）',
    '  --image-source <file>    复用已核验的官方镜像文件（qcow2）',
    '  --image-digest <sha256>  覆盖镜像内容的预期 sha256（默认用记录值）',
    '  --runtime-dir <dir>      目标目录（默认 .computer-runtime，或 OMPBOT_COMPUTER_RUNTIME）',
    '  --7z <path>              解包 QEMU 安装包用的 7-Zip（无源参数时才需要）',
    '  --force                  重新复制已存在的资产',
    '  --json                   只打印 manifest.json',
    '  --help                   显示这段说明',
  ].join('\n');
}

function defaultRuntimeDir() {
  const fromEnv = process.env.OMPBOT_COMPUTER_RUNTIME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return path.join(REPO_ROOT, '.computer-runtime');
}

function report(options, message) {
  if (!options.json) process.stdout.write(`${message}\n`);
}

async function fetchVerified(options, url, file, algorithm, expected, label) {
  if (fs.existsSync(file) && hashFile(file, algorithm) === expected) return file;
  // 只删本脚本写进 .setup-work 的坏缓存；用户 --runtime-source/--image-source 的文件不经过这里
  fs.rmSync(file, { force: true });
  const partial = `${file}.partial`;
  fs.rmSync(partial, { force: true });
  report(options, `下载 ${label}：${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok) throw fail(`下载 ${url} 失败：HTTP ${response.status}`);
  const body = response.body;
  if (!body) throw fail(`下载 ${url} 没有响应体`);
  try {
    const handle = fs.openSync(partial, 'w');
    try {
      for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        let offset = 0;
        while (offset < buffer.length) offset += fs.writeSync(handle, buffer, offset);
      }
    } finally {
      fs.closeSync(handle);
    }
    verify(partial, algorithm, expected, label);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, file);
  return file;
}

function verify(file, algorithm, expected, label) {
  const actual = hashFile(file, algorithm);
  if (actual !== expected) {
    throw fail(`${label} 的 ${algorithm} 不符：期望 ${expected}，实际 ${actual}（${file}）`);
  }
  return actual;
}

function findTool(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = candidate.includes(path.sep) || candidate.includes('/') ? candidate : null;
    if (resolved) {
      if (fs.existsSync(resolved)) return resolved;
      continue;
    }
    const probe = spawnSync(candidate, ['i'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (probe.status !== null && probe.status !== undefined) return candidate;
  }
  return null;
}

function findSevenZip(options) {
  const explicit = options.sevenZip ?? process.env.OMPBOT_7Z ?? null;
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return findTool([
    explicit,
    path.join(programFiles, '7-Zip', '7z.exe'),
    path.join(programFilesX86, '7-Zip', '7z.exe'),
    '7z.exe',
    '7zr.exe',
    '7za.exe',
    '7z',
  ]);
}

function extractZipWithTar(archive, target) {
  fs.mkdirSync(target, { recursive: true });
  const result = spawnSync('tar', ['-xf', archive, '-C', target], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
  if (result.status !== 0) {
    throw fail(`解包 ${archive} 失败（tar 退出码 ${result.status}）：${(result.stderr || result.stdout || '').trim()}`);
  }
}

function extractWithSevenZip(sevenZip, archive, target) {
  fs.mkdirSync(target, { recursive: true });
  const result = spawnSync(sevenZip, ['x', '-y', `-o${target}`, archive], { encoding: 'utf8', windowsHide: true, timeout: 30 * 60_000 });
  if (result.status !== 0) {
    throw fail(`解包 ${archive} 失败（7-Zip 退出码 ${result.status}）：${(result.stderr || result.stdout || '').trim()}`);
  }
}

function copyFileVerified(source, target, algorithm, expected, label) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  fs.copyFileSync(source, partial);
  verify(partial, algorithm, expected, label);
  fs.renameSync(partial, target);
  return target;
}

function installCliFromSource(options, runtimeDir, manifest) {
  const source = requireFile(path.join(options.runtimeSource, 'cua.exe'), '--runtime-source 下的 cua.exe');
  const target = path.join(runtimeDir, 'cua.exe');
  if (!options.force && fs.existsSync(target) && hashFile(target) === CLI_RELEASE.exeSha256) {
    manifest.cli.action = 'reused';
  } else {
    copyFileVerified(source, target, 'sha256', CLI_RELEASE.exeSha256, 'cua.exe');
    manifest.cli.action = 'copied from --runtime-source';
  }
  manifest.cli.source = { kind: 'local-source', path: path.resolve(options.runtimeSource) };
}

async function installCliFromRelease(options, runtimeDir, manifest) {
  const target = path.join(runtimeDir, 'cua.exe');
  if (!options.force && fs.existsSync(target) && hashFile(target) === CLI_RELEASE.exeSha256) {
    manifest.cli.action = 'reused';
    return;
  }
  const work = path.join(runtimeDir, '.setup-work');
  fs.mkdirSync(work, { recursive: true });
  const archive = path.join(work, path.basename(new URL(CLI_RELEASE.url).pathname));
  await fetchVerified(options, CLI_RELEASE.url, archive, 'sha256', CLI_RELEASE.archiveSha256, 'CLI 发布包');
  const unpacked = path.join(work, 'cli');
  fs.rmSync(unpacked, { recursive: true, force: true });
  extractZipWithTar(archive, unpacked);
  const source = requireFile(path.join(unpacked, 'cua.exe'), '发布包里的 cua.exe');
  copyFileVerified(source, target, 'sha256', CLI_RELEASE.exeSha256, 'cua.exe');
  fs.rmSync(archive, { force: true });
  manifest.cli.action = 'downloaded and verified';
  manifest.cli.source = { kind: 'official-release', url: CLI_RELEASE.url, sha256: CLI_RELEASE.archiveSha256 };
}

function installQemuFromSource(options, runtimeDir, manifest) {
  const sourceRoot = options.runtimeSource;
  const system = requireFile(path.join(sourceRoot, 'qemu', 'qemu-system-x86_64.exe'), '--runtime-source 下的 qemu/qemu-system-x86_64.exe');
  const img = requireFile(path.join(sourceRoot, 'qemu', 'qemu-img.exe'), '--runtime-source 下的 qemu/qemu-img.exe');
  verify(system, 'sha256', QEMU_RELEASE.systemSha256, 'qemu-system-x86_64.exe');
  verify(img, 'sha256', QEMU_RELEASE.imgSha256, 'qemu-img.exe');
  const versionFile = path.join(sourceRoot, 'qemu', 'VERSION');
  if (!fs.existsSync(versionFile) || !fs.readFileSync(versionFile, 'utf8').trim().startsWith(QEMU_RELEASE.version)) {
    throw fail(`--runtime-source 的 QEMU 版本不是 ${QEMU_RELEASE.version}（缺 VERSION 或版本不符）`);
  }
  const target = path.join(runtimeDir, 'qemu');
  const targetSystem = path.join(target, 'qemu-system-x86_64.exe');
  const complete = fs.existsSync(targetSystem) && hashFile(targetSystem) === QEMU_RELEASE.systemSha256;
  if (!options.force && complete) {
    manifest.qemu.action = 'reused';
  } else {
    fs.mkdirSync(target, { recursive: true });
    const skipped = new Map();
    fs.cpSync(path.join(sourceRoot, 'qemu'), target, {
      recursive: true,
      force: true,
      dereference: false,
      filter: source => {
        const reason = qemuSkipReason(path.relative(path.join(sourceRoot, 'qemu'), source));
        if (reason) {
          skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
          return false;
        }
        return true;
      },
    });
    manifest.qemu.skipped = [...skipped.entries()].map(([reason, count]) => ({ reason, entries: count }));
    manifest.qemu.action = 'copied from --runtime-source';
  }
  verify(path.join(target, 'qemu-system-x86_64.exe'), 'sha256', QEMU_RELEASE.systemSha256, '复制后的 qemu-system-x86_64.exe');
  verify(path.join(target, 'qemu-img.exe'), 'sha256', QEMU_RELEASE.imgSha256, '复制后的 qemu-img.exe');
  manifest.qemu.source = { kind: 'local-source', path: path.resolve(sourceRoot) };
}

async function installQemuFromRelease(options, runtimeDir, manifest) {
  const target = path.join(runtimeDir, 'qemu');
  const targetSystem = path.join(target, 'qemu-system-x86_64.exe');
  if (!options.force && fs.existsSync(targetSystem) && hashFile(targetSystem) === QEMU_RELEASE.systemSha256) {
    manifest.qemu.action = 'reused';
    return;
  }
  const work = path.join(runtimeDir, '.setup-work');
  fs.mkdirSync(work, { recursive: true });
  const archive = path.join(work, path.basename(new URL(QEMU_RELEASE.url).pathname));
  await fetchVerified(options, QEMU_RELEASE.url, archive, 'sha512', QEMU_RELEASE.archiveSha512, 'QEMU 安装包');
  const sevenZip = findSevenZip(options);
  if (!sevenZip) {
    throw fail(
      '解包 QEMU 的 NSIS 安装包需要 7-Zip：装一个（winget install 7zip.7zip）或传 --7z <7z.exe 路径>；' +
        '也可以改用 --runtime-source 复用本机已核验的 QEMU 目录',
    );
  }
  const unpacked = path.join(work, 'qemu');
  fs.rmSync(unpacked, { recursive: true, force: true });
  extractWithSevenZip(sevenZip, archive, unpacked);
  const skipped = new Map();
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(unpacked, target, {
    recursive: true,
    force: true,
    dereference: false,
    filter: source => {
      const reason = qemuSkipReason(path.relative(unpacked, source));
      if (reason) {
        skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
        return false;
      }
      return true;
    },
  });
  manifest.qemu.skipped = [...skipped.entries()].map(([reason, count]) => ({ reason, entries: count }));
  verify(path.join(target, 'qemu-system-x86_64.exe'), 'sha256', QEMU_RELEASE.systemSha256, '解包后的 qemu-system-x86_64.exe');
  verify(path.join(target, 'qemu-img.exe'), 'sha256', QEMU_RELEASE.imgSha256, '解包后的 qemu-img.exe');
  const versionFile = path.join(target, 'VERSION');
  if (!fs.existsSync(versionFile) || !fs.readFileSync(versionFile, 'utf8').trim().startsWith(QEMU_RELEASE.version)) {
    throw fail(`解包后的 QEMU 版本不是 ${QEMU_RELEASE.version}`);
  }
  fs.rmSync(unpacked, { recursive: true, force: true });
  manifest.qemu.action = 'downloaded, verified and unpacked';
  manifest.qemu.source = { kind: 'official-release', url: QEMU_RELEASE.url, sha512: QEMU_RELEASE.archiveSha512, extractor: sevenZip };
}

/** 官方 CLI 拉镜像：只在准备资源时用一次（后端不逐动作调用 CLI）。 */
function pullImageWithCli(options, runtimeDir) {
  const cli = path.join(runtimeDir, 'cua.exe');
  const home = path.join(runtimeDir, '.setup-work', 'cua-home');
  fs.mkdirSync(home, { recursive: true });
  report(options, `用官方 CLI 拉取镜像 ${IMAGE_RELEASE.reference}`);
  const result = spawnSync(cli, ['--embedded', 'image', 'pull', IMAGE_RELEASE.reference], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60 * 60_000,
    env: { ...process.env, CUA_HOME: home, DO_NOT_TRACK: '1' },
  });
  if (result.status !== 0) {
    throw fail(
      `cua image pull 失败（退出码 ${result.status}）：${(result.stderr || result.stdout || '').trim().slice(-2000)}`,
    );
  }
  const refsDir = path.join(home, 'images', 'refs');
  if (!fs.existsSync(refsDir)) throw fail(`官方 CLI 没有写出镜像记录：${refsDir} 不存在`);
  let digest = null;
  for (const entry of fs.readdirSync(refsDir)) {
    if (!entry.endsWith('.json')) continue;
    const record = JSON.parse(fs.readFileSync(path.join(refsDir, entry), 'utf8'));
    if (record.reference === IMAGE_RELEASE.reference) digest = record.digest;
  }
  if (!digest) throw fail(`官方 CLI 的镜像记录里没有 ${IMAGE_RELEASE.reference}`);
  if (digest !== IMAGE_RELEASE.storeDigest) {
    throw fail(`官方镜像的磁盘 digest 变了：期望 ${IMAGE_RELEASE.storeDigest}，实际 ${digest}；请用 --image-source 指定已核验的镜像文件`);
  }
  return requireFile(
    path.join(home, 'images', 'disks', digest.replace(/^sha256:/, ''), 'disk.qcow2'),
    'CLI 拉下来的镜像磁盘',
  );
}

async function installImage(options, runtimeDir, manifest) {
  const target = path.join(runtimeDir, IMAGE_RELEASE.file);
  const expected = options.imageDigest ?? IMAGE_RELEASE.sha256;
  let origin;
  if (options.imageSource) {
    const source = requireFile(path.resolve(options.imageSource), '--image-source');
    if (!options.force && fs.existsSync(target) && fs.statSync(target).size === fs.statSync(source).size && hashFile(target) === expected) {
      manifest.image.action = 'reused';
    } else {
      copyFileVerified(source, target, 'sha256', expected, '镜像文件');
      manifest.image.action = 'copied from --image-source';
    }
    origin = { kind: 'local-source', path: path.resolve(source) };
  } else {
    if (!options.force && fs.existsSync(target) && hashFile(target) === expected) {
      manifest.image.action = 'reused';
      origin = { kind: 'cli-pull', reference: IMAGE_RELEASE.reference };
    } else {
      const pulled = pullImageWithCli(options, runtimeDir);
      copyFileVerified(pulled, target, 'sha256', expected, 'CLI 拉取的镜像文件');
      manifest.image.action = 'pulled with the official CLI and verified';
      origin = { kind: 'cli-pull', reference: IMAGE_RELEASE.reference, storeDigest: IMAGE_RELEASE.storeDigest };
    }
  }
  const facts = inspectImage(target);
  for (const key of ['format', 'virtualSize', 'clusterSize', 'bytes']) {
    if (facts[key] !== IMAGE_RELEASE[key]) {
      throw fail(`镜像 ${target} 的 ${key} 与记录的官方值不符：期望 ${IMAGE_RELEASE[key]}，实际 ${facts[key]}`);
    }
  }
  manifest.image = {
    ...manifest.image,
    path: IMAGE_RELEASE.file,
    id: IMAGE_RELEASE.id,
    reference: IMAGE_RELEASE.reference,
    storeDigest: IMAGE_RELEASE.storeDigest,
    sha256: expected,
    bytes: facts.bytes,
    format: facts.format,
    virtualSize: facts.virtualSize,
    clusterSize: facts.clusterSize,
    source: origin,
  };
}

function copyNotice(runtimeDir, notice, record) {
  const source = requireFile(path.join(REPO_ROOT, notice.asset), `许可原文 ${notice.asset}`);
  const sha256 = hashFile(source);
  copyFileVerified(source, path.join(runtimeDir, notice.file), 'sha256', sha256, `许可原文 ${notice.asset}`);
  record.asset = notice.asset;
  record.file = notice.file;
  record.sha256 = sha256;
}

function installLicenses(runtimeDir, manifest) {
  const qemuFiles = [];
  for (const name of QEMU_RELEASE.license.files) {
    const file = path.join(runtimeDir, 'qemu', name);
    if (!fs.existsSync(file)) {
      throw fail(`QEMU 资料里缺少许可文件 ${file}；分发前必须有 GPL/LGPL 原文`);
    }
    qemuFiles.push({ file: `qemu/${name}`, sha256: hashFile(file) });
  }
  manifest.qemu.license = { ...manifest.qemu.license, files: qemuFiles };
  copyNotice(runtimeDir, NOTICE_ASSETS.cli, manifest.cli.license);
  copyNotice(runtimeDir, NOTICE_ASSETS.image, manifest.image.license);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  options.runtimeDir = options.runtimeDir ? path.resolve(options.runtimeDir) : defaultRuntimeDir();
  if (options.runtimeSource) {
    options.runtimeSource = path.resolve(options.runtimeSource);
    if (!fs.existsSync(options.runtimeSource)) throw fail(`--runtime-source 目录不存在：${options.runtimeSource}`);
  }
  const runtimeDir = options.runtimeDir;
  fs.mkdirSync(runtimeDir, { recursive: true });
  report(options, `电脑运行资源目录：${runtimeDir}`);
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    runtimeDir: path.relative(REPO_ROOT, runtimeDir).split(path.sep).join('/') || '.',
    cli: { version: CLI_RELEASE.version, file: 'cua.exe', sha256: CLI_RELEASE.exeSha256, license: { name: CLI_RELEASE.license.name, url: CLI_RELEASE.license.url, version: CLI_RELEASE.version } },
    qemu: {
      version: QEMU_RELEASE.version,
      file: 'qemu/qemu-system-x86_64.exe',
      sha256: QEMU_RELEASE.systemSha256,
      qemuImg: { file: 'qemu/qemu-img.exe', sha256: QEMU_RELEASE.imgSha256 },
      license: { name: QEMU_RELEASE.license.name },
    },
    image: { license: { name: IMAGE_RELEASE.license.name, component: IMAGE_RELEASE.license.component, url: IMAGE_RELEASE.license.url } },
  };

  if (options.runtimeSource) {
    report(options, '复用已核验的本机资产（--runtime-source）');
    installCliFromSource(options, runtimeDir, manifest);
    installQemuFromSource(options, runtimeDir, manifest);
  } else {
    report(options, '从记录的官方发布下载并核验运行资源');
    await installCliFromRelease(options, runtimeDir, manifest);
    await installQemuFromRelease(options, runtimeDir, manifest);
  }
  await installImage(options, runtimeDir, manifest);
  installLicenses(runtimeDir, manifest);

  const manifestFile = path.join(runtimeDir, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(runtimeDir, '.setup-work'), { recursive: true, force: true });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return 0;
  }
  report(options, `cua.exe ${manifest.cli.sha256} （${manifest.cli.action}）`);
  report(options, `qemu ${manifest.qemu.version} ${manifest.qemu.sha256} （${manifest.qemu.action}）`);
  report(options, `镜像 ${manifest.image.path} ${manifest.image.format} ${manifest.image.bytes} 字节 sha256 ${manifest.image.sha256}`);
  report(options, `许可原文：${manifest.cli.license.file}、${manifest.image.license.file}（复制自 ${manifest.cli.license.asset}、${manifest.image.license.asset}）+ qemu/COPYING*`);
  report(options, `manifest：${manifestFile}`);
  return 0;
}

main(process.argv.slice(2))
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    process.stderr.write(`${error?.expected ? '错误：' : '未预期错误：'}${error?.message ?? error}\n`);
    process.exitCode = 1;
  });

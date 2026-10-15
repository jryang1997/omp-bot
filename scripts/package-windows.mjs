import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const runtime = process.env.OMPBOT_COMPUTER_RUNTIME?.trim()
  ? path.resolve(process.env.OMPBOT_COMPUTER_RUNTIME.trim())
  : path.join(root, ".computer-runtime");

/** 资源包只打这三棵目录树；内容指纹也严格按同一范围计算。 */
const PACK_DIRS = ["qemu", "images", "licenses"];
const ARCHIVE_META_VERSION = 1;

export const releasePaths = {
  output: path.join(root, "release"),
  staging: path.join(root, "release", ".computer-runtime-pack"),
  archive: path.join(root, "release", "omp-bot-computer-runtime.zip"),
  archivePartial: path.join(root, "release", "omp-bot-computer-runtime.zip.partial"),
  archiveMeta: path.join(root, "release", "omp-bot-computer-runtime.zip.meta.json"),
  builderOutput: path.join(root, "release", ".electron-builder-tmp"),
};
const { output, staging, archive, archivePartial, archiveMeta, builderOutput } = releasePaths;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 失败，退出码 ${result.status}`);
}

/** 流式 sha256：镜像与安装包都是几百 MB 起步，绝不整块读进内存。 */
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 与 stageTree 相同的遍历规则：只接受目录和普通文件，其余（符号链接等）直接报错。 */
export function collectPackEntries(source = runtime) {
  const entries = [];
  const walk = (dir, rel) => {
    entries.push({ rel: `${rel}/`, type: "dir" });
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const relPath = `${rel}/${name}`;
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) walk(abs, relPath);
      else if (stat.isFile()) entries.push({ rel: relPath, abs, type: "file" });
      else throw new Error(`电脑资源必须是普通文件或目录：${abs}`);
    }
  };
  for (const entry of PACK_DIRS) {
    const dir = path.join(source, entry);
    if (!fs.existsSync(dir)) throw new Error(`电脑资源缺少 ${entry}/ 目录：${source}`);
    walk(dir, entry);
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

/** 逐文件真实内容哈希；清单核对与复用判断共用同一份结果，避免重复读盘。 */
export async function hashPackEntries(entries) {
  const hashes = new Map();
  for (const entry of entries) {
    if (entry.type === "file") hashes.set(entry.rel, await hashFile(entry.abs));
  }
  return hashes;
}

/** 资源包内容指纹：目录结构 + 每个文件的实际 sha256 + 写进 zip 的 manifest 原文。 */
export function packDigest(entries, hashes, packedManifestText) {
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(entry.type === "file" ? `${entry.rel}\tfile\t${hashes.get(entry.rel)}\n` : `${entry.rel}\tdir\n`);
  }
  digest.update(`manifest\t${createHash("sha256").update(packedManifestText).digest("hex")}\n`);
  return digest.digest("hex");
}

/** 写进资源包内的 manifest 原文（去掉仅准备镜像用的 CLI 字段，补上包信息）。 */
export function packedManifest(manifest) {
  const packed = { ...manifest, runtimeDir: "computer-runtime" };
  delete packed.cli;
  packed.pack = { file: path.basename(archive), excludes: ["cua.exe", ".setup-work"], note: "CLI 仅用于准备镜像；应用通过 SDK DLL 操作电脑。" };
  return packed;
}

export function readArchiveMeta() {
  try {
    const meta = JSON.parse(fs.readFileSync(archiveMeta, "utf8"));
    return meta && typeof meta === "object" && meta.v === ARCHIVE_META_VERSION ? meta : null;
  } catch {
    return null;
  }
}

/** 复用判断只看实际内容：旧包的整包 sha256 与记录相符，且记录的输入指纹等于当前内容指纹。 */
export async function archiveReusable(inputsDigest) {
  if (!fs.existsSync(archive)) return false;
  const meta = readArchiveMeta();
  if (!meta || meta.inputsDigest !== inputsDigest) return false;
  if (!/^[0-9a-f]{64}$/.test(meta.archiveSha256 ?? "") || !Number.isInteger(meta.archiveBytes)) return false;
  const stat = fs.statSync(archive);
  if (!stat.isFile() || stat.size !== meta.archiveBytes) return false;
  return (await hashFile(archive)) === meta.archiveSha256;
}

export function writeArchiveMeta(inputsDigest, sha256, bytes) {
  const meta = {
    v: ARCHIVE_META_VERSION,
    inputsDigest,
    archiveSha256: sha256,
    archiveBytes: bytes,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(archiveMeta, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

function assertAsset(asset, hashes) {
  if (!asset?.file || !/^[0-9a-f]{64}$/i.test(asset.sha256 ?? "")) {
    throw new Error("电脑资源清单缺少文件或 SHA-256，请运行 npm run setup:computers。");
  }
  const rel = String(asset.file).replace(/\\/g, "/").replace(/^\.\//, "");
  const hash = hashes.get(rel);
  if (hash === undefined) {
    throw new Error(`电脑资源清单里的 ${asset.file} 不在 ${PACK_DIRS.join("/、")}/ 内或文件缺失，请运行 npm run setup:computers。`);
  }
  if (hash !== asset.sha256.toLowerCase()) {
    throw new Error(`电脑资源 ${asset.file} 与清单不符，请运行 npm run setup:computers。`);
  }
}

function stageTree(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) stageTree(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) {
    try { fs.linkSync(source, target); }
    catch (error) {
      if (!["EXDEV", "EPERM", "ENOTSUP"].includes(error.code)) throw error;
      fs.copyFileSync(source, target);
    }
  } else {
    throw new Error(`电脑资源必须是普通文件或目录：${source}`);
  }
}

/** 复用或重建独立资源包。先写 .partial、整包哈希通过后再改名，失败不碰现有成品。 */
async function ensureArchive(packedManifestText, inputsDigest, sevenZip) {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(archivePartial, { force: true });
  if (await archiveReusable(inputsDigest)) {
    console.log(`电脑资源内容未变化，复用现有资源包 ${archive}`);
    return;
  }
  try {
    const top = path.join(staging, "computer-runtime");
    fs.mkdirSync(top, { recursive: true });
    for (const entry of PACK_DIRS) {
      stageTree(path.join(runtime, entry), path.join(top, entry));
    }
    fs.writeFileSync(path.join(top, "manifest.json"), packedManifestText);
    run(sevenZip, ["a", "-tzip", "-mx=5", "-mtc=off", "-bso0", "-bsp0", archivePartial, "computer-runtime"], staging);
    const bytes = fs.statSync(archivePartial).size;
    const sha256 = await hashFile(archivePartial);
    fs.renameSync(archivePartial, archive);
    writeArchiveMeta(inputsDigest, sha256, bytes);
    console.log(`电脑资源包 ${(bytes / 1024 ** 2).toFixed(1)} MiB：${archive}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(archivePartial, { force: true });
  }
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}.${i}${ext}`);
  return candidate;
}

/** 上次换入被中断的收尾：X.pk-backup 还在而 X 缺失时把备份放回原位；两者都在则备份多余，删掉。 */
function recoverInterruptedPublish() {
  for (const name of fs.readdirSync(output)) {
    if (!name.endsWith(".pk-backup")) continue;
    const backup = path.join(output, name);
    const to = backup.slice(0, -".pk-backup".length);
    try {
      if (fs.existsSync(to)) fs.rmSync(backup, { recursive: true, force: true });
      else fs.renameSync(backup, to);
    } catch (error) {
      throw new Error(`恢复上次未完成的换入失败，保留 ${backup} 以便人工恢复：${error.message}`);
    }
  }
}

/** 安装包与便携包先在隔离目录生成，成功后换入 release/：先目录后文件。
    旧条目先整体挪到 .pk-backup（不删除），换入失败即回滚；全部成功后才删备份。 */
function publishBuildOutputs(version) {
  const expected = [`omp-bot-${version}-setup.exe`, `omp-bot-${version}-portable.zip`];
  for (const name of expected) {
    if (!fs.existsSync(path.join(builderOutput, name))) {
      throw new Error(`electron-builder 未产出 ${name}，release/ 里现有成品保持原样。`);
    }
  }
  const names = fs.readdirSync(builderOutput);
  const dirs = names.filter((name) => fs.lstatSync(path.join(builderOutput, name)).isDirectory());
  const files = names.filter((name) => !dirs.includes(name));
  const swaps = [];
  const rollback = () => {
    for (const { to, backup } of swaps.reverse()) {
      try {
        fs.rmSync(to, { recursive: true, force: true });
        if (backup) fs.renameSync(backup, to);
      } catch (error) {
        console.warn(`回滚 ${to} 失败：${error.message}`);
      }
    }
  };
  try {
    for (const name of [...dirs, ...files]) {
      const from = path.join(builderOutput, name);
      const to = path.join(output, name);
      let backup = null;
      if (fs.existsSync(to)) {
        backup = `${to}.pk-backup`;
        fs.rmSync(backup, { recursive: true, force: true });
        fs.renameSync(to, backup);
      }
      try {
        fs.renameSync(from, to);
      } catch (error) {
        if (backup) {
          try { fs.renameSync(backup, to); }
          catch (rollbackError) { console.error(`回滚 ${to} 失败，旧数据保留在 ${backup}：${rollbackError.message}`); }
        }
        throw error;
      }
      swaps.push({ to, backup });
    }
  } catch (error) {
    rollback();
    throw error;
  }
  cleanupAfterPublish(swaps);
}

function cleanupAfterPublish(swaps) {
  for (const { backup } of swaps) {
    if (!backup) continue;
    try { fs.rmSync(backup, { recursive: true, force: true }); }
    catch (error) { console.warn(`新成品已就位，旧备份暂未删除（下次构建重试）：${backup}：${error.message}`); }
  }
  try { fs.rmSync(builderOutput, { recursive: true, force: true }); }
  catch (error) { console.warn(`隔离构建目录暂未清理（下次构建重试）：${builderOutput}：${error.message}`); }
}

/** 已完成的旧版本成品挪进 release/archive/，只认版本化的 setup/portable 名字（不动安卓与资源包）。 */
export function archiveObsoleteArtifacts(version) {
  const obsolete = /^omp-bot-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(setup\.exe|portable\.exe|portable\.zip)(\.blockmap)?$/;
  const archiveDir = path.join(output, "archive");
  let moved = 0;
  for (const name of fs.readdirSync(output)) {
    const match = obsolete.exec(name);
    if (match == null || match[1] === version) continue;
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      const destination = uniquePath(archiveDir, name);
      fs.renameSync(path.join(output, name), destination);
      console.log(`归档旧成品 ${name} → ${path.relative(root, destination)}`);
      moved++;
    } catch (error) {
      console.warn(`跳过无法归档的旧成品 ${name}：${error.message}`);
    }
  }
  return moved;
}

export async function main() {
  fs.mkdirSync(output, { recursive: true });
  recoverInterruptedPublish();
  const manifestFile = path.join(runtime, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`缺少 ${manifestFile}，请运行 npm run setup:computers，或设置 OMPBOT_COMPUTER_RUNTIME。`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  console.log("核验电脑资源、镜像与许可。");
  const fingerprintStarted = Date.now();
  const entries = collectPackEntries();
  const hashes = await hashPackEntries(entries);
  for (const asset of [
    manifest.qemu,
    manifest.qemu?.qemuImg,
    { file: manifest.image?.path, sha256: manifest.image?.sha256 },
    ...(manifest.qemu?.license?.files ?? []),
    manifest.image?.license,
  ]) assertAsset(asset, hashes);

  const packedManifestText = `${JSON.stringify(packedManifest(manifest), null, 2)}\n`;
  const inputsDigest = packDigest(entries, hashes, packedManifestText);
  console.log(`内容指纹 ${inputsDigest.slice(0, 16)}…，逐文件核对 ${entries.length} 项耗时 ${((Date.now() - fingerprintStarted) / 1000).toFixed(1)}s。`);

  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const builderRoot = path.dirname(builderRequire.resolve("app-builder-lib/package.json"));
  const { getPath7za } = builderRequire(path.join(builderRoot, "out", "toolsets", "7zip.js"));
  const sevenZip = process.env.OMPBOT_7Z || await getPath7za();
  await ensureArchive(packedManifestText, inputsDigest, sevenZip);

  run(process.execPath, [path.join(root, "scripts", "prepare-desktop.mjs")]);

  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  fs.rmSync(builderOutput, { recursive: true, force: true });
  try {
    run(process.execPath, [require.resolve("electron-builder/cli.js"), "--win", "--x64", "--publish", "never", `-c.directories.output=${builderOutput}`]);
    publishBuildOutputs(version);
  } catch (error) {
    fs.rmSync(builderOutput, { recursive: true, force: true });
    throw error;
  }
  archiveObsoleteArtifacts(version);
  console.log("Windows 安装包、ZIP 便携版和电脑资源包已生成到 release/。");
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
const isEntry = process.platform === "win32" ? entryUrl.toLowerCase() === import.meta.url.toLowerCase() : entryUrl === import.meta.url;
if (isEntry) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

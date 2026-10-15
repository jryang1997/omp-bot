// 用真实内容核对 release/omp-bot-computer-runtime.zip 是否就是当前 .computer-runtime 的产物：
// 解包后逐文件比对 sha256、目录清单、包内 manifest 原文，全部一致才写入 .meta.json 供
// package-windows.mjs 复用（复用判断再正反各验一次）。任何不一致都不写 meta。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  releasePaths,
  collectPackEntries,
  hashPackEntries,
  packDigest,
  packedManifest,
  hashFile,
  readArchiveMeta,
  writeArchiveMeta,
  archiveReusable,
} from "../../../scripts/package-windows.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtime = process.env.OMPBOT_COMPUTER_RUNTIME?.trim()
  ? path.resolve(process.env.OMPBOT_COMPUTER_RUNTIME.trim())
  : path.join(root, ".computer-runtime");
const scratch = fileURLToPath(new URL("./", import.meta.url));
const extractDir = path.join(scratch, "extract");

function resolve7za() {
  if (process.env.OMPBOT_7Z) return process.env.OMPBOT_7Z;
  const require = createRequire(path.join(root, "package.json"));
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const builderRoot = path.dirname(builderRequire.resolve("app-builder-lib/package.json"));
  const { getPath7za } = builderRequire(path.join(builderRoot, "out", "toolsets", "7zip.js"));
  return getPath7za();
}

const problems = [];
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) problems.push(label);
};

const started = Date.now();
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"));
const packedManifestText = `${JSON.stringify(packedManifest(manifest), null, 2)}\n`;
const entries = collectPackEntries(runtime);
const hashes = await hashPackEntries(entries);
const inputsDigest = packDigest(entries, hashes, packedManifestText);
console.log(`输入指纹 ${inputsDigest}`);
console.log(`资源包 ${releasePaths.archive}，${fs.statSync(releasePaths.archive).size} 字节`);

fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
const sevenZip = await resolve7za();
const extract = spawnSync(sevenZip, ["x", "-y", "-bso0", "-bsp0", `-o${extractDir}`, releasePaths.archive], { stdio: "inherit", windowsHide: true });
check(extract.status === 0, `7z 解包现有资源包（退出码 ${extract.status}）`);

const extractedRoot = path.join(extractDir, "computer-runtime");
const extracted = new Map();
const walk = (dir, rel) => {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const relPath = rel === "" ? name : `${rel}/${name}`;
    if (fs.lstatSync(abs).isDirectory()) walk(abs, relPath);
    else extracted.set(relPath, abs);
  }
};
if (fs.existsSync(extractedRoot)) walk(extractedRoot, "");

const expectedFiles = entries.filter((entry) => entry.type === "file").map((entry) => entry.rel);
const expectedDirs = entries.filter((entry) => entry.type === "dir").map((entry) => entry.rel);
const expectedSet = new Set([...expectedFiles, "manifest.json"]);
const missing = expectedFiles.filter((rel) => !extracted.has(rel));
const extra = [...extracted.keys()].filter((rel) => !expectedSet.has(rel));
check(missing.length === 0 && extra.length === 0, `包内文件清单与当前资源一致（缺 ${missing.length}，多 ${extra.length}${extra.length ? `：${extra.slice(0, 5).join(", ")}` : ""}）`);
check(fs.existsSync(path.join(extractedRoot, "manifest.json")) && fs.readFileSync(path.join(extractedRoot, "manifest.json"), "utf8") === packedManifestText, "包内 manifest.json 与当前打包原文一致");
let mismatched = 0;
for (const rel of expectedFiles) {
  if (!extracted.has(rel)) continue;
  if ((await hashFile(extracted.get(rel))) !== hashes.get(rel)) {
    mismatched++;
    if (mismatched <= 5) console.log(`  内容不一致：${rel}`);
  }
}
check(mismatched === 0, `包内每个文件内容与当前运行时一致（不一致 ${mismatched} 个，共 ${expectedFiles.length} 个文件）`);
const missingDirs = expectedDirs.filter((rel) => !fs.existsSync(path.join(extractedRoot, rel)));
check(missingDirs.length === 0, `包内目录齐全（缺 ${missingDirs.join(", ") || "无"}）`);

const archiveStat = fs.statSync(releasePaths.archive);
const archiveSha = await hashFile(releasePaths.archive);
if (problems.length === 0) {
  const previous = readArchiveMeta();
  writeArchiveMeta(inputsDigest, archiveSha, archiveStat.size);
  console.log(`已写入 ${releasePaths.archiveMeta}${previous ? "（覆盖旧记录）" : ""}`);
  check(await archiveReusable(inputsDigest), "复用判断：内容一致时返回 true");
  check(!(await archiveReusable("0".repeat(64))), "复用判断：指纹不符时返回 false");
} else {
  console.log(`发现 ${problems.length} 个问题，不写入 meta：\n- ${problems.join("\n- ")}`);
}
fs.rmSync(extractDir, { recursive: true, force: true });
fs.writeFileSync(
  path.join(scratch, "archive-state.json"),
  `${JSON.stringify({ archiveSha256: archiveSha, archiveBytes: archiveStat.size, inputsDigest, verifiedAt: new Date().toISOString(), pass: problems.length === 0 }, null, 2)}\n`,
);
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，结论 ${problems.length === 0 ? "PASS" : "FAIL"}`);
process.exitCode = problems.length === 0 ? 0 : 1;

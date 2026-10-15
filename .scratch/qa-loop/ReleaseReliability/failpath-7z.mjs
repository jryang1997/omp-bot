// 失败路径：资源重建时 7z 失败，必须保留现有资源包、不留 .partial 与暂存目录，
// 且在进入 prepare-desktop / electron-builder 之前就中止。
// 做法：把 .meta.json 暂时挪走（没有就直接跑，强制走重建分支），
// 用 node.exe 冒充 7z（必然退出码 1）运行真实打包脚本，再核对 release/ 无损失、无残留。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releasePaths, hashFile } from "../../../scripts/package-windows.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const metaHold = `${releasePaths.archiveMeta}.hold`;
if (!fs.existsSync(releasePaths.archive)) throw new Error(`没有可核对的资源包：${releasePaths.archive}`);

const beforeStat = fs.statSync(releasePaths.archive);
const beforeSha = await hashFile(releasePaths.archive);
const hadMeta = fs.existsSync(releasePaths.archiveMeta);
if (hadMeta) {
  fs.rmSync(metaHold, { force: true });
  fs.renameSync(releasePaths.archiveMeta, metaHold);
}
const started = Date.now();
let result;
try {
  result = spawnSync(process.execPath, [path.join(root, "scripts", "package-windows.mjs")], {
    cwd: root,
    env: { ...process.env, OMPBOT_7Z: process.execPath },
    stdio: "inherit",
    windowsHide: true,
    timeout: 900_000,
  });
} finally {
  if (hadMeta) fs.renameSync(metaHold, releasePaths.archiveMeta);
}

const problems = [];
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) problems.push(label);
};
check(result.status !== 0, `7z 失败时打包以非零退出（退出码 ${result.status}）`);
const afterStat = fs.statSync(releasePaths.archive);
check(afterStat.size === beforeStat.size && afterStat.mtimeMs === beforeStat.mtimeMs, "现有资源包大小与修改时间未变");
check((await hashFile(releasePaths.archive)) === beforeSha, "现有资源包内容 sha256 未变");
check(!fs.existsSync(releasePaths.archivePartial), "没有残留 .partial");
check(!fs.existsSync(releasePaths.staging), "没有残留 .computer-runtime-pack");
check(!fs.existsSync(releasePaths.builderOutput), "没有生成 electron-builder 隔离目录（失败发生在打包之前）");
check(!hadMeta || fs.existsSync(releasePaths.archiveMeta), "探针挪走的 .meta.json 已复原");
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，结论 ${problems.length === 0 ? "PASS" : `FAIL：${problems.join("；")}`}`);
process.exitCode = problems.length === 0 ? 0 : 1;

// prepare-desktop.mjs — 把本机原生 omp.exe 连同许可与版本 provenance 放进 .desktop-runtime，
// 供 electron-builder 作为 extraResources 打进安装包。
//
// 只复制可执行文件、OMP-LICENSE、VERSION 和 PROVENANCE.json：不带任何凭据、配置或会话。
// 版本低于兼容底线（OMP >= 18.10）时直接失败，避免打进一个用不了的引擎。
// 组装先在 .desktop-runtime-tmp 完成、整棵目录校验后再换入 .desktop-runtime：
// 复制或校验中途失败时，上一份可用的运行时保持原样。omp.exe 有几百 MB，哈希全部流式读取。
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_OMP = [18, 10, 0];
const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, ".desktop-runtime");
const staging = join(root, ".desktop-runtime-tmp");
const backup = join(root, ".desktop-runtime-bak");

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? m.slice(1, 4).map(Number) : null;
}
function atLeast(found, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if ((found[i] ?? 0) !== minimum[i]) return (found[i] ?? 0) > minimum[i];
  }
  return true;
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const candidates = (process.env.PATH || "")
  .split(delimiter)
  .filter(Boolean)
  .map((dir) => join(resolve(dir), "omp.exe"));
if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "omp", "omp.exe"));
const source = candidates.find(existsSync);
if (!source) throw new Error("未找到 omp.exe，请先安装 OMP，再运行 npm run package:win。");

const version = execFileSync(source, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).trim();
const parsed = parseVersion(version);
if (!parsed || !atLeast(parsed, MIN_OMP)) {
  throw new Error(`本机 OMP 是 ${version || "未知版本"}，低于要求的 ${MIN_OMP.join(".")}。安装包不会打进不兼容的引擎。`);
}

let sha256;
// 上次换入若在搬走 .desktop-runtime 后被中断，backup 就是最后一份可用运行时：先恢复原位，再动其它东西。
if (!existsSync(target) && existsSync(backup)) await rename(backup, target);

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  const sourceSha256 = await hashFile(source);
  await copyFile(source, join(staging, "omp.exe"));
  await copyFile(join(root, "desktop", "OMP-LICENSE"), join(staging, "OMP-LICENSE"));
  await writeFile(join(staging, "VERSION"), `${version}\n`, "utf8");
  sha256 = await hashFile(join(staging, "omp.exe"));
  if (sha256 !== sourceSha256) {
    throw new Error("复制 omp.exe 后内容校验失败，未替换现有 .desktop-runtime。");
  }
  await writeFile(
    join(staging, "PROVENANCE.json"),
    `${JSON.stringify(
      {
        v: 1,
        file: "omp.exe",
        version,
        sha256,
        source,
        sourceSha256,
        license: "MIT（见同目录 OMP-LICENSE）",
        compatibility: `omp-bot 需要 OMP >= ${MIN_OMP.join(".")}`,
        note: "只复制可执行文件与许可；未复制任何凭据、配置或会话。",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await readFile(join(root, "web", "assets", "app-icon.ico"));
} catch (error) {
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  throw error;
}

await rm(backup, { recursive: true, force: true });
if (existsSync(target)) await rename(target, backup);
try {
  await rename(staging, target);
} catch (error) {
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  if (existsSync(backup)) await rename(backup, target);
  throw error;
}
await rm(backup, { recursive: true, force: true }).catch((error) => {
  console.warn(`旧 .desktop-runtime 备份清理失败，可手动删除 ${backup}：${error.message}`);
});
console.log(`Bundled ${version} (sha256 ${sha256.slice(0, 12)}…) from ${source}. No credentials, configuration or sessions copied.`);

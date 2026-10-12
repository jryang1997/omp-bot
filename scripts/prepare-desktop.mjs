// prepare-desktop.mjs — 把本机原生 omp.exe 连同许可与版本 provenance 放进 .desktop-runtime，
// 供 electron-builder 作为 extraResources 打进安装包。
//
// 只复制可执行文件、OMP-LICENSE、VERSION 和 PROVENANCE.json：不带任何凭据、配置或会话。
// 版本低于兼容底线（OMP >= 18.10）时直接失败，避免打进一个用不了的引擎。
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const MIN_OMP = [18, 10, 0];
const root = fileURLToPath(new URL("../", import.meta.url));

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

const target = join(root, ".desktop-runtime");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await copyFile(source, join(target, "omp.exe"));
await copyFile(join(root, "desktop", "OMP-LICENSE"), join(target, "OMP-LICENSE"));
await writeFile(join(target, "VERSION"), `${version}\n`, "utf8");

const sha256 = createHash("sha256").update(readFileSync(join(target, "omp.exe"))).digest("hex");
await writeFile(
  join(target, "PROVENANCE.json"),
  `${JSON.stringify(
    {
      v: 1,
      file: "omp.exe",
      version,
      sha256,
      source,
      sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
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
console.log(`Bundled ${version} (sha256 ${sha256.slice(0, 12)}…) from ${source}. No credentials, configuration or sessions copied.`);

// 从上游源码生成吉祥物头像的自定义元素 web/vendor/mascot/omp-mascot.js，并写 NOTICE、复制上游 LICENSE。
// 用法：OMS_DIR=<上游源码检出目录> npm run build:mascot
// 上游检出必须停在 UPSTREAM_COMMIT。换版本时先改这个常量，重新生成，再看一遍渲染截图。
// 只取运行时引擎、生成好的身体轮廓和表情几何，不取 React 组件和 scripts/mascot-shapes 下的生成脚本。
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_URL = "https://github.com/milind-soni/OpenMausBot";
export const UPSTREAM_COMMIT = "330b098b7b59a9f066ae6cd013fb3b21ecf78956";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web", "vendor", "mascot");
const ELEMENT = join(ROOT, "scripts", "mascot", "element.ts");

function fail(message) {
  console.error(`build-mascot：${message}`);
  process.exit(1);
}

// 每一处改写都必须命中，上游改了结构就停下来，不生成半对的文件。
function replaceOnce(text, from, to, where) {
  if (!text.includes(from)) fail(`${where} 里找不到要改写的片段：${from.slice(0, 60)}`);
  return text.replace(from, to);
}

const upstream = process.env.OMS_DIR;
if (!upstream || !existsSync(join(upstream, "src", "components", "CursorAvatar.tsx"))) {
  fail("先把上游源码检出到本地，再用 OMS_DIR 指向它");
}
const head = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== UPSTREAM_COMMIT) fail(`上游检出在 ${head}，脚本固定的是 ${UPSTREAM_COMMIT}`);

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  fail("缺少 esbuild，先在仓库根目录运行 npm install");
}

const work = mkdtempSync(join(tmpdir(), "omp-mascot-"));
try {
  const gen = join(work, "upstream");
  mkdirSync(gen, { recursive: true });
  const read = (rel) => readFileSync(join(upstream, rel), "utf8");

  // 1. 引擎：CursorAvatar.tsx 里 React 组件之前的部分是纯 DOM 代码，组件之后的 displayed* 助手也要。
  const avatar = read("src/components/CursorAvatar.tsx").split("\n");
  const cut = avatar.findIndex((line) => line.startsWith("export interface CursorAvatarProps"));
  const tail = avatar.findIndex((line) => line.startsWith("function displayed("));
  if (cut < 0 || tail < 0) fail("CursorAvatar.tsx 的结构变了，找不到组件边界");
  let engine = [...avatar.slice(0, cut), ...avatar.slice(tail)].join("\n");
  engine = replaceOnce(engine, "import React, { useEffect, useId, useMemo, useRef } from 'react'\n", "", "CursorAvatar.tsx");
  engine = replaceOnce(engine, '"../../shared/mascot-bodies"', '"./mascot-bodies"', "CursorAvatar.tsx");
  engine = replaceOnce(engine, "export default CursorAvatar", "", "CursorAvatar.tsx");
  engine += "\nexport { displayed, displayedMouth, displayedGaze, blinkScale, clone, toPath, ringCentre, clamp, VIEW_BOX, SPHERE_C, SPHERE_R, EXPR_CADENCE, BLINK }\n";
  writeFileSync(join(gen, "engine.ts"), engine);

  // 2. 身体数据：去掉 zod，校验改成查表。
  let bodies = read("shared/mascot-bodies.ts");
  bodies = replaceOnce(bodies, 'import { z } from "zod";\n', "", "mascot-bodies.ts");
  bodies = replaceOnce(bodies, "export const mascotBodySchema = z.enum(MASCOT_BODY_IDS);", "", "mascot-bodies.ts");
  bodies = replaceOnce(
    bodies,
    "return mascotBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;",
    "return (MASCOT_BODY_IDS as readonly string[]).includes(value as string) ? (value as MascotBodyId) : DEFAULT_MASCOT_BODY;",
    "mascot-bodies.ts",
  );
  writeFileSync(join(gen, "mascot-bodies.ts"), bodies);

  // 3. 表情几何原样复制。
  writeFileSync(join(gen, "cursor-face-data.ts"), read("src/components/cursor-face-data.ts"));

  // 4. 可固定的表情：上游头像编辑卡片用的那一组。
  const pickable = read("src/lib/mascot.ts").match(/export const PICKABLE_STATES: MausState\[\] = (\[[^\]]*\]);/);
  if (!pickable) fail("src/lib/mascot.ts 里找不到 PICKABLE_STATES");
  writeFileSync(join(gen, "pickable.ts"), `export const PICKABLE_STATES = ${pickable[1]} as const;\n`);

  cpSync(ELEMENT, join(work, "element.ts"));
  mkdirSync(OUT, { recursive: true });
  const banner = [
    "/*! omp-mascot：吉祥物头像自定义元素。",
    ` * 引擎、身体轮廓和表情数据来自 ${UPSTREAM_URL} (commit ${UPSTREAM_COMMIT})，Apache-2.0。`,
    " * Made with Blob Studio. 来源和许可见同目录的 NOTICE 与 LICENSE。由 scripts/build-mascot.mjs 生成，不要手改。 */",
  ].join("\n");
  await esbuild.build({
    entryPoints: [join(work, "element.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "none",
    banner: { js: banner },
    outfile: join(OUT, "omp-mascot.js"),
    logLevel: "warning",
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

copyFileSync(join(upstream, "LICENSE"), join(OUT, "LICENSE"));
const upstreamNotice = readFileSync(join(upstream, "NOTICE"), "utf8").split(/\n\s*\n/).slice(0, 2).join("\n\n").trim();
writeFileSync(join(OUT, "NOTICE"), `omp-mascot.js（吉祥物头像）

本目录的 omp-mascot.js 包含以下项目的代码，按 Apache License 2.0 使用，许可全文见同目录 LICENSE。

  来源：${UPSTREAM_URL}
  提交：${UPSTREAM_COMMIT}
  取用范围：src/components/CursorAvatar.tsx 的运行时引擎（去掉 React 组件）、
            src/components/cursor-face-data.ts 的表情几何、
            shared/mascot-bodies.ts 生成好的身体轮廓（去掉 zod 校验）、
            src/lib/mascot.ts 的可固定表情列表。
  改动：引擎包成原生自定义元素 <omp-mascot>，所有实例共用一个动画循环，
        滚出视口和暂停的实例不画，加了帧率上限。改动写在 scripts/mascot/element.ts。

Made with Blob Studio.

吉祥物形象是 Supamaus Software Private Limited 的商标。Apache-2.0 不授予商标权。

上游 NOTICE 中与本文件相关的部分：

${upstreamNotice}
`);
console.log(`已生成 ${join("web", "vendor", "mascot", "omp-mascot.js")}，上游 ${UPSTREAM_COMMIT.slice(0, 7)}`);

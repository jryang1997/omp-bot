// 从上游 notion-avatar 的预览素材生成 web/vendor/notion-avatar/parts.js，并写 NOTICE。
// 用法：NA_DIR=<上游检出目录> node scripts/build-notion-avatar.mjs
// 上游检出必须停在 UPSTREAM_COMMIT。换版本时先改这个常量，重新生成，再看一遍渲染截图。
// 取 public/avatar/preview/<部件>/<序号>.svg：每张都已经摆在 1080×1080 的同一块画布上，叠起来就是一张脸。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTION_PARTS } from "../src/domain.mjs";

export const UPSTREAM_URL = "https://github.com/Mayandev/notion-avatar";
export const UPSTREAM_COMMIT = "d59791d24db741e307d8c91ac9f38f92e033ad46";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web", "vendor", "notion-avatar");
const src = process.env.NA_DIR && join(process.env.NA_DIR, "public", "avatar", "preview");
if (!src || !existsSync(src)) {
  console.error("build-notion-avatar：设 NA_DIR 为上游检出目录");
  process.exit(1);
}

/**
 * 只留 <svg> 里面的图形，合成时套进同一个 1080 画布。上游是 Sketch 导出：去掉标题、注释、空白和 id，
 * 没被 url(#…) 引用的 id 去掉；被引用的（眼镜的遮罩）上游已经带了唯一后缀，留着。
 */
function inner(raw) {
  const body = raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const used = new Set([...body.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]));
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(title|desc)>[\s\S]*?<\/\1>/g, "")
    .replace(/\s+id="([^"]*)"/g, (all, id) => (used.has(id) ? all : ""))
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const parts = {};
for (const [part, count] of Object.entries(NOTION_PARTS)) {
  const files = readdirSync(join(src, part)).filter((f) => /^\d+\.svg$/.test(f));
  // 数量和服务端校验用的常量对不上就停：存下来的序号会指到不存在的图。
  if (files.length !== count) {
    console.error(`build-notion-avatar：${part} 有 ${files.length} 张，src/domain.mjs 写的是 ${count}`);
    process.exit(1);
  }
  parts[part] = [];
  for (let i = 0; i < count; i++) {
    const raw = readFileSync(join(src, part, `${i}.svg`), "utf8");
    parts[part].push(inner(raw));
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "parts.js"),
  `// 由 scripts/build-notion-avatar.mjs 生成，别手改。素材 CC0，来源见同目录 NOTICE。\n` +
  `export const PARTS = ${JSON.stringify(parts)};\n`);
writeFileSync(join(OUT, "NOTICE"), `parts.js（Notion 风格头像素材）

来源：${UPSTREAM_URL}
提交：${UPSTREAM_COMMIT}
取用范围：public/avatar/preview/ 下除 festival 以外的部件 SVG，去掉外层 <svg>、标题、注释、id 和空白。

插画：Felix Wong 的 Noto avatar 素材包（https://abstractlab.gumroad.com/l/noto-avatar），
按 CC0 1.0 公有领域贡献使用（https://creativecommons.org/publicdomain/zero/1.0/）。
这是仿 Notion 风格的插画，不是 Notion 官方素材，和 Notion Labs 无关。
`);
console.log(`写好 ${join(OUT, "parts.js")}`);

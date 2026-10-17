/*
 * 应用图标：五个 Notion 风格的人挤在一起合影，就是一支助手团队。圆章用的是应用里助手头像的底色，正中间是主助手蓝。
 * 深色底加一点颗粒和蓝色光晕，图标在浅色和深色桌面上都站得住。32px 及以下画不下五个人，只画中间那个。
 * 人物部件来自 web/vendor/notion-avatar（CC0，见那里的 NOTICE）。
 *
 * 生成：web/assets/app-icon.{svg,png,ico}、web/assets/app-mark.svg（小尺寸用），
 * 安卓启动图标的前景和背景 PNG、通知图标。
 * 跑法：node scripts/build-icons.mjs。栅格化要 sharp：没有就 npm i --no-save sharp，或者用 SHARP_FROM 指向装了它的目录。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PARTS } from "../web/vendor/notion-avatar/parts.js";

const root = new URL("..", import.meta.url).pathname;
const IDS = Object.keys(PARTS);

// 和 web/workbench-avatar.js 的 tintOf 一样：助手颜色往白色调 62%。
const mix = (hex, t = 0.62) => `#${[16, 8, 0].map((s) => {
  const v = (parseInt(hex.slice(1), 16) >> s) & 255;
  return Math.round(v + (255 - v) * t).toString(16).padStart(2, "0");
}).join("")}`;

// 合影站位：后排两个，前排两个，主助手在正中最前。[部件, 底色, 中心 x, 中心 y, 直径]，512 画布。
const CAST = [
  [{ face: 8, nose: 5, mouth: 3, eyes: 12, eyebrows: 0, hair: 20, details: 7 }, "#D8A729", 172, 186, 150],
  [{ face: 10, nose: 7, mouth: 10, eyes: 9, eyebrows: 15, hair: 41 }, "#009957", 340, 186, 150],
  [{ face: 3, nose: 10, mouth: 17, eyes: 5, eyebrows: 3, hair: 52 }, "#D84F8B", 128, 316, 156],
  [{ face: 11, nose: 12, mouth: 0, eyes: 1, eyebrows: 1, hair: 5, beard: 4 }, "#377FE6", 384, 316, 156],
  [{ face: 10, nose: 1, mouth: 9, eyes: 7, eyebrows: 12, glasses: 7, hair: 11 }, "#4D6BFE", 256, 308, 190],
];
const TILE = "M132 16H380C456 16 496 56 496 132V380C496 456 456 496 380 496H132C56 496 16 456 16 380V132C16 56 56 16 132 16Z";

/** 一张脸的图层，id 加前缀，同一张图里几张脸不会互相串。 */
function face(parts, prefix) {
  return IDS.map((id) => {
    const svg = (PARTS[id][parts[id] ?? 0] ?? "")
      .replace(/id="([^"]+)"/g, `id="${prefix}$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
      .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
    return id === "face" ? `<g fill="#fff">${svg}</g>` : svg;
  }).join("");
}

/** 圆章：白边、投影、助手底色，里面是放大一点、往下挪一点的脸，看起来像从章里探出来。 */
function coin([parts, color, cx, cy, d], k) {
  const r = d / 2;
  const s = (d * 1.25) / 1080;
  const fy = cy + d * 0.08;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" filter="url(#omp-shadow)"/>
  <circle cx="${cx}" cy="${cy}" r="${r - 6}" fill="${mix(color)}"/>
  <clipPath id="omp-coin-${k}"><circle cx="${cx}" cy="${cy}" r="${r - 6}"/></clipPath>
  <g clip-path="url(#omp-coin-${k})"><g transform="translate(${cx - 540 * s} ${fy - 540 * s}) scale(${s})">${face(parts, `f${k}-`)}</g></g>`;
}

const DEFS = `<linearGradient id="omp-bg" x1="0" y1="0" x2="0.35" y2="1"><stop stop-color="#3A3E46"/><stop offset=".5" stop-color="#191B20"/><stop offset="1" stop-color="#07080A"/></linearGradient>
  <radialGradient id="omp-glow" cx="0.5" cy="0.5" r="0.5"><stop stop-color="#5B76FF" stop-opacity=".9"/><stop offset=".6" stop-color="#4D6BFE" stop-opacity=".18"/><stop offset="1" stop-color="#4D6BFE" stop-opacity="0"/></radialGradient>
  <linearGradient id="omp-sheen" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="omp-edge" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".35"/><stop offset=".45" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#fff" stop-opacity=".12"/></linearGradient>
  <filter id="omp-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.07 0"/></filter>
  <filter id="omp-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="10" flood-color="#000" flood-opacity="0.5"/></filter>`;
const stage = `<path d="${TILE}" fill="url(#omp-bg)"/><rect width="512" height="512" filter="url(#omp-grain)"/><ellipse cx="256" cy="300" rx="230" ry="190" fill="url(#omp-glow)"/>`;
const sheen = `<path d="M16 132C16 56 56 16 132 16H380C456 16 496 56 496 132V170C400 205 112 205 16 170Z" fill="url(#omp-sheen)"/>`;
const icon = (body, title) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${title}">
<!-- 由 scripts/build-icons.mjs 生成，不要手改。人物插画来自 Noto avatar（CC0）。 -->
<defs>${DEFS}<clipPath id="omp-tile"><path d="${TILE}"/></clipPath></defs>
<g clip-path="url(#omp-tile)">${stage}${body}${sheen}</g>
<path d="${TILE}" fill="none" stroke="url(#omp-edge)" stroke-width="3"/>
</svg>
`;
const team = icon(CAST.map(coin).join(""), "omp-bot");
const mark = icon(coin([CAST[4][0], CAST[4][1], 256, 256, 330], 0), "omp-bot");
writeFileSync(`${root}web/assets/app-icon.svg`, team);
writeFileSync(`${root}web/assets/app-mark.svg`, mark);

// ---- 安卓 ----
// 启动图标分两层：背景是深色舞台，前景是人。108dp 的层，系统只露中间 72dp，人放进中间 66dp 的安全圈。
const res = `${root}android/app/src/main/res/`;
const A = 432; // 108dp 按 xxxhdpi
const layer = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${A}" height="${A}" viewBox="0 0 512 512"><defs>${DEFS}</defs>${body}</svg>`;
const bgLayer = layer(`<rect width="512" height="512" fill="url(#omp-bg)"/><rect width="512" height="512" filter="url(#omp-grain)"/><ellipse cx="256" cy="280" rx="200" ry="170" fill="url(#omp-glow)"/>`);
// 合影在 512 画布上占 x 53–459、y 111–403，缩到 240 宽放在正中。
const fs = 240 / 406;
const fgLayer = layer(`<g transform="translate(${256 - 256 * fs} ${256 - 257 * fs}) scale(${fs})">${CAST.map(coin).join("")}</g>`);
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/build-icons.mjs 生成，不要手改。 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;
writeFileSync(`${res}mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
writeFileSync(`${res}mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
rmSync(`${res}drawable/ic_launcher_foreground.xml`, { force: true });
// 通知图标只能是单色剪影：三个圆，中间大的是主助手，两边留缝。
writeFileSync(`${res}drawable/ic_notification.xml`, `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/build-icons.mjs 生成，不要手改。 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
${[[12, 13.4, 5.2], [4, 10.6, 3.3], [20, 10.6, 3.3]].map(([x, y, r]) => `    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M${+(x - r).toFixed(2)},${y} a${r},${r} 0 1 0 ${2 * r},0 a${r},${r} 0 1 0 ${-2 * r},0 Z" />`).join("\n")}
</vector>
`);

// ---- 栅格化 ----
let sharp;
try {
  sharp = process.env.SHARP_FROM ? createRequire(`${process.env.SHARP_FROM}/`)("sharp") : (await import("sharp")).default;
} catch {
  console.error("缺少 sharp，PNG 和 ICO 没有更新。先运行 npm i --no-save sharp，或者用 SHARP_FROM 指向装了它的目录");
  process.exit(1);
}
const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * 4 * Math.max(1, size / 512) }).resize(size, size).png().toBuffer();
writeFileSync(`${root}web/assets/app-icon.png`, await png(team, 512));
mkdirSync(`${res}drawable-nodpi`, { recursive: true });
writeFileSync(`${res}drawable-nodpi/ic_launcher_background.png`, await png(bgLayer, A));
writeFileSync(`${res}drawable-nodpi/ic_launcher_foreground.png`, await png(fgLayer, A));
// ICO 里直接放 PNG（Vista 以后都认）。任务栏和托盘用 16–32，放单人版。
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => png(size <= 32 ? mark : team, size)));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  head.writeUInt8(size % 256, at);
  head.writeUInt8(size % 256, at + 1);
  head.writeUInt16LE(1, at + 4);
  head.writeUInt16LE(32, at + 6);
  head.writeUInt32LE(images[i].length, at + 8);
  head.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
writeFileSync(`${root}web/assets/app-icon.ico`, Buffer.concat([head, ...images]));
console.log("图标已生成");

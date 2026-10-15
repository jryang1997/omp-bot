// build.mjs：从 OpenMausBot 源码取运行时引擎和生成好的身体数据，打成一个不依赖 React 的 ES 模块。
// 运行：OMS_DIR=/data/oms node build.mjs。不拿 scripts/mascot-shapes 下的生成脚本。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/vercel/sandbox/node_modules/');
const esbuild = require('esbuild');
const OMS = process.env.OMS_DIR ?? '/data/oms';
const HERE = new URL('.', import.meta.url).pathname;
const gen = `${HERE}src/upstream/`;
mkdirSync(gen, { recursive: true });

// 1. 引擎：CursorAvatar.tsx 里 React 组件之前的部分都是纯 DOM 代码。
const avatar = readFileSync(`${OMS}/src/components/CursorAvatar.tsx`, 'utf8').split('\n');
const cut = avatar.findIndex(line => line.startsWith('export interface CursorAvatarProps'));
const tail = avatar.findIndex(line => line.startsWith('function displayed('));
let engine = [...avatar.slice(0, cut), ...avatar.slice(tail)].join('\n')
  .replace("import React, { useEffect, useId, useMemo, useRef } from 'react'\n", '')
  .replace('"../../shared/mascot-bodies"', '"./mascot-bodies"')
  .replace('export default CursorAvatar', '');
engine += '\nexport { displayed, displayedMouth, displayedGaze, blinkScale, clone, toPath, ringCentre, clamp, VIEW_BOX, SPHERE_C, SPHERE_R, EXPR_CADENCE, BLINK }\n';
writeFileSync(`${gen}engine.ts`, engine);

// 2. 身体数据：去掉 zod，校验改成查表。
const bodies = readFileSync(`${OMS}/shared/mascot-bodies.ts`, 'utf8')
  .replace('import { z } from "zod";\n', '')
  .replace('export const mascotBodySchema = z.enum(MASCOT_BODY_IDS);', '')
  .replace('return mascotBodySchema.safeParse(value).data ?? DEFAULT_MASCOT_BODY;',
    'return (MASCOT_BODY_IDS as readonly string[]).includes(value as string) ? (value as MascotBodyId) : DEFAULT_MASCOT_BODY;');
writeFileSync(`${gen}mascot-bodies.ts`, bodies);

// 3. 表情几何原样复制。
writeFileSync(`${gen}cursor-face-data.ts`, readFileSync(`${OMS}/src/components/cursor-face-data.ts`, 'utf8'));

const banner = `/*! omp-mascot. Adapted from OpenMausBot (https://github.com/milind-soni/OpenMausBot), Apache-2.0.
 * Mascot runtime and generated body outlines. Made with Blob Studio. See NOTICE. */`;
for (const [out, minify] of [['omp-mascot.js', false], ['omp-mascot.min.js', true]]) {
  await esbuild.build({ entryPoints: [`${HERE}src/element.ts`], bundle: true, format: 'esm', target: 'es2022', minify, legalComments: 'none', banner: { js: banner }, outfile: `${HERE}${out}` });
}
console.log('built');

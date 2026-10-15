# 13 吉祥物原生 DOM 移植

Type: prototype
Label: wayfinder:prototype
Status: resolved
Blocked by: 12

## Question

把 CursorAvatar 改写成原生自定义元素后，效果和性能是否与上游一致。

## Plan

- 先查清 Blob Studio 的许可。查不清就停下，问用户是否接受，或者向上游提问。
- 在 `.scratch/team-architecture/mascot-proto/` 移植引擎和 10 种身体，做一个静态页。并排放侧边栏 36px、详情页 80px、群头像拼合三种尺寸。
- 对照上游截图 `docs/screenshots/agent-roster-avatar-only.png`。
- 量 JS 体积，量 20 个头像同时动时的 CPU，检查减少动态效果。

## Done when

截图对比、体积和 CPU 数字写进 Answer。

## Answer

原生移植可行，画出来和上游逐像素相同，CPU 与上游持平，看不见和暂停时几乎不花 CPU。产品上照上游的规矩，只有工作中、有未读或刚发生事件的头像才动。新发现一条商标限制，见最后一节。

### 做法

原型在 `mascot-proto/`，`node build.mjs` 从 OpenMausBot 源码重新生成。

- `CursorAvatar.tsx` 里 React 组件之前的部分本来就是纯 DOM 代码，原样取出。`cursor-face-data.ts` 原样复制。`mascot-bodies.ts` 只去掉 zod。生成脚本 `scripts/mascot-shapes/` 不拿。
- 新写一个 `<omp-mascot>` 自定义元素代替 React 组件，用 shadow DOM 装 SVG。属性有 body、color、state、expression、size、paused、label、fps。
- 所有实例共用一个 requestAnimationFrame。滚出视口的实例不画。`fps` 属性给小尺寸降帧。
- 颜色沿用上游 10 色。Main Bot 用 star 身体和现在 Main Bot 的蓝色 `#4D6BFE`，这个颜色不在 10 色里，别的 bot 选不到。

### 效果

- 10 种身体、同一表情、静止、80px，上游 React 版和原生版并排截图，每个 80×80 格子里差异超过 24/255 的像素都是 0。见 `bench/compare.png`。
- `demo.png` 放了侧边栏 36px、运行状态 44px、详情 80px、表情选择、颜色和 2 到 4 人的群头像。36px 时表情清楚。群头像里最小的约 18px，眼睛还看得见，嘴已经很小。
- 对照上游截图 `docs/screenshots/agent-roster-avatar-only.png`，形状、渐变和脸的位置一致。

### 体积

| 文件 | 压缩后 | gzip |
| --- | --- | --- |
| 原生 `omp-mascot.min.js` | 67 KB | 26 KB |
| 上游 React 版，含 React | 291 KB | 95 KB |
| 现在的 `characters.js` | 29 KB | 11.7 KB |

比现在多约 14 KB gzip，大头是 25 种表情的几何数据和 10 种身体的轮廓。

### CPU

20 个 36px 头像同时动，每组 12 秒。Chrome 153 无头模式，关 GPU，2 vCPU 沙盒。数据在 `bench/result.json` 和 `bench/result-extra.json`，`bench/run.mjs` 可以重跑。

| 情况 | 上游 React 主线程 / 浏览器 | 原生 主线程 / 浏览器 |
| --- | --- | --- |
| 全部 idle | 23.8% / 42.0% | 22.1% / 40.8% |
| 全部 working | 24.2% / 43.8% | 25.8% / 45.8% |
| 减少动态效果 | 23.3% / 41.5% | 18.5% / 32.5% |
| 全部在视口外 | 22.0% / 23.4% | 1.5% / 4.5% |
| 原生降到 30 帧 | | 14.2% / 25.1% |
| 原生全部暂停 | | 1.4% / 4.0% |

浏览器一列是全部浏览器进程占一个核的百分比，关了 GPU，所以绘制都算在 CPU 上。

- 20 个一直动大约占半个核，主要花在 SVG 重绘，换框架省不下来。
- 上游的侧边栏只在 bot 工作中、有未读或刚发生事件时让头像动，其余静止（`Sidebar.tsx` 的 `animated` 条件）。照搬这条规矩，平时只有一两个在动。
- 48px 以下降到 30 帧，开销再少约四成，肉眼看不出差别。
- 系统设了减少动态效果时，身体不动，表情照常换。

### 许可和商标

- 代码是 Apache-2.0，`enterprise/` 以外都适用。保留 LICENSE、NOTICE 和 "Made with Blob Studio"。
- 新发现。上游 `LICENSING.md` 写明 OpenMausBot、MausBot 的名字和吉祥物是 Supamaus Software Private Limited 的商标，Apache-2.0 第 6 条不授予商标权。代码可以用，吉祥物形象本身能不能放进 omp-bot 要上游点头。
- 处理办法。产品里不出现 OpenMausBot 和 MausBot 的名字，吉祥物只当 bot 头像，不当 omp-bot 的图标或标志。给上游的 issue 草稿加了这一问，见 `mascot-proto/upstream-issue-draft.md`。
- 上游回复之前可以在本地实现和自用，发布版本前要等回复。上游不同意时保留引擎，把身体和脸换成自己画的，表情引擎不受影响。
- cursor 身体就是上游的应用标志。已有 bot 默认用 cursor 是 14 号定的，实施时把默认身体做成一个常量，上游不同意时改一处即可。

## Comments

- 2026-10-15 查了 Blob Studio。GitHub 上搜不到公开仓库，上游文档只提到它的内部路径 `studio/src/...`。照原样复制的 Blob Studio 代码只在生成脚本里（`scripts/mascot-shapes/sdf.ts`、`solve.ts`）。运行时的 `CursorAvatar.tsx` 只有一行 "Made with Blob Studio" 署名，10 种身体的轮廓由改编自 Blob Studio 的构造器生成。
- 建议只移植运行时引擎和生成好的身体数据，不拿生成脚本。保留 LICENSE、NOTICE 和署名，同时向上游开 issue 确认。上游说不行就把 10 种身体换成自己画的。开 issue 要用用户的 GitHub 账号，已发给用户等确认。
- 2026-10-15 用户选 B。只移植运行时引擎和生成好的身体数据，保留 LICENSE、NOTICE 和署名，向上游开 issue 的草稿由我写好交给用户发。

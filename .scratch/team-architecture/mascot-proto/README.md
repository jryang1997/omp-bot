# omp-mascot 原型

13 号票的原型。`src/upstream/` 和打包出来的 `omp-mascot*.js` 含 OpenMausBot（https://github.com/milind-soni/OpenMausBot ，commit 330b098）的代码，按 Apache-2.0 使用，许可全文见 `LICENSE.OpenMausBot`。吉祥物形象是 Supamaus Software Private Limited 的商标，见 13 号票最后一节。Made with Blob Studio.

- `node build.mjs` 重新生成引擎和打包文件，`OMS_DIR` 指向 OpenMausBot 源码。
- `node shot.mjs` 截 `demo.png`。
- `node bench/build-react.mjs && node bench/compare.mjs` 生成上游对照图，`node bench/run.mjs` 量 CPU。

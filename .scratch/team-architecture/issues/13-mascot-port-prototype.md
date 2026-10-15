# 13 吉祥物原生 DOM 移植

Type: prototype
Label: wayfinder:prototype
Status: open
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

## Comments
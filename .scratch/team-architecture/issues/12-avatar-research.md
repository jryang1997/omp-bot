# 12 OpenMausBot 头像的许可、功能与移植成本

Type: research
Label: wayfinder:research
Status: resolved
Blocked by:

## Question

OpenMausBot 的头像体系能不能拿来用，有哪些功能，移植进我们的前端要多大代价。

## Answer

调研基于 milind-soni/OpenMausBot `330b098`（2026-10-15）和 Fei2411/DeepSeek-Bot `9411ac3`（2026-10-15）。

### 许可

- OpenMausBot 在 `enterprise/` 之外是 Apache-2.0。头像代码都在外面，包括 `src/components/CursorAvatar.tsx`、`src/components/Avatar.tsx`、`src/components/cursor-face-data.ts`、`src/lib/mascot.ts`、`shared/mascot-bodies.ts`、`shared/bot-avatar.ts`。
- 复制时保留 LICENSE 和 NOTICE，改过的文件写修改声明。做法与现在的 DS Bot 移植一致。
- 待核实一点。`CursorAvatar.tsx` 文件头写着 "Made with Blob Studio"，身体生成脚本的计划文档说部分数学从 Blob Studio 原样复制。NOTICE 没有列 Blob Studio。移植前要查清 Blob Studio 的许可，或者向上游问一句。

### 功能

- 会动的吉祥物，45 种状态，分生命周期、表情反应、agent 形态、产品动作四组。会眨眼、旋转、视线跟随指针，遵守"减少动态效果"。
- 10 种身体，cursor、blob、circle、squircle、capsule、drop、shield、hexagon、diamond、star。所有身体共用同一张脸，看起来是同一个角色。
- 10 种颜色，每种生成三段渐变。
- 可选上传图片，圆形、圆角、方形三种裁切，带缩放和焦点。图片只允许本机附件地址，挡掉外链追踪和带脚本的 SVG。
- 可选 AI 生成头像。需要 OpenAI、xAI 或兼容 Images API 的 key，与聊天模型的登录无关。
- 状态按 bot 实时推断。忙时 working，工具失败 alerting，有未读 notifying，其余按名字和描述的关键词选默认表情。

### 与现状对比

现在的 DS Bot 角色是静态分层 SVG，按 id 确定性分配形状和颜色，只有 idle/working 两态。`lookOf` 会读 `bot.avatar`，但后端没有这个字段，UI 也没有选择或上传入口。

### 移植成本

- 我们的前端是无构建的原生 DOM ES 模块，OpenMausBot 是 React 加 TypeScript。
- `CursorAvatar.tsx` 共 1441 行，前约 1070 行是纯计算和绘制引擎。React 只出现在最后约 370 行的组件外壳里，用到 refs、effects 和 requestAnimationFrame。
- 外壳可以改写成一个原生自定义元素，引擎转成 JS。`mascot-bodies.ts` 只用 zod 做校验，可以去掉。
- 要一起改的地方。群头像 `roomAvatar` 依赖 `botMark`；Main Bot 现在固定是鲸鱼；后端要新增头像字段并持久化；README 和 `web/vendor/README.md` 的来源说明要更新。

## Comments
- 2026-10-15 13 号补充。上游 `LICENSING.md` 写明名字和吉祥物是 Supamaus Software Private Limited 的商标，Apache-2.0 不授予商标权。处理办法和发布前的条件见 13。

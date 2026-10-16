# 前端来源与许可

本目录保存界面移植使用的上游代码。所有模块随应用静态分发，页面不从 CDN 加载脚本，也不需要安装 React 或 DSH。

| 来源 | 固定版本 | 本地许可 |
| --- | --- | --- |
| [DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot) | `bdc5fda64e2ea1e83a4d146440072a2413025df4` | [Apache-2.0](ds-bot/LICENSE)，[原始 NOTICE](ds-bot/NOTICE) |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | `330b098b7b59a9f066ae6cd013fb3b21ecf78956` | [Apache-2.0](mascot/LICENSE)，[NOTICE](mascot/NOTICE) |
| [marked](https://github.com/markedjs/marked) | `18.1.0` | [原始 MIT 许可及附带声明](marked/LICENSE) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | `3.4.16` | [Apache-2.0](dompurify/LICENSE)，采用其双许可中的 Apache-2.0 选项 |

## DeepSeek-Bot 复制范围

- `ds-bot/inks.js` 原样复制上游 `ds-bot/src/client/inks.js`。
- `ds-bot/ui.css` 来自上游 `ds-bot/src/client/styles.js` 的完整 `SHELL_CSS` 和 `CONVERSATION_CSS`。模板中的颜色、遮罩和缓动值已求值，原始 CSS 规则保留。文件末尾把上游表单、按钮和资料样式映射到本项目的类名。
- `../index.html` 与 `../app.js` 把 `sidebar.js` 的 BotRow、RoomRow，`mark.js` 的群头像座位布局，以及 `cells.js` 的消息结构改为原生 DOM，并绑定 omp-bot 的 HTTP API 和 SSE。座位里放的是下面的吉祥物或上传的图片。
- `../style.css` 负责面向普通用户的产品布局、配色、字体、控件和反馈，以及深色主题、窄屏侧栏、全屏设置、减少动态效果和透明度等适配。

`ui.css` 的生成只执行样式模板和 `motion.js` 的纯缓动声明，不导入 React。更新时使用上表固定提交的样式源码、`text.js` 的 `MENTION_ORIGIN` 和 `motion.js` 的 `springEasing`、`SPRING_*`、`spring` 声明。不要改上游打包产物 `ds-bot/client.js`。

本项目仍叫 omp-bot。没有复制 DSH 的 FishLogo、宿主服务、插件加载器或未接入后端的控件。复制并修改的文件带有来源、提交号或修改声明，原始许可与 NOTICE 保留在本目录。

## 吉祥物头像

`mascot/omp-mascot.js` 由 `scripts/build-mascot.mjs` 从 OpenMausBot 固定提交生成，不要手改。脚本取 `src/components/CursorAvatar.tsx` 里 React 组件之外的运行时引擎、`src/components/cursor-face-data.ts` 的表情几何、`shared/mascot-bodies.ts` 生成好的身体轮廓和 `src/lib/mascot.ts` 的可固定表情列表，和 `../../scripts/mascot/element.ts` 一起用 esbuild 打成一个原生自定义元素 `<omp-mascot>`，不依赖 React。脚本同时写 `mascot/NOTICE`，复制上游 `LICENSE`。

```
OMS_DIR=<上游检出目录> npm run build:mascot
```

上游检出必须停在脚本里的 `UPSTREAM_COMMIT`，不一致就停下。换版本时改这个常量，重新生成，跑 `node test/team.mjs` 对照取值，再看一遍头像截图。

吉祥物形象是 Supamaus Software Private Limited 的商标，Apache-2.0 不授予商标权。界面里不出现上游的产品名，吉祥物也不当 omp-bot 的图标。

## Markdown 适配

上游消息使用 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`。本项目用 `marked/marked.esm.js` 解析 Markdown，并通过 `dompurify/purify.es.js` 清理后插入 DOM。

这两个文件分别原样来自 npm 包 `marked@18.1.0` 的 `lib/marked.esm.js` 和 `dompurify@3.4.16` 的 `dist/purify.es.mjs`。DOMPurify 文件仅把扩展名改成 `.js`，适配现有静态服务的 JavaScript MIME 类型。代码内容和原始许可声明未修改。

消息中的脚本、事件处理属性、危险链接、表单控件和影响宿主界面的样式或标识属性会被清理。外部链接使用 `noopener noreferrer`。头像的 SVG 在 `<omp-mascot>` 的 shadow DOM 里生成，数据只来自随应用分发的 `mascot/omp-mascot.js`。上传的头像图片只能是本应用附件接口的预览地址。

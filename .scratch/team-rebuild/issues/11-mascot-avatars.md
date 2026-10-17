# 11: 吉祥物头像

**What to build:** 用原生自定义元素的吉祥物替换 DS Bot 角色。bot 可以选 10 种身体、10 种颜色、固定表情或随状态变化，也可以上传图片并裁切缩放。Main Bot 固定 star 和专用蓝色。侧边栏只有工作中、有未读或刚发生事件的头像才动。群头像用吉祥物拼。

**Blocked by:** None - can start immediately

**Status:** done

- [x] 打包脚本从上游生成自定义元素文件，记录 commit，NOTICE 和上游 LICENSE 随附
- [x] 花名册有头像字段，已有 bot 自动得到按 id 分配的颜色和 cursor 身体
- [x] 接口拒绝改 Main Bot 形象、拒绝其他 bot 用 Main Bot 颜色、拒绝非附件地址的图片
- [x] 运行状态到表情的映射生效
- [x] 头像编辑界面有身体、颜色、表情、上传、裁切和缩放
- [x] 群头像、侧边栏、详情页截图正常
- [x] DS Bot 角色文件和相关引用删除，README 上游链接改成 Fei2411

落地记录：

- 打包：`scripts/build-mascot.mjs`（`npm run build:mascot`）要求 `OMS_DIR` 停在 `UPSTREAM_COMMIT` 330b098，每处改写必须命中。临时目录里生成引擎、身体轮廓、表情几何和可固定表情表，和 `scripts/mascot/element.ts` 用 esbuild 打成 `web/vendor/mascot/omp-mascot.js`（约 68KB，两次生成哈希一致），同时写 `NOTICE`（来源、commit、取用范围、改动、商标说明）、复制上游 `LICENSE`。esbuild 0.25.0 精确版本进开发依赖。
- 数据：`src/domain.mjs` 加头像常量、`mascotColorFor`（FNV-1a 按 id 选色）、`defaultAvatar`、宽松的 `normalizeAvatar`（读花名册时补默认值，旧 bot 得到 cursor 身体和按 id 的颜色）、严格的 `validateAvatarPatch`。编排器 `_checkAvatar` 对新图片查附件存在、属于本 bot、格式四种之一。改头像是部分合并，不重启 runtime。
- 接口拒绝：`avatar_main_fixed`、`avatar_color_reserved`、`avatar_url_invalid`，其余不合法字段 `avatar_invalid`。
- 状态映射：`web/workbench-runs.js` 的 `avatarState` 给出 face、busy、moving。等待输入或审批是 alerting，有工具在跑是 working，其余运行中是 thinking，最近一次失败、中断或需要核对是 sad，完成 3 秒内是 happy。重连 hello 帧之前的重放事件不算刚发生。
- 界面：新 `web/workbench-avatar.js` 管头像节点和编辑器。小于 48px 的头像 30fps，图片加载失败退回吉祥物。侧边栏只有运行中、有未读或 4 秒内刚发生事件的才动，新增未读圆点和 aria 提示。群头像用成员吉祥物拼，开会或未读时一起动。详情页"形象"折叠区有身体、颜色、表情、上传、裁切、缩放和焦点拖动，主助手只显示一句说明。
- 清理：删 `web/vendor/ds-bot/characters.js` 和 app.js 里的引用，smoke-gui 静态清单换成新文件。README 和 ui.css、app.js 注释里的上游链接改成 Fei2411，ds-bot/NOTICE 原文不动。README 致谢和 `web/vendor/README.md` 加 OpenMausBot 与商标说明。
- 证据：`proof/avatar/shot-avatar.mjs` 34 项全过，截图有各状态、编辑器、图片裁切、详情页、主助手、群头像和深色模式，`avatar-report.json` 记录每项结果。
- 测试：team.mjs 加 3 项 11 测试（30/30），http-boundaries.mjs 加 5 项头像检查（91/91），workbench-runs.mjs 加头像状态块（7/7），13 个测试文件全过，smoke-gui 56/56。
- 发布前要等上游对商标的回复，issue 草稿在 `.scratch/team-architecture/mascot-proto/upstream-issue-draft.md`。

- 后来：吉祥物换成 Notion 风格捏脸，这里的截图和脚本删了，新证据见 `proof/notion-avatar/`（决定 12）。

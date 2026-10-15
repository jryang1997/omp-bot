# 11: 吉祥物头像

**What to build:** 用原生自定义元素的吉祥物替换 DS Bot 角色。bot 可以选 10 种身体、10 种颜色、固定表情或随状态变化，也可以上传图片并裁切缩放。Main Bot 固定 star 和专用蓝色。侧边栏只有工作中、有未读或刚发生事件的头像才动。群头像用吉祥物拼。

**Blocked by:** None - can start immediately

**Status:** ready-for-agent

- [ ] 打包脚本从上游生成自定义元素文件，记录 commit，NOTICE 和上游 LICENSE 随附
- [ ] 花名册有头像字段，已有 bot 自动得到按 id 分配的颜色和 cursor 身体
- [ ] 接口拒绝改 Main Bot 形象、拒绝其他 bot 用 Main Bot 颜色、拒绝非附件地址的图片
- [ ] 运行状态到表情的映射生效
- [ ] 头像编辑界面有身体、颜色、表情、上传、裁切和缩放
- [ ] 群头像、侧边栏、详情页截图正常
- [ ] DS Bot 角色文件和相关引用删除，README 上游链接改成 Fei2411

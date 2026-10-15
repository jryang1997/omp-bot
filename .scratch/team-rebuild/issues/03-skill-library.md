# 03: 共享技能库加每 bot 白名单

**What to build:** 技能可以装进 `team/skills` 共享库，也可以只装给一个 bot。bot 启动时看到的是白名单里的库技能加上自己的私有技能。界面能给每个 bot 勾选库里的技能。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] overlay 的 `skills.customDirectories` 指向 team 的技能库
- [ ] 白名单为 null 时不传 `--skills`，为列表时传列表加私有技能，合并为空时传 `--no-skills`
- [ ] 安装时可以选共享库或私有，重名被拒绝并给出原因
- [ ] 技能面板列出库技能和私有技能，勾选改动写回 `bot.skills`

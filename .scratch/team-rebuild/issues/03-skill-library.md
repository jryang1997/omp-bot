# 03: 共享技能库加每 bot 白名单

**What to build:** 技能可以装进 `team/skills` 共享库，也可以只装给一个 bot。bot 启动时看到的是白名单里的库技能加上自己的私有技能。界面能给每个 bot 勾选库里的技能。

**Blocked by:** 01

**Status:** done

- [x] overlay 的 `skills.customDirectories` 指向 team 的技能库
- [x] 白名单为 null 时不传 `--skills`，为列表时传列表加私有技能，合并为空时传 `--no-skills`
- [x] 安装时可以选共享库或私有，重名被拒绝并给出原因
- [x] 技能面板列出库技能和私有技能，勾选改动写回 `bot.skills`

落地记录：
- overlay 的 `skills:` 段加 `customDirectories`，值是 team/skills 的绝对路径，用 JSON 串写成 YAML 双引号串，Windows 路径不出错。
- `skillArgs`：白名单 null 不传；列表时并上私有技能传 `--skills`，并完为空传 `--no-skills`。行为变化：以前白名单也管私有技能，现在私有技能总是加载。以前取消勾选的私有技能升级后会重新加载。
- 复用签名的上下文摘要加进两处技能目录的清单（名字、SKILL.md 的修改时间和大小），装了技能下一轮就重建进程，不用手动重启。
- 装技能：`POST /api/bots/<id>/skills/install`，body `{target: "library"|"bot", path | content}`。只给本机主人用，手机等设备不能调。来源可以是本机技能目录（整个复制，跳过符号链接、.git、node_modules，最多 500 个文件或 20MB），也可以直接贴 SKILL.md。名字取 frontmatter 的 name，没写用目录名。
- 拒绝时给出原因：重名（不分大小写，说清在共享库还是哪个 bot 的私有技能里）、没写 description（共享库里没写 omp 不加载）、名字带逗号或匹配符号或 Windows 不能用的字符、来源不存在。
- 从某个 bot 的面板装进共享库、它又用白名单时，新技能顺手加进它的白名单。每次装技能提交一次 git。
- 技能面板分三块：共享库（"用库里全部"开关加逐个勾选，标出没写 description 的）、只给这个 bot 的技能、装技能表单。
- skip: CLI 装技能命令。票只要求界面和接口，CLI 用户可以直接把目录放进 team/skills。
- 证据：`test/team.mjs` 新增 4 个 03 测试，24/24；`test/features.mjs` 技能用例改成新语义；实机 omp 18.10.3 + 模拟模型 `proof/skills-e2e.json` 全 pass（null 看到整个库；白名单加私有；装新库技能下一轮出现；装的 bot 白名单自动加上）；13 个测试文件全过，smoke-gui 55/55；技能面板截图人工看过。


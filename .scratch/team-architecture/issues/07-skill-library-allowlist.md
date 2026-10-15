# 07 共享技能库加每 bot 白名单

Type: prototype
Label: wayfinder:prototype
Status: resolved
Blocked by:

## Question

omp 原生配置能否直接做到"库里装一次，每个 bot 只看到分给它的技能"。

## Plan

- 共享库放 `team/skills/<名>/SKILL.md`，放在 cwd 往上找的路径之外，避免被所有 bot 自动发现。每 bot 的 overlay 用 `skills.customDirectories` 指向它，再用 `includeSkills` 或现有的 `--skills` 过滤。
- 验证私有技能与库技能重名时谁生效。文档说显式配置的 custom 目录压过默认发现位置，这与"个人覆盖共享"相反。
- 验证空白名单。文档说空的 `includeSkills` 等于全部。`src/bot.mjs` 已经对空数组改用 `--no-skills`，overlay 写法也要同样处理。
- 量会话开头在 0、10、30 个技能时的 token 差，给用户一个真实数字。

## Done when

真实 omp 会话列出的技能与白名单一致，有 proof.json。Answer 里写清 UI 上"分配技能"落到哪个配置。

## Answer

可以，全用 omp 原生配置。库放 `team/skills/`，overlay 加 `skills.customDirectories` 指向它，白名单继续走现有的 `bot.skills` 和 `--skills`。不用把技能复制进每个 bot 的目录。

### 实测

omp 18.10.3，同 06 的模拟环境。库里放 30 个技能和一个同名技能，bot 自己的 `.omp/skills/` 放两个私有技能。脚本和结果见 `omp-lab/skills-lab.mjs`、`omp-lab/skills-proof.json`。每个技能正文里放一个标记，确认正文没有进系统提示词。

| 配置 | 会话里列出的技能 |
| --- | --- |
| 不配库 | 只有 2 个私有技能。`team/skills/` 不会被自动发现 |
| 配库，不过滤 | 库 31 个加私有 1 个，同名的取库里那份 |
| 配库，`includeSkills` 列 2 个库技能加 1 个私有 | 正好这 3 个 |
| 配库，`includeSkills` 只列 2 个库技能 | 只有这 2 个，私有技能也被滤掉 |
| 配库，`includeSkills: []` | 全部 32 个 |
| 配库，`--skills lib-0*,private-notes` | 9 个库技能加 1 个私有，通配符生效 |
| 配库，`--no-skills` | 0 个 |

- 白名单同时管库技能和私有技能。私有技能没列进去就看不到。
- 空的 `includeSkills` 等于不过滤。空白名单只能用 `--no-skills`，`src/bot.mjs` 现在的处理是对的。
- 同名时库里那份赢，和"个人覆盖共享"相反。
- 技能正文都不进系统提示词，按需加载。

### 体积

| 技能数 | 系统提示词字符数 |
| --- | --- |
| 0 | 10558 |
| 10 | 11769 |
| 30 | 13849 |

每个技能约 110 字符。30 个多出 3.3K 字符，大约 800 到 900 token。描述在系统提示词里被截到 100 字符左右，末尾加省略号。触发条件要写在描述最前面，后半句模型看不到。

### 落地要点

- "分配技能"落到 `bot.skills`，生成 `--skills <名单>`。overlay 只多一行 `customDirectories`，指向 `team/skills`。
- 面板保存名单时，把这个 bot 的私有技能自动并进去。否则用户一勾库技能，私有技能就消失了。
- 装技能时校验重名。私有技能不能和库里的同名，装进库的也不能和任何 bot 的私有技能同名。真要个人改版，就换个名字。
- 名单为空时继续用 `--no-skills`。
- 技能面板的描述编辑框提示前 100 字符可见。

## Comments
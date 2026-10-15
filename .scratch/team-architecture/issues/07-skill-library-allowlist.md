# 07 共享技能库加每 bot 白名单

Type: prototype
Label: wayfinder:prototype
Status: open
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

## Comments
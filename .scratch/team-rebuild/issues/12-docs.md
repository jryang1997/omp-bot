# 12: 文档跟上新架构

**What to build:** ADR 写明推翻"电脑模式下不能有本机工具"。术语表补新词。README 和 CHANGELOG 讲清新架构、迁移和实机验证步骤。

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11

**Status:** done

- [x] `docs/adr/` 下新增 ADR
- [x] GLOSSARY.md 有共享电脑、座席、团队目录、共识层、技能库
- [x] README 更新架构、team 目录和共享电脑说明
- [x] CHANGELOG 有本次改动、迁移行为和待实机验证项

落地记录：

- 69d8fe7 `docs/adr/0001-computer-tools-are-additive.md`：绑定电脑只加客机工具，推翻旧规格"电脑模式下不能有本机工具"，写明理由、代价和放弃的方案。GLOSSARY.md 加团队目录、共识层、身份块、技能库、共享电脑、座席、管理通道、登录屏、旧电脑。
- 20b14ca README 新增「团队目录」「共享电脑」两段，含 5 步实机验证；架构列出 team.mjs、persona.mjs、computer-seats.mjs；审批三档、测试列表、已知限制跟上。CHANGELOG 0.2.0 补总述、团队目录、升级迁移、技能库、审批和待实机验证。
- 758d48f 写文档时发现 `smoke-computers.mjs` 的隔离检查读的是 `${homeA}~/work/output-a.txt`（07 批量替换误改），这个路径本来就不存在，检查永远通过。改回 `${homeA}/work/output-a.txt`。
- 全量测试 15/15。

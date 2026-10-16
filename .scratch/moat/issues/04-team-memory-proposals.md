# 04: 可纠正的团队记忆（借 OpenMausBot、nanobot）

**What to build:** bot 可以提议一条团队事实（带来源），你或 Main Bot 接受后才写进共识层。替换旧事实时带版本，旧事实中途变了就拒绝。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 提议工具和待确认列表，接受、拒绝都有接口
- [ ] 接受时检查版本，冲突就拒绝并提示重提
- [ ] 接受后写进 team 目录并自动提交
- [ ] 面板能看、能点

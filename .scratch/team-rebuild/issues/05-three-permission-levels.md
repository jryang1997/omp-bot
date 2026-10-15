# 05: 审批收成 3 档

**What to build:** 界面和接口只提供只聊天、本机改东西先问我、全部放手三档。内部仍存执行档和审批档，任何旧组合在读花名册和接收接口参数时归一。

**Blocked by:** None - can start immediately

**Status:** done

- [x] 9 种旧组合按规则归一，表驱动测试覆盖
- [x] 新建和修改 bot 的接口接受三档，也接受旧字段并归一
- [x] 界面上原来的两个下拉框换成一个三选一，文案说明共享电脑在后两档都不问，装系统包除外
- [x] 委派时的档位上限规则照常工作

落地记录：三档在 src/constants.mjs PERMISSION_LEVELS，归一在 src/domain.mjs permissionOf/permissionModes，接口解析在 orchestrator resolvePermission（新码 confirm_permission_required、permission_invalid）。旧组合 always-ask 归到先问我后少问一些（write）。委派上限沿用执行档序，三档一一对应，test/runs.mjs 扩权用例照常通过。

# 01: 只读命令不再弹审批

**What to build:** 在 `write` 审批模式下，明确只读的 bash 命令（ls、cat、rg、git status 等）直接放行；危险命令仍按 OMP 关键规则拦。用 OMP 原生 `bash.patterns`，由 persona 写进配置覆盖层。

**Blocked by:** 无

**Status:** todo

- [ ] persona 覆盖层生成只读白名单
- [ ] always-ask 模式不受影响（主人要求每次都问）
- [ ] 测试覆盖生成的配置

## Comments

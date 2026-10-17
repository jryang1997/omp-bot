# 01: 只读命令不再弹审批

**What to build:** 在「要我同意」档（supervised + write），明确只读的 bash 命令（ls、cat、grep、wc 等）直接放行；危险命令仍按 OMP 关键规则拦。用 OMP 原生 `bash.patterns`，由 persona 写进配置覆盖层。

**Blocked by:** 无

**Status:** done

- [x] persona 覆盖层生成只读白名单（`READ_ONLY_BASH_PATTERNS`，21 条）
- [x] 全部放手、聊天、always-ask 都不写规则
- [x] 测试覆盖生成的配置和 OMP 匹配语义

## Comments

- 实现：`src/persona.mjs` 在 supervised+write 时写 `bash.allowCompoundCommands: true` 和 `bash.patterns`（allow）。规则在 OMP 内按真实参数判，宿主不加分类器，零 token。
- 依据：OMP `src/tools/bash.ts`（main@eb74cf84）。allow 只认整条简单命令；带 `; | & < > $ \` ( )`、换行或 `-c/-e` 重解释参数的命令不算命中；关键危险模式仍强制弹卡。
- 测试 `test/approval-tiers.mjs` 5/5。照抄 OMP 匹配函数，证明 13 条只读命令放行、20 条危险或越界命令不放行。去掉档位判断的变异被抓到（4/5）。PyYAML 解析生成的 overlay 通过。回归 unit 11/11、runs 45/45、delegation 17/17、team 32/32、features 52。
- skip git：write 档能直接改 `.git/config` 和 `.gitattributes`，`git status`/`git diff` 会跑 `core.fsmonitor`、`diff.external`、textconv 指向的程序，等于绕过 exec 审批。宁可让 git 继续弹卡。
- skip rg、find、sed、awk：分别能经 `--pre`、`-exec`、`e` 命令、`system()` 起程序。
- 没在真 OMP 上跑：沙箱没装 omp。风险是老版本 OMP 不认 `bash.patterns`，那样只是不生效，不会放宽。

# C 持久运行与事件账本

Status: ready-for-human
Implementation: verified-local
Owner: LedgerOwner

## Scope

以 ../spec.md 和 ../contract.md 为实施契约，所有者仅改分配文件。原生OMP优先，禁止第二执行引擎。

## Acceptance

SQLite重启恢复、原子锁、readonly不变更、单调seq、usage差值与未知效果对账。

## Evidence

主代理 Ledger 10/10，实际多进程锁竞争、只读、迁移、重启、事件与用量检查通过。详见 ../../../docs/research/2026-10-12-implementation-verification.md。

## Comments

用户授权逐项实施，主代理统一验收；外部账号/证书/基础设施缺失不得假成功。

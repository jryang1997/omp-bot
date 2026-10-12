# A/B/D 原生运行、取消和审批

Status: ready-for-human
Implementation: verified-local
Owner: CoreOwner、RpcNativeOwner

## Scope

以 ../spec.md 和 ../contract.md 为实施契约，所有者仅改分配文件。原生OMP优先，禁止第二执行引擎。

## Acceptance

真实原生回合增量、拒绝/批准、慢工具取消、scope重用与跨Bot取消，状态由OMP settled确认。

## Evidence

主代理真实 OMP 验收增量、Deny/Approve、CLI 跨进程停止实际工具、停止后 scope 复用；RPC 30/30，Run 39/39。详见 ../../../docs/research/2026-10-12-implementation-verification.md。

## Comments

用户授权逐项实施，主代理统一验收；外部账号/证书/基础设施缺失不得假成功。

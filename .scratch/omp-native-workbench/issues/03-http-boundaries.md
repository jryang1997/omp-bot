# A HTTP边界与SSE重连

Status: ready-for-human
Implementation: verified-local
Owner: ApiOwner

## Scope

以 ../spec.md 和 ../contract.md 为实施契约，所有者仅改分配文件。原生OMP优先，禁止第二执行引擎。

## Acceptance

无认证/错误Origin/Host/Content-Type被拒，cookie bootstrap与SSE重放正常，旧CLI/API复用新run。

## Evidence

主代理 HTTP 边界 83/83、GUI API 55/55、实际浏览器 Cookie 与 SSE 通路通过。详见 ../../../docs/research/2026-10-12-implementation-verification.md。

## Comments

用户授权逐项实施，主代理统一验收；外部账号/证书/基础设施缺失不得假成功。

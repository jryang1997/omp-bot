# H 设备配对和飞书通道

Status: needs-info
Implementation: verified-local-with-external-prerequisites
Owner: DeviceChannelOwner

## Scope

以 ../spec.md 和 ../contract.md 为实施契约，所有者仅改分配文件。原生OMP优先，禁止第二执行引擎。

## Acceptance

一用码/过期/撤销/权限scope通过；飞书签名与去重有效，缺真实应用账号明确标注。

## Evidence

Channels 25/25、本地回调、原生审批载荷、去重、中断可见性通过。HTTP 设备范围/撤销/旧凭证失效通过。缺真实飞书账号、公网 HTTPS 回调、手机与远端网络入口。详见 ../../../docs/research/2026-10-12-implementation-verification.md。

## Comments

用户授权逐项实施，主代理统一验收；外部账号/证书/基础设施缺失不得假成功。
